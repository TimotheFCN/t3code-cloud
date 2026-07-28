import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ControllerConfig } from "../Config.ts";

export class InvalidJoinTokenError extends Schema.TaggedErrorClass<InvalidJoinTokenError>()(
  "InvalidJoinTokenError",
  {
    reason: Schema.Literals(["not-found", "expired", "already-used"]),
  },
) {}

export const hashSecret = (secret: string): string =>
  NodeCrypto.createHash("sha256").update(secret, "utf8").digest("hex");

/**
 * Single-use, expiring join tokens. Only the SHA-256 hash is stored; the
 * plaintext token exists once in the mint response.
 */
export class JoinTokens extends Context.Service<
  JoinTokens,
  {
    readonly mint: (options?: {
      readonly ttlSeconds?: number;
    }) => Effect.Effect<
      { readonly token: Redacted.Redacted<string>; readonly expiresAtMillis: number },
      never
    >;
    /**
     * Atomically consumes a token: succeeds at most once per token, and only
     * before expiry.
     */
    readonly consume: (token: string) => Effect.Effect<void, InvalidJoinTokenError>;
  }
>()("t3fleet/controller/JoinTokens") {
  static readonly layer = Layer.effect(
    JoinTokens,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const config = yield* ControllerConfig;

      const mint = Effect.fn("JoinTokens.mint")(function* (options?: {
        readonly ttlSeconds?: number;
      }) {
        const ttlSeconds = options?.ttlSeconds ?? config.joinTokenTtlSeconds;
        const token = `fjt_${NodeCrypto.randomBytes(32).toString("base64url")}`;
        const now = yield* Clock.currentTimeMillis;
        const expiresAtMillis = now + ttlSeconds * 1000;
        yield* sql`
          INSERT INTO join_tokens (id, token_hash, single_use, used_at, expires_at, created_at)
          VALUES (${NodeCrypto.randomUUID()}, ${hashSecret(token)}, 1, NULL, ${expiresAtMillis}, ${now})
        `.pipe(Effect.orDie);
        return { token: Redacted.make(token), expiresAtMillis };
      });

      const consume = Effect.fn("JoinTokens.consume")(function* (token: string) {
        const tokenHash = hashSecret(token);
        const now = yield* Clock.currentTimeMillis;
        const consumed = yield* sql<{ id: string }>`
          UPDATE join_tokens
          SET used_at = ${now}
          WHERE token_hash = ${tokenHash} AND used_at IS NULL AND expires_at > ${now}
          RETURNING id
        `.pipe(Effect.orDie);
        if (consumed.length > 0) {
          return;
        }
        const existing = yield* sql<{ used_at: number | null; expires_at: number }>`
          SELECT used_at, expires_at FROM join_tokens WHERE token_hash = ${tokenHash}
        `.pipe(Effect.orDie);
        const row = existing[0];
        if (row === undefined) {
          return yield* new InvalidJoinTokenError({ reason: "not-found" });
        }
        if (row.used_at !== null) {
          return yield* new InvalidJoinTokenError({ reason: "already-used" });
        }
        return yield* new InvalidJoinTokenError({ reason: "expired" });
      });

      return JoinTokens.of({ mint, consume });
    }),
  );
}
