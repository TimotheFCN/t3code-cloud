import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { AgentConfig } from "./Config.ts";

export interface StoredCredential {
  readonly nodeId: string;
  readonly credential: Redacted.Redacted<string>;
}

const CredentialFile = Schema.Struct({
  nodeId: Schema.String,
  credential: Schema.String,
});

const decodeCredentialFile = Schema.decodeUnknownEffect(Schema.fromJsonString(CredentialFile));
const encodeCredentialFile = Schema.encodeUnknownEffect(Schema.fromJsonString(CredentialFile));

/**
 * The agent's only local state: the per-node credential issued at join,
 * stored at `<stateDir>/credential.json` with mode 0600.
 */
export class CredentialStore extends Context.Service<
  CredentialStore,
  {
    readonly load: Effect.Effect<Option.Option<StoredCredential>>;
    readonly save: (credential: StoredCredential) => Effect.Effect<void>;
  }
>()("t3fleet/agent/CredentialStore") {
  static readonly layer = Layer.effect(
    CredentialStore,
    Effect.gen(function* () {
      const config = yield* AgentConfig;
      const filePath = NodePath.join(config.stateDir, "credential.json");

      const load = Effect.gen(function* () {
        const contents = yield* Effect.tryPromise(() => NodeFs.readFile(filePath, "utf8")).pipe(
          Effect.option,
        );
        if (Option.isNone(contents)) {
          return Option.none<StoredCredential>();
        }
        const decoded = yield* decodeCredentialFile(contents.value).pipe(Effect.orDie);
        return Option.some<StoredCredential>({
          nodeId: decoded.nodeId,
          credential: Redacted.make(decoded.credential),
        });
      });

      const save = Effect.fn("CredentialStore.save")(function* (credential: StoredCredential) {
        const contents = yield* encodeCredentialFile({
          nodeId: credential.nodeId,
          credential: Redacted.value(credential.credential),
        }).pipe(Effect.orDie);
        yield* Effect.promise(async () => {
          await NodeFs.mkdir(config.stateDir, { recursive: true });
          await NodeFs.writeFile(filePath, contents, { mode: 0o600 });
          await NodeFs.chmod(filePath, 0o600);
        });
      });

      return CredentialStore.of({ load, save });
    }),
  );
}
