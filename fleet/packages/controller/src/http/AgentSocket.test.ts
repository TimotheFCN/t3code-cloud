import { createServer } from "node:http";
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { describe, expect, it } from "@effect/vitest";
import { AgentConfig } from "@t3fleet/agent/Config";
import * as Connection from "@t3fleet/agent/Connection";
import { CredentialStore } from "@t3fleet/agent/CredentialStore";
import * as FakeDriver from "@t3fleet/agent/driver/FakeDriver";
import type { NodeSummary } from "@t3fleet/shared/node";
import {
  AGENT_SOCKET_PATH,
  decodeControllerToAgent,
  encodeAgentToController,
  ListEnvironmentsPayload,
  PongPayload,
  PROTOCOL_VERSION,
} from "@t3fleet/shared/protocol";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as Socket from "effect/unstable/socket/Socket";

import { ControllerConfig, type ControllerConfigShape } from "../Config.ts";
import * as Controller from "../Controller.ts";
import * as Database from "../db/Database.ts";
import { AgentConnections } from "../nodes/AgentConnections.ts";
import { JoinTokens } from "../nodes/JoinTokens.ts";
import { NodeRegistry } from "../nodes/NodeRegistry.ts";

const testConfig: ControllerConfigShape = {
  host: "127.0.0.1",
  port: 0,
  dataDir: "unused-in-tests",
  heartbeatIntervalMillis: 100,
  joinTokenTtlSeconds: 900,
};

/** Full in-process controller on an ephemeral port with an in-memory DB. */
const ControllerTestLayer = HttpRouter.serve(Controller.Routes, { disableListenLog: true }).pipe(
  Layer.provideMerge(Controller.Services),
  Layer.provideMerge(Database.layerMemory),
  Layer.provideMerge(
    NodeHttpServer.layer(createServer, {
      port: 0,
      host: "127.0.0.1",
      gracefulShutdownTimeout: "250 millis",
    }),
  ),
  Layer.provideMerge(ControllerConfig.layer(testConfig)),
  Layer.provideMerge(NodeSocket.layerWebSocketConstructor),
);

const controllerOrigin = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer;
  const address = server.address;
  if (address._tag !== "TcpAddress") {
    return yield* Effect.die("expected a tcp address");
  }
  return `ws://127.0.0.1:${address.port}`;
});

const mintToken = Effect.gen(function* () {
  const joinTokens = yield* JoinTokens;
  const minted = yield* joinTokens.mint();
  return Redacted.value(minted.token);
});

const tempStateDir = Effect.promise(() =>
  NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "fleet-agent-test-")),
);

/** Runs the real agent against the in-process controller. */
const runAgent = (options: { readonly stateDir: string; readonly joinToken?: string }) =>
  Effect.gen(function* () {
    const origin = yield* controllerOrigin;
    const agentLayer = Layer.mergeAll(
      CredentialStore.layer,
      FakeDriver.layer,
      NodeSocket.layerWebSocketConstructor,
    ).pipe(
      Layer.provideMerge(
        AgentConfig.layer({
          controllerUrl: origin,
          nodeName: "integration-node",
          stateDir: options.stateDir,
          joinToken:
            options.joinToken === undefined
              ? Option.none()
              : Option.some(Redacted.make(options.joinToken)),
        }),
      ),
    );
    // Forked into the test scope: interrupted automatically at test end.
    return yield* Effect.forkScoped(Connection.run.pipe(Effect.provide(agentLayer)));
  });

const awaitNodes = (predicate: (nodes: ReadonlyArray<NodeSummary>) => boolean) =>
  Effect.gen(function* () {
    const registry = yield* NodeRegistry;
    return yield* registry.list.pipe(
      Effect.repeat({ until: predicate, schedule: Schedule.spaced("25 millis") }),
      Effect.timeout("10 seconds"),
      Effect.orDie,
    );
  });

/** Sends one raw frame and returns the controller's first reply. */
const sendRawHello = (frame: string) =>
  Effect.gen(function* () {
    const origin = yield* controllerOrigin;
    const socket = yield* Socket.makeWebSocket(`${origin}${AGENT_SOCKET_PATH}`);
    const write = yield* socket.writer;
    const reply = yield* Deferred.make<string>();
    yield* Effect.forkScoped(
      socket
        .runString((text) => Deferred.succeed(reply, text), { onOpen: Effect.orDie(write(frame)) })
        .pipe(Effect.ignore),
    );
    return yield* Deferred.await(reply).pipe(Effect.timeout("5 seconds"), Effect.orDie);
  }).pipe(Effect.scoped);

const helloFrame = (input: {
  readonly protocolVersion?: number;
  readonly auth:
    | { readonly method: "join-token"; readonly joinToken: string }
    | { readonly method: "credential"; readonly nodeId: string; readonly credential: string };
}) =>
  encodeAgentToController({
    kind: "hello",
    protocolVersion: input.protocolVersion ?? PROTOCOL_VERSION,
    nodeName: "raw-client",
    auth: input.auth,
  }).pipe(Effect.orDie);

