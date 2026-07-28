import { createServer, type Server } from "node:http";
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { describe, expect, it } from "@effect/vitest";
import { AgentConfig, defaults as agentDefaults } from "@t3fleet/agent/Config";
import * as Connection from "@t3fleet/agent/Connection";
import { CredentialStore } from "@t3fleet/agent/CredentialStore";
import { Driver } from "@t3fleet/agent/driver/Driver";
import * as FakeDriver from "@t3fleet/agent/driver/FakeDriver";
import type { CreateEnvironmentSpec, ExecResult } from "@t3fleet/shared/environment";
import type { NodeSummary } from "@t3fleet/shared/node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";

import { ControllerConfig, type ControllerConfigShape } from "../Config.ts";
import * as Controller from "../Controller.ts";
import * as Database from "../db/Database.ts";
import { Events } from "../events/Events.ts";
import { Images } from "../images/Images.ts";
import { AgentConnections } from "../nodes/AgentConnections.ts";
import { JoinTokens } from "../nodes/JoinTokens.ts";
import { NodeRegistry } from "../nodes/NodeRegistry.ts";
import { Vault } from "../vault/Vault.ts";
import { Environments } from "./Environments.ts";
import { EnvironmentsRepo } from "./EnvironmentsRepo.ts";
import { PairingLinks } from "./PairingLinks.ts";
import { StatusPoller } from "./StatusPoller.ts";

// --- a fake T3 server + fake `t3 auth` CLI backing every test environment ---

interface FakeT3 {
  readonly port: number;
  /** authorization headers seen by POST /api/auth/pairing-token */
  readonly pairingAuths: Array<string | undefined>;
  /** authorization headers seen by POST /api/auth/clients/revoke */
  readonly revokeAuths: Array<string | undefined>;
  /** bearer tokens the fake server accepts (issued by the fake CLI) */
  readonly validTokens: Set<string>;
  /** sessions the fake CLI issued, by environment id */
  readonly issuedSessions: Map<string, Array<{ sessionId: string; token: string }>>;
  /** emulates `docker exec` of the `t3` CLI inside the environment */
  readonly exec: (environmentId: string, command: ReadonlyArray<string>) => ExecResult | undefined;
  readonly createdSpecs: Array<CreateEnvironmentSpec>;
}

const PAIRING_CREDENTIAL = "pc_one_time_pairing_credential";

const startFakeT3 = Effect.gen(function* () {
  const validTokens = new Set<string>();
  const issuedSessions = new Map<string, Array<{ sessionId: string; token: string }>>();
  const pairingAuths: Array<string | undefined> = [];
  const revokeAuths: Array<string | undefined> = [];
  const createdSpecs: Array<CreateEnvironmentSpec> = [];
  let counter = 0;

  const server: Server = createServer((req, res) => {
    const auth = req.headers.authorization;
    const authorized = auth !== undefined && validTokens.has(auth.replace(/^Bearer /, ""));
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/.well-known/t3/environment") {
      return json(200, {
        environmentId: "t3env-fake",
        label: "fake environment",
        platform: "linux",
        serverVersion: "0.0.29",
        capabilities: {},
      });
    }
    if (req.method === "GET" && req.url === "/api/orchestration/snapshot") {
      if (!authorized) {
        return json(401, { code: "unauthorized" });
      }
      return json(200, {
        snapshotSequence: 1,
        projects: [],
        threads: [
          {
            id: "thread-1",
            updatedAt: "2026-07-28T12:00:00.000Z",
            latestTurn: { state: "running" },
          },
        ],
        updatedAt: "2026-07-28T12:00:01.000Z",
      });
    }
    if (req.method === "POST" && req.url === "/api/auth/pairing-token") {
      pairingAuths.push(auth);
      if (!authorized) {
        return json(401, { code: "unauthorized" });
      }
      return json(200, {
        id: "pairing-1",
        credential: PAIRING_CREDENTIAL,
        expiresAt: "2026-07-28T13:00:00.000Z",
      });
    }
    if (req.method === "POST" && req.url === "/api/auth/clients/revoke") {
      revokeAuths.push(auth);
      if (!authorized) {
        return json(401, { code: "unauthorized" });
      }
      return json(200, { revoked: true });
    }
    return json(404, { code: "not-found" });
  });

  yield* Effect.acquireRelease(
    Effect.callback<void>((resume) => {
      server.listen(0, "127.0.0.1", () => resume(Effect.void));
    }),
    () =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string") {
    return yield* Effect.die("expected a tcp address");
  }

  const exec = (environmentId: string, command: ReadonlyArray<string>) => {
    const sessions = issuedSessions.get(environmentId) ?? [];
    if (command[0] === "t3" && command[2] === "session" && command[3] === "list") {
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          sessions.map((session) => ({
            sessionId: session.sessionId,
            client: { label: "fleet-controller" },
          })),
        ),
        stderr: "",
      };
    }
    if (command[0] === "t3" && command[2] === "session" && command[3] === "revoke") {
      const remaining = sessions.filter((session) => session.sessionId !== command[4]);
      for (const session of sessions) {
        if (session.sessionId === command[4]) {
          validTokens.delete(session.token);
        }
      }
      issuedSessions.set(environmentId, remaining);
      return { exitCode: 0, stdout: `Revoked session ${command[4]}.`, stderr: "" };
    }
    if (command[0] === "t3" && command[2] === "session" && command[3] === "issue") {
      counter += 1;
      const session = {
        sessionId: `sess-${environmentId}-${counter}`,
        token: `fst_${environmentId}_${counter}_bearer_token`,
      };
      issuedSessions.set(environmentId, [...sessions, session]);
      validTokens.add(session.token);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          sessionId: session.sessionId,
          token: session.token,
          method: "bearer-access-token",
          scopes: ["orchestration:read", "access:write"],
          subject: "cli-issued-session",
          client: { label: "fleet-controller" },
          expiresAt: "2027-07-28T12:00:00.000Z",
        }),
        stderr: "",
      };
    }
    if (command[0] === "sh") {
      return {
        exitCode: 0,
        stdout: "diff --git a/notes.txt b/notes.txt\n+uncommitted work\n",
        stderr: "",
      };
    }
    return undefined;
  };

  return {
    port: address.port,
    pairingAuths,
    revokeAuths,
    validTokens,
    issuedSessions,
    exec,
    createdSpecs,
  } satisfies FakeT3;
});

