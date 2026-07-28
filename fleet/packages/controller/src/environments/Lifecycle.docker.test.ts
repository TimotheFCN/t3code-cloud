import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { AgentConfig } from "@t3fleet/agent/Config";
import * as Connection from "@t3fleet/agent/Connection";
import { CredentialStore } from "@t3fleet/agent/CredentialStore";
import * as DockerDriver from "@t3fleet/agent/driver/DockerDriver";
import { ExecEnvironmentPayload } from "@t3fleet/shared/protocol";
import type { NodeSummary } from "@t3fleet/shared/node";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";

import { ControllerConfig, type ControllerConfigShape } from "../Config.ts";
import * as Controller from "../Controller.ts";
import * as Database from "../db/Database.ts";
import { Images } from "../images/Images.ts";
import { AgentConnections } from "../nodes/AgentConnections.ts";
import { JoinTokens } from "../nodes/JoinTokens.ts";
import { NodeRegistry } from "../nodes/NodeRegistry.ts";
import { Vault } from "../vault/Vault.ts";
import { Environments } from "./Environments.ts";
import { EnvironmentsRepo } from "./EnvironmentsRepo.ts";
import { PairingLinks } from "./PairingLinks.ts";
import { StatusPoller } from "./StatusPoller.ts";

/**
 * The phase-3 integration test: a real controller, a real agent with the
 * real docker driver, and a real `t3` binary (from npm) inside a container
 * built from the real entrypoint — driving create → status → pairing link →
 * destroy, with two environments for the same repo proving independence.
 *
 * Skipped without a local Docker daemon, like `DockerDriver.test.ts`. Uses
 * runtime `runc` (no sysbox on dev machines/CI); the inner dockerd is
 * skipped via `T3ENV_SKIP_DOCKERD=1` baked into the test image.
 */
const dockerAvailable = (() => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const TEST_IMAGE = "t3fleet-lifecycle-test:0.0.29";
const T3_VERSION = "0.0.29";
const entrypointPath = fileURLToPath(new URL("../../../../image/entrypoint.sh", import.meta.url));

// The real t3env image takes minutes to build; this slim variant carries
// exactly what phase 3 exercises: node, git, the pinned `t3` npm package,
// and the real entrypoint. node-pty (a t3 dependency) compiles natively, so
// python3/make/g++ are required just like in the full image.
const TEST_IMAGE_DOCKERFILE = `
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \\
    bash ca-certificates git python3 make g++ \\
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g --no-fund --no-audit t3@${T3_VERSION} && npm cache clean --force
COPY entrypoint.sh /usr/local/bin/t3env-entrypoint
RUN chmod 0755 /usr/local/bin/t3env-entrypoint
ENV T3CODE_HOST=0.0.0.0 \\
    T3CODE_PORT=3773 \\
    T3CODE_HOME=/root/.t3 \\
    T3CODE_NO_BROWSER=1 \\
    T3ENV_SKIP_DOCKERD=1
WORKDIR /root
ENTRYPOINT ["/usr/local/bin/t3env-entrypoint"]
`;

const docker = (args: ReadonlyArray<string>) =>
  execFileSync("docker", [...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });

const git = (cwd: string, args: ReadonlyArray<string>) =>
  execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });

let workDir = "";
let gitServer: Server | null = null;
let gitUrl = "";

/** Serves a bare repo over git's dumb HTTP protocol (static files). */
const serveBareRepo = (bareDir: string, host: string): Promise<{ url: string; server: Server }> =>
  new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const requested = (req.url ?? "").replace(/^\/repo\.git/, "").split("?")[0]!;
      const filePath = NodePath.join(bareDir, NodePath.normalize(requested));
      if (!filePath.startsWith(bareDir)) {
        res.writeHead(403);
        return res.end();
      }
      NodeFs.readFile(filePath).then(
        (contents) => {
          res.writeHead(200, { "content-type": "application/octet-stream" });
          res.end(contents);
        },
        () => {
          res.writeHead(404);
          res.end();
        },
      );
    });
    server.on("error", reject);
    server.listen(0, "0.0.0.0", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        return reject(new Error("expected tcp address"));
      }
      resolve({ url: `http://${host}:${address.port}/repo.git`, server });
    });
  });

