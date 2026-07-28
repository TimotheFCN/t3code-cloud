import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { Vault, type VaultError } from "../vault/Vault.ts";

/** The ACL tag environments join with unless the operator overrides it. */
export const DEFAULT_ENVIRONMENT_TAG = "tag:t3-env";

const Keys = {
  clientId: "tailscale.oauth-client-id",
  secretRef: "tailscale.oauth-client-secret-ref",
  tag: "tailscale.tag",
} as const;

export interface TailnetConfiguration {
  readonly clientId: string;
  /** Vault ref of the OAuth client secret — the secret never rests in SQLite. */
  readonly secretRef: string;
  readonly tag: string;
}

export interface TailnetStatus {
  readonly configured: boolean;
  readonly clientId: string | null;
  readonly tag: string;
}

/**
 * Operator-provided Tailscale OAuth client configuration, persisted in the
 * `settings` table. The client secret goes through the vault seam
 * (`architecture.md` §4): SQLite holds only its ref.
 */
export class TailnetSettings extends Context.Service<
  TailnetSettings,
  {
    /** Stores/replaces the OAuth client; the old secret is removed from the vault. */
    readonly configure: (input: {
      readonly clientId: string;
      readonly clientSecret: Redacted.Redacted<string>;
      readonly tag?: string | undefined;
    }) => Effect.Effect<TailnetStatus, VaultError>;
    readonly read: Effect.Effect<Option.Option<TailnetConfiguration>>;
    /** Non-secret view served by `GET /api/settings/tailscale`. */
    readonly status: Effect.Effect<TailnetStatus>;
  }
>()("t3fleet/controller/TailnetSettings") {
  static readonly layer = Layer.effect(
    TailnetSettings,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const vault = yield* Vault;

      const getValue = Effect.fn("TailnetSettings.getValue")(function* (key: string) {
        const rows = yield* sql<{ value: string }>`
          SELECT value FROM settings WHERE key = ${key}
        `.pipe(Effect.orDie);
        return rows[0] === undefined ? Option.none<string>() : Option.some(rows[0].value);
      });

      const setValue = Effect.fn("TailnetSettings.setValue")(function* (
        key: string,
        value: string,
      ) {
        const now = yield* Clock.currentTimeMillis;
        yield* sql`
          INSERT INTO settings (key, value, updated_at) VALUES (${key}, ${value}, ${now})
          ON CONFLICT (key) DO UPDATE SET value = ${value}, updated_at = ${now}
        `.pipe(Effect.orDie);
      });

      const read = Effect.gen(function* () {
        const clientId = yield* getValue(Keys.clientId);
        const secretRef = yield* getValue(Keys.secretRef);
        if (Option.isNone(clientId) || Option.isNone(secretRef)) {
          return Option.none<TailnetConfiguration>();
        }
        const tag = yield* getValue(Keys.tag);
        return Option.some<TailnetConfiguration>({
          clientId: clientId.value,
          secretRef: secretRef.value,
          tag: Option.getOrElse(tag, () => DEFAULT_ENVIRONMENT_TAG),
        });
      });

      const status = Effect.gen(function* () {
        const configuration = yield* read;
        return {
          configured: Option.isSome(configuration),
          clientId: Option.isSome(configuration) ? configuration.value.clientId : null,
          tag: Option.isSome(configuration) ? configuration.value.tag : DEFAULT_ENVIRONMENT_TAG,
        } satisfies TailnetStatus;
      });

      const configure = Effect.fn("TailnetSettings.configure")(function* (input: {
        readonly clientId: string;
        readonly clientSecret: Redacted.Redacted<string>;
        readonly tag?: string | undefined;
      }) {
        const previous = yield* read;
        const secretRef = yield* vault.store(input.clientSecret);
        yield* setValue(Keys.clientId, input.clientId);
        yield* setValue(Keys.secretRef, secretRef);
        yield* setValue(Keys.tag, input.tag ?? DEFAULT_ENVIRONMENT_TAG);
        if (Option.isSome(previous)) {
          yield* vault.delete(previous.value.secretRef);
        }
        yield* Effect.logInfo(`tailnet: OAuth client configured (client id ${input.clientId})`);
        return yield* status;
      });

      return TailnetSettings.of({ configure, read, status });
    }),
  );
}