const decodePong = Schema.decodeUnknownEffect(PongPayload);
const decodeEnvironments = Schema.decodeUnknownEffect(ListEnvironmentsPayload);

describe("agent <-> controller integration", () => {
  it.live("token join registers the node, heartbeats, and serves requests", () =>
    Effect.gen(function* () {
      const token = yield* mintToken;
      const stateDir = yield* tempStateDir;
      yield* runAgent({ stateDir, joinToken: token });

      const nodes = yield* awaitNodes(
        (all) => all.length === 1 && all[0]!.connected && all[0]!.capacity !== null,
      );
      const node = nodes[0]!;
      expect(node.name).toBe("integration-node");
      expect(node.health).toBe("online");
      expect(node.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(node.capacity!.cpuCount).toBeGreaterThan(0);
      expect(node.capacity!.memoryTotalBytes).toBeGreaterThan(0);

      // Credential file is the agent's only local state, mode 0600.
      const stat = yield* Effect.promise(() =>
        NodeFs.stat(NodePath.join(stateDir, "credential.json")),
      );
      expect(stat.mode & 0o777).toBe(0o600);

      // Correlation-id request/response over the live socket.
      const connections = yield* AgentConnections;
      const pong = yield* decodePong(yield* connections.request(node.id, "ping"));
      expect(pong.pong).toBe(true);

      const environments = yield* decodeEnvironments(
        yield* connections.request(node.id, "list-environments"),
      );
      expect(environments.environments).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(ControllerTestLayer)),
  );

  it.live("a restarted agent rejoins with its stored credential", () =>
    Effect.gen(function* () {
      const token = yield* mintToken;
      const stateDir = yield* tempStateDir;

      const first = yield* runAgent({ stateDir, joinToken: token });
      yield* awaitNodes((all) => all.length === 1 && all[0]!.connected);

      // Kill the agent; the controller notices the disconnect.
      yield* Fiber.interrupt(first);
      yield* awaitNodes((all) => all.length === 1 && !all[0]!.connected);

      // Restart without any join token: the stored credential must be enough,
      // and no second node may appear.
      yield* runAgent({ stateDir });
      const nodes = yield* awaitNodes((all) => all.length === 1 && all[0]!.connected);
      expect(nodes).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(ControllerTestLayer)),
  );

  it.live("rejects a protocol version mismatch", () =>
    Effect.gen(function* () {
      const token = yield* mintToken;
      const frame = yield* helloFrame({
        protocolVersion: 999,
        auth: { method: "join-token", joinToken: token },
      });
      const reply = yield* decodeControllerToAgent(yield* sendRawHello(frame));
      expect(reply).toMatchObject({ kind: "rejected", reason: "protocol-mismatch" });
    }).pipe(Effect.scoped, Effect.provide(ControllerTestLayer)),
  );

  it.live("rejects an unknown join token", () =>
    Effect.gen(function* () {
      const frame = yield* helloFrame({ auth: { method: "join-token", joinToken: "fjt_bogus" } });
      const reply = yield* decodeControllerToAgent(yield* sendRawHello(frame));
      expect(reply).toMatchObject({ kind: "rejected", reason: "invalid-token" });
    }).pipe(Effect.scoped, Effect.provide(ControllerTestLayer)),
  );

  it.live("enforces single-use join tokens over the wire", () =>
    Effect.gen(function* () {
      const token = yield* mintToken;
      const frame = yield* helloFrame({ auth: { method: "join-token", joinToken: token } });

      const firstReply = yield* decodeControllerToAgent(yield* sendRawHello(frame));
      expect(firstReply.kind).toBe("welcome");

      const secondReply = yield* decodeControllerToAgent(yield* sendRawHello(frame));
      expect(secondReply).toMatchObject({ kind: "rejected", reason: "invalid-token" });
    }).pipe(Effect.scoped, Effect.provide(ControllerTestLayer)),
  );

  it.live("rejects bad credentials", () =>
    Effect.gen(function* () {
      const token = yield* mintToken;
      const joinFrame = yield* helloFrame({ auth: { method: "join-token", joinToken: token } });
      const welcome = yield* decodeControllerToAgent(yield* sendRawHello(joinFrame));
      if (welcome.kind !== "welcome") {
        return yield* Effect.die("expected welcome");
      }

      const badFrame = yield* helloFrame({
        auth: { method: "credential", nodeId: welcome.nodeId, credential: "fnc_wrong" },
      });
      const reply = yield* decodeControllerToAgent(yield* sendRawHello(badFrame));
      expect(reply).toMatchObject({ kind: "rejected", reason: "invalid-credential" });
    }).pipe(Effect.scoped, Effect.provide(ControllerTestLayer)),
  );
});
