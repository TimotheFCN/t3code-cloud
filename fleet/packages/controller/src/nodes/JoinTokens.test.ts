import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ControllerConfig, defaults } from "../Config.ts";
import * as Database from "../db/Database.ts";
import { hashSecret, JoinTokens } from "./JoinTokens.ts";

const TestLayer = JoinTokens.layer.pipe(
  Layer.provideMerge(Database.layerMemory),
  Layer.provideMerge(ControllerConfig.layer(defaults)),
);

describe("JoinTokens", () => {
  it.effect("minted tokens can be consumed exactly once", () =>
    Effect.gen(function* () {
      const joinTokens = yield* JoinTokens;
      const minted = yield* joinTokens.mint();
      const token = Redacted.value(minted.token);

      yield* joinTokens.consume(token);

      const secondUse = yield* joinTokens.consume(token).pipe(Effect.flip);
      expect(secondUse._tag).toBe("InvalidJoinTokenError");
      expect(secondUse.reason).toBe("already-used");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("expired tokens are rejected", () =>
    Effect.gen(function* () {
      const joinTokens = yield* JoinTokens;
      // TestClock time is frozen, so a zero TTL is expired immediately.
      const minted = yield* joinTokens.mint({ ttlSeconds: 0 });

      const outcome = yield* joinTokens.consume(Redacted.value(minted.token)).pipe(Effect.flip);
      expect(outcome._tag).toBe("InvalidJoinTokenError");
      expect(outcome.reason).toBe("expired");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("unknown tokens are rejected", () =>
    Effect.gen(function* () {
      const joinTokens = yield* JoinTokens;
      const outcome = yield* joinTokens.consume("fjt_definitely-not-minted").pipe(Effect.flip);
      expect(outcome._tag).toBe("InvalidJoinTokenError");
      expect(outcome.reason).toBe("not-found");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("only the hash is stored at rest", () =>
    Effect.gen(function* () {
      const joinTokens = yield* JoinTokens;
      const sql = yield* SqlClient.SqlClient;
      const minted = yield* joinTokens.mint();
      const token = Redacted.value(minted.token);

      const rows = yield* sql<{ token_hash: string }>`SELECT token_hash FROM join_tokens`;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.token_hash).not.toContain(token);
      expect(rows[0]!.token_hash).toBe(hashSecret(token));
    }).pipe(Effect.provide(TestLayer)),
  );
});
