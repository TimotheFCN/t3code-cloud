import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";

import { Decrypter, Encrypter, generateIdentity, identityToRecipient } from "age-encryption";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ControllerConfig } from "../Config.ts";

export class SecretNotFoundError extends Schema.TaggedErrorClass<SecretNotFoundError>()(
  "SecretNotFoundError",
  {
    ref: Schema.String,
  },
) {}

export class VaultError extends Schema.TaggedErrorClass<VaultError>()("VaultError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const SecretsFile = Schema.Record(Schema.String, Schema.String);
const decodeSecretsFile = Schema.decodeUnknownEffect(Schema.fromJsonString(SecretsFile));

/**
 * The minimal encrypted-secrets primitive (`architecture.md` §4; phase 5
 * extends it into the full profile/secret model). Payloads are encrypted
 * with `age` (X25519, pure-TS `age-encryption` package) to a recipient whose
 * identity lives at `<dataDir>/vault/identity` — outside the database, so a
 * leaked SQLite file or secrets file alone reveals nothing.
 *
 * Storage is one JSON file `<dataDir>/vault/secrets.json` mapping
 * `ref -> base64(age ciphertext)`; the DB stores refs only. Values are
 * `Redacted` in memory and never logged.
 */
export class Vault extends Context.Service<
  Vault,
  {
    /** Encrypts and stores a payload, returning its ref. */
    readonly store: (payload: Redacted.Redacted<string>) => Effect.Effect<string, VaultError>;
    readonly read: (
      ref: string,
    ) => Effect.Effect<Redacted.Redacted<string>, SecretNotFoundError | VaultError>;
    /** Removes a secret; unknown refs are a no-op. */
    readonly delete: (ref: string) => Effect.Effect<void, VaultError>;
  }
>()("t3fleet/controller/Vault") {
  static readonly layer = Layer.effect(
    Vault,
    Effect.gen(function* () {
      const config = yield* ControllerConfig;
      const vaultDir = NodePath.resolve(config.dataDir, "vault");
      const identityPath = NodePath.join(vaultDir, "identity");
      const secretsPath = NodePath.join(vaultDir, "secrets.json");
      // Serializes read-modify-write cycles on the secrets file.
      const lock = yield* Semaphore.make(1);

      const fail = (operation: string, message: string) => (cause: unknown) =>
        new VaultError({ operation, message, cause });

      yield* Effect.promise(() => NodeFs.mkdir(vaultDir, { recursive: true, mode: 0o700 }));

      const identity = yield* Effect.gen(function* () {
        const existing = yield* Effect.tryPromise({
          try: () => NodeFs.readFile(identityPath, "utf8"),
          catch: () => "missing" as const,
        }).pipe(Effect.option);
        if (existing._tag === "Some") {
          return Redacted.make(existing.value.trim());
        }
        const generated = yield* Effect.promise(() => generateIdentity());
        yield* Effect.tryPromise({
          try: () => NodeFs.writeFile(identityPath, `${generated}\n`, { mode: 0o600 }),
          catch: fail("init", `cannot write vault identity at ${identityPath}`),
        });
        yield* Effect.logInfo(`vault: generated new age identity at ${identityPath}`);
        return Redacted.make(generated);
      });
      const recipient = yield* Effect.promise(() => identityToRecipient(Redacted.value(identity)));

      const readSecretsFile = Effect.gen(function* () {
        const contents = yield* Effect.tryPromise({
          try: () => NodeFs.readFile(secretsPath, "utf8"),
          catch: () => "missing" as const,
        }).pipe(Effect.option);
        if (contents._tag === "None") {
          return {} as Record<string, string>;
        }
        const decoded = yield* decodeSecretsFile(contents.value).pipe(
          Effect.mapError(fail("read", `corrupt secrets file at ${secretsPath}`)),
        );
        return { ...decoded } as Record<string, string>;
      });

      const writeSecretsFile = (secrets: Record<string, string>) =>
        Effect.gen(function* () {
          // Atomic replace: write a sibling temp file, then rename over.
          const tmpPath = `${secretsPath}.tmp`;
          yield* Effect.tryPromise({
            try: async () => {
              await NodeFs.writeFile(tmpPath, JSON.stringify(secrets, null, 2), { mode: 0o600 });
              await NodeFs.rename(tmpPath, secretsPath);
            },
            catch: fail("write", `cannot write secrets file at ${secretsPath}`),
          });
        });

      const store = Effect.fn("Vault.store")(function* (payload: Redacted.Redacted<string>) {
        const ref = `sec_${NodeCrypto.randomBytes(9).toString("hex")}`;
        const encrypter = new Encrypter();
        encrypter.addRecipient(recipient);
        const ciphertext = yield* Effect.tryPromise({
          try: () => encrypter.encrypt(Redacted.value(payload)),
          catch: fail("store", "encryption failed"),
        });
        yield* lock.withPermit(
          Effect.gen(function* () {
            const secrets = yield* readSecretsFile;
            secrets[ref] = Buffer.from(ciphertext).toString("base64");
            yield* writeSecretsFile(secrets);
          }),
        );
        return ref;
      });

      const read = Effect.fn("Vault.read")(function* (ref: string) {
        const secrets = yield* readSecretsFile;
        const ciphertext = secrets[ref];
        if (ciphertext === undefined) {
          return yield* new SecretNotFoundError({ ref });
        }
        const decrypter = new Decrypter();
        decrypter.addIdentity(Redacted.value(identity));
        const plaintext = yield* Effect.tryPromise({
          try: () => decrypter.decrypt(Buffer.from(ciphertext, "base64"), "text"),
          catch: fail("read", `decryption failed for ${ref}`),
        });
        return Redacted.make(plaintext);
      });

      const del = Effect.fn("Vault.delete")(function* (ref: string) {
        yield* lock.withPermit(
          Effect.gen(function* () {
            const secrets = yield* readSecretsFile;
            if (!(ref in secrets)) {
              return;
            }
            delete secrets[ref];
            yield* writeSecretsFile(secrets);
          }),
        );
      });

      return Vault.of({ store, read, delete: del });
    }),
  );
}