// --- an in-process controller + real agent around the fake T3 ---------------

const makeConfig = (dataDir: string): ControllerConfigShape => ({
  host: "127.0.0.1",
  port: 0,
  dataDir,
  heartbeatIntervalMillis: 100,
  joinTokenTtlSeconds: 900,
  // The background poll stays out of the way; tests trigger pollOnce.
  statusPollIntervalMillis: 60_000,
  environmentHealthTimeoutMillis: 10_000,
});

const controllerLayer = (dataDir: string) =>
  HttpRouter.serve(Controller.Routes, { disableListenLog: true }).pipe(
    Layer.provideMerge(Controller.Services),
    Layer.provideMerge(Database.layer({ filename: NodePath.join(dataDir, "controller.sqlite") })),
    Layer.provideMerge(
      NodeHttpServer.layer(createServer, {
        port: 0,
        host: "127.0.0.1",
        gracefulShutdownTimeout: "250 millis",
      }),
    ),
    Layer.provideMerge(ControllerConfig.layer(makeConfig(dataDir))),
    Layer.provideMerge(NodeSocket.layerWebSocketConstructor),
  );

const tempDir = (prefix: string) =>
  Effect.promise(() => NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), prefix)));

/** Runs the real agent (shared driver service) against the test controller. */
const runAgent = (input: {
  readonly stateDir: string;
  readonly joinToken?: string;
  readonly driver: Driver["Service"];
}) =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address;
    if (address._tag !== "TcpAddress") {
      return yield* Effect.die("expected a tcp address");
    }
    const agentLayer = Layer.mergeAll(
      CredentialStore.layer,
      Layer.succeed(Driver)(input.driver),
      NodeSocket.layerWebSocketConstructor,
    ).pipe(
      Layer.provideMerge(
        AgentConfig.layer({
          controllerUrl: `ws://127.0.0.1:${address.port}`,
          nodeName: "lifecycle-node",
          stateDir: input.stateDir,
          joinToken:
            input.joinToken === undefined
              ? Option.none()
              : Option.some(Redacted.make(input.joinToken)),
          advertiseHost: Option.some("127.0.0.1"),
          dockerRuntime: agentDefaults.dockerRuntime,
          snapshotRetention: agentDefaults.snapshotRetention,
          helperImage: agentDefaults.helperImage,
        }),
      ),
    );
    return yield* Effect.forkScoped(Connection.run.pipe(Effect.provide(agentLayer)));
  });

