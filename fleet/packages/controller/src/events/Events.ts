import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export interface EventRow {
  readonly id: number;
  readonly occurredAtMillis: number;
  readonly kind: string;
  readonly nodeId: string | null;
  readonly payload: unknown;
}

/**
 * Append-only operational log backing the (phase 6) dashboard activity view.
 * Payloads must never contain secrets.
 */
export class Events extends Context.Service<
  Events,
  {
    readonly append: (input: {
      readonly kind: string;
      readonly nodeId?: string;
      readonly payload?: unknown;
    }) => Effect.Effect<void>;
    readonly list: Effect.Effect<ReadonlyArray<EventRow>>;
  }
>()("t3fleet/controller/Events") {
  static readonly layer = Layer.effect(
    Events,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const append = Effect.fn("Events.append")(function* (input: {
        readonly kind: string;
        readonly nodeId?: string;
        readonly payload?: unknown;
      }) {
        const now = yield* Clock.currentTimeMillis;
        yield* sql`
          INSERT INTO events (occurred_at, kind, node_id, payload_json)
          VALUES (${now}, ${input.kind}, ${input.nodeId ?? null}, ${
            input.payload === undefined ? null : JSON.stringify(input.payload)
          })
        `.pipe(Effect.orDie);
      });

      const list = Effect.gen(function* () {
        const rows = yield* sql<{
          id: number;
          occurred_at: number;
          kind: string;
          node_id: string | null;
          payload_json: string | null;
        }>`SELECT id, occurred_at, kind, node_id, payload_json FROM events ORDER BY id ASC`.pipe(
          Effect.orDie,
        );
        return rows.map(
          (row): EventRow => ({
            id: row.id,
            occurredAtMillis: row.occurred_at,
            kind: row.kind,
            nodeId: row.node_id,
            payload: row.payload_json === null ? null : JSON.parse(row.payload_json),
          }),
        );
      });

      return Events.of({ append, list });
    }),
  );
}