const makeConfig = (dataDir: string): ControllerConfigShape => ({
  host: "127.0.0.1",
  port: 0,
  dataDir,
  heartbeatIntervalMillis: 1000,
  joinTokenTtlSeconds: 900,
  statusPollIntervalMillis: 60_000,
  // First boot inside the container runs T3 migrations + project add.
  environmentHealthTimeoutMillis: 120_000,
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

const runAgent = (input: { readonly stateDir: string; readonly joinToken?: string }) =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address;
    if (address._tag !== "TcpAddress") {
      return yield* Effect.die("expected a tcp address");
    }
    const agentLayer = Layer.mergeAll(
      CredentialStore.layer,
      DockerDriver.layer,
      NodeSocket.layerWebSocketConstructor,
    ).pipe(
      Layer.provideMerge(
        AgentConfig.layer({
          controllerUrl: `ws://127.0.0.1:${address.port}`,
          nodeName: "docker-lifecycle-node",
          stateDir: input.stateDir,
          joinToken:
            input.joinToken === undefined
              ? Option.none()
              : Option.some(Redacted.make(input.joinToken)),
          advertiseHost: Option.some("127.0.0.1"),
          dockerRuntime: "runc",
          snapshotRetention: 2,
          helperImage: "alpine:3.22",
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );
    return yield* Effect.forkScoped(Connection.run.pipe(Effect.provide(agentLayer)));
  });

const awaitConnectedNode = Effect.gen(function* () {
  const registry = yield* NodeRegistry;
  const nodes = yield* registry.list.pipe(
    Effect.repeat({
      until: (all: ReadonlyArray<NodeSummary>) => all.length === 1 && all[0]!.connected,
      schedule: Schedule.spaced("50 millis"),
    }),
    Effect.timeout("15 seconds"),
    Effect.orDie,
  );
  return nodes[0]!;
});

const awaitStep = (id: string, step: string, timeout: Duration.Input) =>
  Effect.gen(function* () {
    const environments = yield* Environments;
    return yield* environments.get(id).pipe(
      Effect.orDie,
      Effect.repeat({
        until: (summary) => summary.createStep === step || summary.observedState === "error",
        schedule: Schedule.spaced("500 millis"),
      }),
      Effect.timeout(timeout),
      Effect.orDie,
    );
  });

const decodeExec = Schema.decodeUnknownEffect(ExecEnvironmentPayload);

const execIn = (nodeId: string, environmentId: string, command: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const connections = yield* AgentConnections;
    const payload = yield* connections
      .request(
        nodeId,
        { type: "exec-environment", payload: { environmentId, command } },
        { timeout: "1 minute" },
      )
      .pipe(Effect.orDie);
    return yield* decodeExec(payload).pipe(Effect.orDie);
  });

describe.skipIf(!dockerAvailable)("environment lifecycle (real Docker + real t3)", () => {
  beforeAll(async () => {
    workDir = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "fleet-lifecycle-docker-"));

    // Build the slim t3 image with the real entrypoint (cached after the
    // first run; the first build compiles node-pty and takes a few minutes).
    const buildDir = NodePath.join(workDir, "image");
    await NodeFs.mkdir(buildDir, { recursive: true });
    await NodeFs.writeFile(NodePath.join(buildDir, "Dockerfile"), TEST_IMAGE_DOCKERFILE);
    await NodeFs.copyFile(entrypointPath, NodePath.join(buildDir, "entrypoint.sh"));
    execFileSync("docker", ["build", "-t", TEST_IMAGE, buildDir], { stdio: "ignore" });

    // A source repo with one commit and a setup hook that leaves a marker on
    // the volume, served to containers over git's dumb HTTP protocol.
    const sourceDir = NodePath.join(workDir, "source");
    await NodeFs.mkdir(NodePath.join(sourceDir, ".t3env"), { recursive: true });
    await NodeFs.writeFile(NodePath.join(sourceDir, "README.md"), "# fleet lifecycle test\n");
    await NodeFs.writeFile(
      NodePath.join(sourceDir, ".t3env", "setup.sh"),
      "#!/bin/sh\necho ran > /root/.t3env-setup-marker\n",
      { mode: 0o755 },
    );
    git(sourceDir, ["init", "--initial-branch=main"]);
    git(sourceDir, ["config", "user.email", "fleet-test@example.com"]);
    git(sourceDir, ["config", "user.name", "Fleet Test"]);
    git(sourceDir, ["add", "-A"]);
    git(sourceDir, ["commit", "-m", "initial"]);

    const bareDir = NodePath.join(workDir, "repo.git");
    git(workDir, ["clone", "--bare", sourceDir, bareDir]);
    git(bareDir, ["update-server-info"]);

    // Containers on the default bridge reach the host at the bridge gateway.
    const gateway = docker([
      "network",
      "inspect",
      "bridge",
      "--format",
      "{{(index .IPAM.Config 0).Gateway}}",
    ]).trim();
    const served = await serveBareRepo(bareDir, gateway);
    gitServer = served.server;
    gitUrl = served.url;
  }, 900_000);

  afterAll(async () => {
    gitServer?.close();
    gitServer?.closeAllConnections();
    // Belt and braces: the test destroys its environments; sweep leftovers.
    try {
      const ids = docker([
        "ps",
        "-aq",
        "--filter",
        "label=t3fleet.managed=true",
        "--filter",
        `ancestor=${TEST_IMAGE}`,
      ])
        .split("\n")
        .filter((line) => line.trim().length > 0);
      for (const id of ids) {
        execFileSync("docker", ["rm", "-f", id], { stdio: "ignore" });
      }
    } catch {
      // nothing to sweep
    }
    if (workDir !== "") {
      await NodeFs.rm(workDir, { recursive: true, force: true });
    }
  });

  it.live(
    "create → status → pairing link → destroy, twice over, fully independent",
    () =>
      Effect.gen(function* () {
        const dataDir = yield* Effect.promise(() =>
          NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "fleet-lifecycle-ctrl-")),
        );
        yield* Effect.gen(function* () {
          const joinTokens = yield* JoinTokens;
          const minted = yield* joinTokens.mint();
          const stateDir = yield* Effect.promise(() =>
            NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "fleet-lifecycle-agent-")),
          );
          yield* runAgent({ stateDir, joinToken: Redacted.value(minted.token) });
          const node = yield* awaitConnectedNode;

          const images = yield* Images;
          yield* images.register({ reference: TEST_IMAGE });

          // --- create two environments for the same repo -----------------
          const environments = yield* Environments;
          const envA = yield* environments.create({ gitUrl, gitBranch: "main" });
          const envB = yield* environments.create({ gitUrl });

          const readyA = yield* awaitStep(envA.id, "ready", "5 minutes");
          const readyB = yield* awaitStep(envB.id, "ready", "5 minutes");
          expect(readyA.error).toBeNull();
          expect(readyB.error).toBeNull();
          expect(readyA.observedState).toBe("running");
          expect(readyA.endpointUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
          expect(readyB.endpointUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
          expect(readyA.endpointUrl).not.toBe(readyB.endpointUrl);
          // Real T3 server identity, straight from the descriptor endpoint.
          expect(readyA.t3EnvironmentId).toBeTruthy();
          expect(readyB.t3EnvironmentId).toBeTruthy();
          expect(readyA.t3EnvironmentId).not.toBe(readyB.t3EnvironmentId);

          // The entrypoint ran the whole bootstrap: clone + setup hook.
          const marker = yield* execIn(node.id, envA.id, ["cat", "/root/.t3env-setup-marker"]);
          expect(marker.exitCode).toBe(0);
          expect(marker.stdout.trim()).toBe("ran");
          const clone = yield* execIn(node.id, envA.id, ["cat", "/root/workspace/README.md"]);
          expect(clone.stdout).toContain("fleet lifecycle test");

          // The project is registered: the real orchestration snapshot
          // (fetched with the vault-stored admin session) lists it.
          const repo = yield* EnvironmentsRepo;
          const vault = yield* Vault;
          const rowA = yield* repo.get(envA.id);
          const tokenA = yield* vault.read(rowA.t3SessionRef!);
          const snapshotResponse = yield* Effect.promise(() =>
            fetch(`${readyA.endpointUrl}/api/orchestration/snapshot`, {
              headers: { authorization: `Bearer ${Redacted.value(tokenA)}` },
            }),
          );
          expect(snapshotResponse.status).toBe(200);
          const snapshot = (yield* Effect.promise(() => snapshotResponse.json())) as {
            projects: Array<{ workspaceRoot: string }>;
          };
          expect(snapshot.projects).toHaveLength(1);
          expect(snapshot.projects[0]!.workspaceRoot).toBe("/root/workspace");

          // Status polling against the real server.
          const poller = yield* StatusPoller;
          yield* poller.pollOnce;
          const polledA = yield* environments.get(envA.id);
          expect(polledA.observedState).toBe("running");
          expect(polledA.activity).toMatchObject({ threadCount: 0, runningTurnCount: 0 });

          // Pairing links minted over HTTP with the stored admin session.
          const pairingLinks = yield* PairingLinks;
          const linkA = yield* pairingLinks.mint(envA.id);
          const linkB = yield* pairingLinks.mint(envB.id);
          expect(linkA.url).toMatch(
            new RegExp(`^${readyA.endpointUrl!.replaceAll(".", "\\.")}/pair#token=.+$`),
          );
          expect(linkB.url).toMatch(/\/pair#token=.+$/);
          expect(linkA.url).not.toBe(linkB.url);
          // The pair URL serves the T3 web app (browser flow is manual).
          const pairPage = yield* Effect.promise(() => fetch(new URL(linkA.url).origin + "/pair"));
          expect(pairPage.status).toBe(200);
          expect(pairPage.headers.get("content-type")).toContain("text/html");

          // --- independence: same repo, disjoint workspaces/volumes ------
          yield* execIn(node.id, envA.id, [
            "sh",
            "-c",
            "echo only-in-a > /root/workspace/only-in-a.txt",
          ]);
          const isolated = yield* execIn(node.id, envB.id, [
            "cat",
            "/root/workspace/only-in-a.txt",
          ]);
          expect(isolated.exitCode).not.toBe(0);

          // --- destroy both, one with a final-work archive ----------------
          yield* environments.destroy(envA.id, { archive: true });
          yield* environments.awaitRunner(envA.id);
          yield* environments.destroy(envB.id);
          yield* environments.awaitRunner(envB.id);

          const goneA = yield* environments.get(envA.id);
          const goneB = yield* environments.get(envB.id);
          expect(goneA.observedState).toBe("destroyed");
          expect(goneB.observedState).toBe("destroyed");

          // Nothing remains on the node: no containers, no volumes.
          for (const id of [envA.id, envB.id]) {
            const containers = docker([
              "ps",
              "-aq",
              "--filter",
              `label=t3fleet.environment-id=${id}`,
            ]).trim();
            expect(containers).toBe("");
            const volumes = docker([
              "volume",
              "ls",
              "-q",
              "--filter",
              `label=t3fleet.environment-id=${id}`,
            ]).trim();
            expect(volumes).toBe("");
          }

          // The uncommitted change in A was archived into controller storage.
          const archives = yield* Effect.promise(() =>
            NodeFs.readdir(NodePath.join(dataDir, "archives")),
          );
          expect(archives.some((name) => name.startsWith(`${envA.id}-`))).toBe(true);

          // The admin sessions are gone from the vault.
          const missing = yield* vault.read(rowA.t3SessionRef!).pipe(Effect.flip);
          expect(missing).toMatchObject({ _tag: "SecretNotFoundError" });
        }).pipe(Effect.scoped, Effect.provide(controllerLayer(dataDir)));
      }).pipe(Effect.scoped),
    600_000,
  );
});
