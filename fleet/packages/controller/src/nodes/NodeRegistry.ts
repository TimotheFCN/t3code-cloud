import * as NodeCrypto from "node:crypto";

import type { CapacitySnapshot } from "@t3fleet/shared/capacity";
import { CapacitySnapshot as CapacitySnapshotSchema } from "@t3fleet/shared/capacity";
import type { NodeSummary } from "@t3fleet/shared/node";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ControllerConfig } from "../Config.ts";
import { Events } from "../events/Events.ts";
import { hashSecret, InvalidJoinTokenError, JoinTokens } from "./JoinTokens.ts";

export class InvalidCredentialError extends Schema.TaggedErrorClass<InvalidCredentialError>()(
  "InvalidCredentialError",
  {
    nodeId: Schema.String,
  },
) {}

const encodeCapacity = Schema.encodeUnknownEffect(Schema.fromJsonString(CapacitySnapshotSchema));
const decodeCapacity = Schema.decodeUnknownEffect(Schema.fromJsonString(CapacitySnapshotSchema));

interface NodeRow {
  readonly id: string;
  readonly name: string;
  readonly protocol_version: number;
  readonly last_seen_at: number | null;
  readonly capacity_json: string | null;
  readonly created_at: number;
}

/**
 * Node inventory: registration through join tokens, credential verification
 * for reconnects, heartbeat persistence, and the derived health view served
 * by the HTTP API. Live connection state is observable via `connectedNodeIds`
 * (a `SubscriptionRef`, e.g. for the phase-6 dashboard).
 */
export class NodeRegistry extends Context.Service<
  NodeRegistry,
  {
    readonly registerWithToken: (input: {
      readonly token: string;
      readonly nodeName: string;
      readonly protocolVersion: number;
    }) => Effect.Effect<
      { readonly nodeId: string; readonly credential: Redacted.Redacted<string> },
      InvalidJoinTokenError
    >;
    readonly authenticate: (input: {
      readonly nodeId: string;
      readonly credential: string;
    }) => Effect.Effect<void, InvalidCredentialError>;
    readonly recordHeartbeat: (input: {
      readonly nodeId: string;
      readonly capacity: CapacitySnapshot;
    }) => Effect.Effect<void>;
    /**
     * Records the host this node's published container ports are reachable
     * at (agent-advertised or the connection's remote address). Phase-3
     * node-port seam; phase 4 replaces it with tailnet URLs.
     */
    readonly recordEndpointHost: (input: {
      readonly nodeId: string;
      readonly host: string;
    }) => Effect.Effect<void>;
    readonly endpointHost: (nodeId: string) => Effect.Effect<Option.Option<string>>;
    readonly markConnected: (nodeId: string) => Effect.Effect<void>;
    readonly markDisconnected: (nodeId: string) => Effect.Effect<void>;
    readonly connectedNodeIds: SubscriptionRef.SubscriptionRef<ReadonlySet<string>>;
    readonly list: Effect.Effect<ReadonlyArray<NodeSummary>>;
  }
