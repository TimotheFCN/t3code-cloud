import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import { ControllerConfig, defaults } from "../Config.ts";
import { Vault } from "./Vault.ts";

const tempDataDir = Effect.promise(() =>
  NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "fleet-vault-test-")),
);

const vaultLayer = (dataDir: string) =>
  Vault.layer.pipe(Layer.provide(ControllerConfig.layer({ ...defaults, dataDir })));

/** Every file under `dir`, recursively, as (path, contents-buffer) pairs. */
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

describe("Vault", () => {
  it.effect("round-trips a secret and deletes idempotently", () =>
    Effect.gen(function* () {
      const dataDir = yield* tempDataDir;
      yield* Effect.gen(function* () {
        const vault = yield* Vault;
        const ref = yield* vault.store(Redacted.make("super-secret-token"));
        expect(ref).toMatch(/^sec_[0-9a-f]+$/);

        const read = yield* vault.read(ref);
        expect(Redacted.value(read)).toBe("super-secret-token");

        yield* vault.delete(ref);
        const missing = yield* vault.read(ref).pipe(Effect.flip);
        expect(missing).toMatchObject({ _tag: "SecretNotFoundError", ref });

        // Deleting again (or deleting an unknown ref) is a no-op.
        yield* vault.delete(ref);
        yield* vault.delete("sec_never_existed");
      }).pipe(Effect.provide(vaultLayer(dataDir)));
    }),
  );

  it.effect("never writes the plaintext to disk and keeps key files private", () =>
    Effect.gen(function* () {
      const dataDir = yield* tempDataDir;
      const secret = "fst_bearer_token_plaintext_needle";
      yield* Effect.gen(function* () {
        const vault = yield* Vault;
        yield* vault.store(Redacted.make(secret));
      }).pipe(Effect.provide(vaultLayer(dataDir)));

      // Nothing at rest — in any file the controller wrote — contains the
      // plaintext (`architecture.md` §4 invariant 1).
      const files = yield* Effect.promise(() => readAllFiles(dataDir));
      expect(files.length).toBeGreaterThanOrEqual(2);
      for (const [, contents] of files) {
        expect(contents.includes(secret)).toBe(false);
      }

      const identityStat = yield* Effect.promise(() =>
        NodeFs.stat(NodePath.join(dataDir, "vault", "identity")),
      );
      expect(identityStat.mode & 0o777).toBe(0o600);
      const secretsStat = yield* Effect.promise(() =>
        NodeFs.stat(NodePath.join(dataDir, "vault", "secrets.json")),
      );
      expect(secretsStat.mode & 0o777).toBe(0o600);
    }),
  );

  it.effect("a restarted vault (same data dir) reads existing secrets", () =>
    Effect.gen(function* () {
      const dataDir = yield* tempDataDir;
      const ref = yield* Effect.gen(function* () {
        const vault = yield* Vault;
        return yield* vault.store(Redacted.make("survives-restart"));
      }).pipe(Effect.provide(vaultLayer(dataDir)));

      const read = yield* Effect.gen(function* () {
        const vault = yield* Vault;
        return yield* vault.read(ref);
      }).pipe(Effect.provide(vaultLayer(dataDir)));
      expect(Redacted.value(read)).toBe("survives-restart");
    }),
  );

  it.effect("the database/secrets file alone reveals nothing without the identity", () =>
    Effect.gen(function* () {
      const dataDir = yield* tempDataDir;
      const ref = yield* Effect.gen(function* () {
        const vault = yield* Vault;
        return yield* vault.store(Redacted.make("leaked-file-scenario"));
      }).pipe(Effect.provide(vaultLayer(dataDir)));

      // Simulate an attacker holding secrets.json but not the identity: a
      // fresh vault directory with a *new* identity cannot decrypt the ref.
      const stolenDir = yield* tempDataDir;
      yield* Effect.promise(async () => {
        await NodeFs.mkdir(NodePath.join(stolenDir, "vault"), { recursive: true });
        await NodeFs.copyFile(
          NodePath.join(dataDir, "vault", "secrets.json"),
          NodePath.join(stolenDir, "vault", "secrets.json"),
        );
      });
      const failure = yield* Effect.gen(function* () {
        const vault = yield* Vault;
        return yield* vault.read(ref);
      }).pipe(Effect.provide(vaultLayer(stolenDir)), Effect.flip);
      expect(failure).toMatchObject({ _tag: "VaultError", operation: "read" });
    }),
  );
});