const awaitConnectedNode = Effect.gen(function* () {
  const registry = yield* NodeRegistry;
  const nodes = yield* registry.list.pipe(
    Effect.repeat({
      until: (all: ReadonlyArray<NodeSummary>) => all.length === 1 && all[0]!.connected,
      schedule: Schedule.spaced("25 millis"),
    }),
    Effect.timeout("10 seconds"),
    Effect.orDie,
  );
  return nodes[0]!;
});

const awaitEnvironment = (
  id: string,
  predicate: (summary: { readonly createStep: string; readonly observedState: string }) => boolean,
) =>
  Effect.gen(function* () {
    const environments = yield* Environments;
    return yield* environments
      .get(id)
      .pipe(
        Effect.orDie,
        Effect.repeat({ until: predicate, schedule: Schedule.spaced("25 millis") }),
        Effect.timeout("15 seconds"),
        Effect.orDie,
      );
  });

const registerImage = Effect.gen(function* () {
  const images = yield* Images;
  yield* images.register({ reference: "t3env:test" });
});

/** Joins the agent and creates one environment, waiting until it is ready. */
const createReadyEnvironment = (fakeT3: FakeT3, stateDir: string) =>
  Effect.gen(function* () {
    const joinTokens = yield* JoinTokens;
    const minted = yield* joinTokens.mint();
    const driver = FakeDriver.makeService({
      resolveHostPort: () => fakeT3.port,
      exec: fakeT3.exec,
      onCreate: (spec) => fakeT3.createdSpecs.push(spec),
    });
    yield* runAgent({ stateDir, joinToken: Redacted.value(minted.token), driver });
    yield* awaitConnectedNode;
    yield* registerImage;
    const environments = yield* Environments;
    const created = yield* environments.create({
      gitUrl: "https://example.com/acme/project.git",
      gitBranch: "main",
    });
    const ready = yield* awaitEnvironment(created.id, (summary) => summary.createStep === "ready");
    return { id: created.id, ready, driver };
  });

const readAllFiles = async (dir: string): Promise<Array<[string, Buffer]>> => {
  const out: Array<[string, Buffer]> = [];
  const entries = await NodeFs.readdir(dir, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (entry.isFile()) {
      const path = NodePath.join(entry.parentPath, entry.name);
      out.push([path, await NodeFs.readFile(path)]);
    }
  }
  return out;
};