>()("t3fleet/controller/NodeRegistry") {
  static readonly layer = Layer.effect(
    NodeRegistry,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const config = yield* ControllerConfig;
      const joinTokens = yield* JoinTokens;
      const events = yield* Events;
      const connectedNodeIds = yield* SubscriptionRef.make<ReadonlySet<string>>(new Set());

      const registerWithToken = Effect.fn("NodeRegistry.registerWithToken")(function* (input: {
        readonly token: string;
        readonly nodeName: string;
        readonly protocolVersion: number;
      }) {
        yield* joinTokens.consume(input.token);
        const nodeId = `node-${NodeCrypto.randomBytes(6).toString("hex")}`;
        const credential = `fnc_${NodeCrypto.randomBytes(32).toString("base64url")}`;
        const now = yield* Clock.currentTimeMillis;
        yield* sql`
          INSERT INTO nodes (id, name, join_state, credential_hash, protocol_version, last_seen_at, capacity_json, created_at, updated_at)
          VALUES (${nodeId}, ${input.nodeName}, 'joined', ${hashSecret(credential)}, ${input.protocolVersion}, ${now}, NULL, ${now}, ${now})
        `.pipe(Effect.orDie);
        yield* events.append({ kind: "node-joined", nodeId, payload: { name: input.nodeName } });
        return { nodeId, credential: Redacted.make(credential) };
      });

      const authenticate = Effect.fn("NodeRegistry.authenticate")(function* (input: {
        readonly nodeId: string;
        readonly credential: string;
      }) {
        const rows = yield* sql<{ credential_hash: string }>`
          SELECT credential_hash FROM nodes WHERE id = ${input.nodeId}
        `.pipe(Effect.orDie);
        const row = rows[0];
        if (row === undefined) {
          return yield* new InvalidCredentialError({ nodeId: input.nodeId });
        }
        const expected = Buffer.from(row.credential_hash, "hex");
        const actual = NodeCrypto.createHash("sha256").update(input.credential, "utf8").digest();
        if (!NodeCrypto.timingSafeEqual(expected, actual)) {
          return yield* new InvalidCredentialError({ nodeId: input.nodeId });
        }
      });

      const recordHeartbeat = Effect.fn("NodeRegistry.recordHeartbeat")(function* (input: {
        readonly nodeId: string;
        readonly capacity: CapacitySnapshot;
      }) {
        const now = yield* Clock.currentTimeMillis;
        const capacityJson = yield* encodeCapacity(input.capacity).pipe(Effect.orDie);
        yield* sql`
          UPDATE nodes SET last_seen_at = ${now}, capacity_json = ${capacityJson}, updated_at = ${now}
          WHERE id = ${input.nodeId}
        `.pipe(Effect.orDie);
      });

      const recordEndpointHost = Effect.fn("NodeRegistry.recordEndpointHost")(function* (input: {
        readonly nodeId: string;
        readonly host: string;
      }) {
        const now = yield* Clock.currentTimeMillis;
        yield* sql`
          UPDATE nodes SET endpoint_host = ${input.host}, updated_at = ${now}
          WHERE id = ${input.nodeId}
        `.pipe(Effect.orDie);
      });

      const endpointHost = Effect.fn("NodeRegistry.endpointHost")(function* (nodeId: string) {
        const rows = yield* sql<{ endpoint_host: string | null }>`
          SELECT endpoint_host FROM nodes WHERE id = ${nodeId}
        `.pipe(Effect.orDie);
        return Option.fromNullishOr(rows[0]?.endpoint_host);
      });

      const markConnected = (nodeId: string) =>
        SubscriptionRef.update(
          connectedNodeIds,
          (ids) => new Set([...ids, nodeId]) as ReadonlySet<string>,
        ).pipe(Effect.andThen(events.append({ kind: "node-connected", nodeId })));

      const markDisconnected = (nodeId: string) =>
        SubscriptionRef.update(connectedNodeIds, (ids) => {
          const next = new Set(ids);
          next.delete(nodeId);
          return next as ReadonlySet<string>;
        }).pipe(Effect.andThen(events.append({ kind: "node-disconnected", nodeId })));

      const list = Effect.gen(function* () {
        const rows = yield* sql<NodeRow>`
          SELECT id, name, protocol_version, last_seen_at, capacity_json, created_at
          FROM nodes ORDER BY created_at ASC
        `.pipe(Effect.orDie);
        const now = yield* Clock.currentTimeMillis;
        const connected = yield* SubscriptionRef.get(connectedNodeIds);
        const onlineWindowMillis = config.heartbeatIntervalMillis * 3;
        const summaries: Array<NodeSummary> = [];
        for (const row of rows) {
          summaries.push({
            id: row.id,
            name: row.name,
            protocolVersion: row.protocol_version,
            health:
              row.last_seen_at !== null && now - row.last_seen_at <= onlineWindowMillis
                ? "online"
                : "offline",
            connected: connected.has(row.id),
            lastSeenAtMillis: row.last_seen_at,
            capacity:
              row.capacity_json === null
                ? null
                : yield* decodeCapacity(row.capacity_json).pipe(Effect.orDie),
            createdAtMillis: row.created_at,
          });
        }
        return summaries;
      });

      return NodeRegistry.of({
        registerWithToken,
        authenticate,
        recordHeartbeat,
        recordEndpointHost,
        endpointHost,
        markConnected,
        markDisconnected,
        connectedNodeIds,
        list,
      });
    }),
  );
}
