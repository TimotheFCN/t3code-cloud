import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ControllerConfig, defaults } from "../Config.ts";
import * as Database from "../db/Database.ts";
import { Events } from "../events/Events.ts";
import { JoinTokens } from "./JoinTokens.ts";
import { NodeRegistry } from "./NodeRegistry.ts";

const TestLayer = NodeRegistry.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(JoinTokens.layer, Events.layer)),
  Layer.provideMerge(Database.layerMemory),
  Layer.provideMerge(ControllerConfig.layer(defaults)),
);

const capacity = {
  cpuCount: 4,
  loadAverage1m: 0.5,
  memoryTotalBytes: 16e9,
  memoryFreeBytes: 8e9,
  diskTotalBytes: 1e12,
  diskFreeBytes: 4e11,
};

const register = Effect.gen(function* () {
  const registry = yield* NodeRegistry;
  const joinTokens = yield* JoinTokens;
  const minted = yield* joinTokens.mint();
  return yield* registry.registerWithToken({
    token: Redacted.value(minted.token),
    nodeName: "test-node",
    protocolVersion: 1,
  });
});

describe("NodeRegistry", () => {
  it.effect("registers a node through a join token and consumes the token", () =>
    Effect.gen(function* () {
      const registry = yield* NodeRegistry;
      const joinTokens = yield* JoinTokens;
      const minted = yield* joinTokens.mint();
      const token = Redacted.value(minted.token);

      const joined = yield* registry.registerWithToken({
        token,
        nodeName: "test-node",
        protocolVersion: 1,
      });
      expect(joined.nodeId).toMatch(/^node-/);

      // The token is single-use: a second registration with it must fail.
      const reuse = yield* registry
        .registerWithToken({ token, nodeName: "other", protocolVersion: 1 })
        .pipe(Effect.flip);
      expect(reuse._tag).toBe("InvalidJoinTokenError");

      const nodes = yield* registry.list;
      expect(nodes).toHaveLength(1);
      expect(nodes[0]!.name).toBe("test-node");

      const events = yield* Events;
      const log = yield* events.list;
      expect(
        log.some((event) => event.kind === "node-joined" && event.nodeId === joined.nodeId),
      ).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("authenticates the issued credential and rejects bad ones", () =>
    Effect.gen(function* () {
      const registry = yield* NodeRegistry;
      const joined = yield* register;

      yield* registry.authenticate({
        nodeId: joined.nodeId,
        credential: Redacted.value(joined.credential),
      });

      const badCredential = yield* registry
        .authenticate({ nodeId: joined.nodeId, credential: "fnc_wrong" })
        .pipe(Effect.flip);
      expect(badCredential._tag).toBe("InvalidCredentialError");

      const badNode = yield* registry
        .authenticate({ nodeId: "node-unknown", credential: Redacted.value(joined.credential) })
        .pipe(Effect.flip);
      expect(badNode._tag).toBe("InvalidCredentialError");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("stores only the credential hash", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const joined = yield* register;
      const rows = yield* sql<{ credential_hash: string }>`SELECT credential_hash FROM nodes`;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.credential_hash).not.toContain(Redacted.value(joined.credential));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("persists heartbeats and derives health", () =>
    Effect.gen(function* () {
      const registry = yield* NodeRegistry;
      const joined = yield* register;

      yield* registry.recordHeartbeat({ nodeId: joined.nodeId, capacity });

      const nodes = yield* registry.list;
      expect(nodes[0]!.capacity).toEqual(capacity);
      expect(nodes[0]!.lastSeenAtMillis).not.toBeNull();
      expect(nodes[0]!.health).toBe("online");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("reports offline when heartbeats stop", () =>
    Effect.gen(function* () {
      const registry = yield* NodeRegistry;
      const sql = yield* SqlClient.SqlClient;
      const joined = yield* register;

      // Backdate the last heartbeat past the online window (3x interval).
      const staleness = defaults.heartbeatIntervalMillis * 3 + 1;
      yield* sql`UPDATE nodes SET last_seen_at = ${-staleness} WHERE id = ${joined.nodeId}`;

      const nodes = yield* registry.list;
      expect(nodes[0]!.health).toBe("offline");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("tracks live connections", () =>
    Effect.gen(function* () {
      const registry = yield* NodeRegistry;
      const joined = yield* register;

      yield* registry.markConnected(joined.nodeId);
      expect((yield* registry.list)[0]!.connected).toBe(true);

      yield* registry.markDisconnected(joined.nodeId);
      expect((yield* registry.list)[0]!.connected).toBe(false);
    }).pipe(Effect.provide(TestLayer)),
  );
});