describe("environment lifecycle (wire-level, fake driver + fake T3)", () => {
  it.live("creates an environment through the step machine and polls status", () =>
    Effect.gen(function* () {
      const fakeT3 = yield* startFakeT3;
      const dataDir = yield* tempDir("fleet-lifecycle-");
      const stateDir = yield* tempDir("fleet-agent-");

      yield* Effect.gen(function* () {
        const { id, ready } = yield* createReadyEnvironment(fakeT3, stateDir);

        expect(ready.desiredState).toBe("running");
        expect(ready.observedState).toBe("running");
        expect(ready.endpointUrl).toBe(`http://127.0.0.1:${fakeT3.port}`);
        expect(ready.t3EnvironmentId).toBe("t3env-fake");
        expect(ready.error).toBeNull();

        // The driver received the phase-3 create contract: git env vars and
        // the T3 port published to an ephemeral host port.
        expect(fakeT3.createdSpecs).toHaveLength(1);
        expect(fakeT3.createdSpecs[0]).toMatchObject({
          id,
          image: "t3env:test",
          env: {
            T3ENV_GIT_URL: "https://example.com/acme/project.git",
            T3ENV_GIT_BRANCH: "main",
          },
          publishPorts: [{ containerPort: 3773 }],
        });

        // Exactly one admin session was issued and its token is readable
        // through the vault ref stored on the row.
        expect(fakeT3.issuedSessions.get(id)).toHaveLength(1);
        const repo = yield* EnvironmentsRepo;
        const row = yield* repo.get(id);
        expect(row.t3SessionRef).toMatch(/^sec_/);
        expect(row.t3SessionId).toBe(fakeT3.issuedSessions.get(id)![0]!.sessionId);
        const vault = yield* Vault;
        const token = yield* vault.read(row.t3SessionRef!);
        expect(Redacted.value(token)).toBe(fakeT3.issuedSessions.get(id)![0]!.token);

        // Status polling records liveness + activity for phase 7.
        const poller = yield* StatusPoller;
        yield* poller.pollOnce;
        const polled = yield* (yield* Environments).get(id);
        expect(polled.observedState).toBe("running");
        expect(polled.activity).toEqual({
          threadCount: 1,
          runningTurnCount: 1,
          lastThreadUpdatedAt: "2026-07-28T12:00:00.000Z",
          snapshotUpdatedAt: "2026-07-28T12:00:01.000Z",
        });
        expect(polled.lastStatusAtMillis).not.toBeNull();
      }).pipe(Effect.scoped, Effect.provide(controllerLayer(dataDir)));

      // Security invariant: the bearer token never rests in plaintext — not
      // in the SQLite file, not in the secrets file, nowhere under dataDir.
      const files = yield* Effect.promise(() => readAllFiles(dataDir));
      const tokens = [...fakeT3.validTokens];
      expect(tokens.length).toBeGreaterThan(0);
      for (const [, contents] of files) {
        for (const token of tokens) {
          expect(contents.includes(token)).toBe(false);
        }
      }
    }).pipe(Effect.scoped),
  );

  it.live("mints pairing links via the stored session and never stores them", () =>
    Effect.gen(function* () {
      const fakeT3 = yield* startFakeT3;
      const dataDir = yield* tempDir("fleet-lifecycle-");
      const stateDir = yield* tempDir("fleet-agent-");

      yield* Effect.gen(function* () {
        const { id } = yield* createReadyEnvironment(fakeT3, stateDir);
        const pairingLinks = yield* PairingLinks;

        const link = yield* pairingLinks.mint(id);
        expect(link.url).toBe(`http://127.0.0.1:${fakeT3.port}/pair#token=${PAIRING_CREDENTIAL}`);
        expect(link.expiresAt).toBe("2026-07-28T13:00:00.000Z");

        // Authorization path: the environment saw exactly the vault-stored
        // admin bearer token.
        const issued = fakeT3.issuedSessions.get(id)![0]!;
        expect(fakeT3.pairingAuths).toEqual([`Bearer ${issued.token}`]);

        // The event log records the mint but never the credential.
        const events = yield* Events;
        const allEvents = yield* events.list;
        const mintEvents = allEvents.filter((event) => event.kind === "pairing-link-minted");
        expect(mintEvents).toHaveLength(1);
        expect(JSON.stringify(allEvents)).not.toContain(PAIRING_CREDENTIAL);

        // An environment whose session the server no longer accepts cannot
        // mint (401 → PairingMintError), and nothing is retried blindly.
        fakeT3.validTokens.clear();
        const failure = yield* pairingLinks.mint(id).pipe(Effect.flip);
        expect(failure).toMatchObject({ _tag: "PairingMintError", environmentId: id });
      }).pipe(Effect.scoped, Effect.provide(controllerLayer(dataDir)));

      // Never stored: the pairing credential appears in no controller file.
      const files = yield* Effect.promise(() => readAllFiles(dataDir));
      for (const [, contents] of files) {
        expect(contents.includes(PAIRING_CREDENTIAL)).toBe(false);
      }
    }).pipe(Effect.scoped),
  );

  it.live("destroys cleanly: archive, revoke, driver destroy, vault cleanup", () =>
    Effect.gen(function* () {
      const fakeT3 = yield* startFakeT3;
      const dataDir = yield* tempDir("fleet-lifecycle-");
      const stateDir = yield* tempDir("fleet-agent-");

      yield* Effect.gen(function* () {
        const { id, driver } = yield* createReadyEnvironment(fakeT3, stateDir);
        const repo = yield* EnvironmentsRepo;
        const sessionRef = (yield* repo.get(id)).t3SessionRef!;
        const issuedToken = fakeT3.issuedSessions.get(id)![0]!.token;

        const environments = yield* Environments;
        yield* environments.destroy(id, { archive: true });
        yield* environments.awaitRunner(id);

        const destroyed = yield* environments.get(id);
        expect(destroyed.desiredState).toBe("destroyed");
        expect(destroyed.observedState).toBe("destroyed");
        expect(destroyed.endpointUrl).toBeNull();

        // Nothing left on the node.
        expect(yield* driver.listEnvironments).toEqual([]);

        // The controller revoked its own session over HTTP before stopping.
        expect(fakeT3.revokeAuths).toEqual([`Bearer ${issuedToken}`]);

        // Vault ref is gone.
        const vault = yield* Vault;
        const missing = yield* vault.read(sessionRef).pipe(Effect.flip);
        expect(missing).toMatchObject({ _tag: "SecretNotFoundError" });

        // The final-work archive landed in controller storage as a gzipped
        // patch of the uncommitted diff.
        const archiveDir = NodePath.join(dataDir, "archives");
        const archives = yield* Effect.promise(() => NodeFs.readdir(archiveDir));
        expect(archives).toHaveLength(1);
        expect(archives[0]).toMatch(new RegExp(`^${id}-\\d+\\.patch\\.gz$`));
        const patch = NodeZlib.gunzipSync(
          yield* Effect.promise(() => NodeFs.readFile(NodePath.join(archiveDir, archives[0]!))),
        ).toString("utf8");
        expect(patch).toContain("+uncommitted work");
      }).pipe(Effect.scoped, Effect.provide(controllerLayer(dataDir)));
    }).pipe(Effect.scoped),
  );

  it.live("a restarted controller resumes an interrupted create and converges", () =>
    Effect.gen(function* () {
      const fakeT3 = yield* startFakeT3;
      const dataDir = yield* tempDir("fleet-lifecycle-");
      const stateDir = yield* tempDir("fleet-agent-");
      // One driver service across both incarnations — the node's containers
      // survive a controller restart.
      const driver = FakeDriver.makeService({
        resolveHostPort: () => fakeT3.port,
        exec: fakeT3.exec,
      });

      // Incarnation 1: the environment row exists, the container was created
      // on the node, the step `created` was persisted — then the controller
      // "crashes" (scope closes) before starting it.
      const crashedId = "env-crashtest";
      yield* Effect.gen(function* () {
        const joinTokens = yield* JoinTokens;
        const minted = yield* joinTokens.mint();
        yield* runAgent({ stateDir, joinToken: Redacted.value(minted.token), driver });
        const node = yield* awaitConnectedNode;
        yield* registerImage;

        const repo = yield* EnvironmentsRepo;
        yield* repo.insert({
          id: crashedId,
          name: crashedId,
          nodeId: node.id,
          gitUrl: "https://example.com/acme/project.git",
          gitBranch: null,
          imageReference: "t3env:test",
        });
        const connections = yield* AgentConnections;
        yield* connections.request(node.id, {
          type: "create-environment",
          payload: {
            id: crashedId,
            name: crashedId,
            image: "t3env:test",
            env: { T3ENV_GIT_URL: "https://example.com/acme/project.git" },
            publishPorts: [{ containerPort: 3773 }],
          },
        });
        yield* repo.setCreateStep(crashedId, "created");
      }).pipe(Effect.scoped, Effect.provide(controllerLayer(dataDir)));

      // Incarnation 2: same database, same agent credential, fresh processes.
      // Startup reconciliation must resume from `created` and reach `ready`.
      yield* Effect.gen(function* () {
        yield* runAgent({ stateDir, driver });
        yield* awaitConnectedNode;
        const ready = yield* awaitEnvironment(
          crashedId,
          (summary) => summary.createStep === "ready",
        );
        expect(ready.observedState).toBe("running");
        expect(ready.endpointUrl).toBe(`http://127.0.0.1:${fakeT3.port}`);
        // The stale-session sweep kept it to exactly one live session.
        expect(fakeT3.issuedSessions.get(crashedId)).toHaveLength(1);
        const repo = yield* EnvironmentsRepo;
        const row = yield* repo.get(crashedId);
        expect(row.t3SessionRef).toMatch(/^sec_/);
      }).pipe(Effect.scoped, Effect.provide(controllerLayer(dataDir)));
    }).pipe(Effect.scoped),
  );

  it.live("create fails cleanly when no image is registered", () =>
    Effect.gen(function* () {
      const dataDir = yield* tempDir("fleet-lifecycle-");
      yield* Effect.gen(function* () {
        const environments = yield* Environments;
        const failure = yield* environments
          .create({ gitUrl: "https://example.com/repo.git" })
          .pipe(Effect.flip);
        expect(failure).toMatchObject({ _tag: "NoCurrentImageError" });
      }).pipe(Effect.scoped, Effect.provide(controllerLayer(dataDir)));
    }).pipe(Effect.scoped),
  );

  it.live("create fails cleanly when no node is connected", () =>
    Effect.gen(function* () {
      const dataDir = yield* tempDir("fleet-lifecycle-");
      yield* Effect.gen(function* () {
        yield* registerImage;
        const environments = yield* Environments;
        const failure = yield* environments
          .create({ gitUrl: "https://example.com/repo.git" })
          .pipe(Effect.flip);
        expect(failure).toMatchObject({ _tag: "NoSchedulableNodeError" });
      }).pipe(Effect.scoped, Effect.provide(controllerLayer(dataDir)));
    }).pipe(Effect.scoped),
  );
});
