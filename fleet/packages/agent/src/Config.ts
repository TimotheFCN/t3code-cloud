import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";

import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

/**
 * Agent configuration. Sources, later ones win:
 *
 * 1. built-in defaults
 * 2. JSON config file (path from `FLEET_AGENT_CONFIG`)
 * 3. `FLEET_AGENT_*` environment variables
 *
 * The join token is intentionally env/file-only input consumed at first join;
 * afterwards the credential file under `stateDir` is the agent's only state.
 */
export interface AgentConfigShape {
  /** Controller origin, e.g. `ws://127.0.0.1:9400` or `http://fleet:9400`. */
  readonly controllerUrl: string;
  readonly nodeName: string;
  /**
   * Holds the credential file and volume snapshots; also the disk sampled
   * for capacity snapshots.
   */
  readonly stateDir: string;
  readonly joinToken: Option.Option<Redacted.Redacted<string>>;
  /**
   * Container runtime for environment containers. Defaults to `sysbox-runc`
   * — the only supported production runtime (inner Docker without
   * `--privileged`). The docker driver fails loudly when it is missing; a
   * different value here is an explicit, unsupported opt-out for tests.
   */
  readonly dockerRuntime: string;
  /** Snapshot tarballs kept per environment before the oldest are pruned. */
  readonly snapshotRetention: number;
  /** Image used for the helper containers that tar/untar volumes. */
  readonly helperImage: string;
}

const ConfigFile = Schema.Struct({
  controllerUrl: Schema.optional(Schema.String),
  nodeName: Schema.optional(Schema.String),
  stateDir: Schema.optional(Schema.String),
  joinToken: Schema.optional(Schema.String),
  dockerRuntime: Schema.optional(Schema.String),
  snapshotRetention: Schema.optional(Schema.Int),
  helperImage: Schema.optional(Schema.String),
});

export const defaults = {
  stateDir: "./.data/agent",
  dockerRuntime: "sysbox-runc",
  snapshotRetention: 5,
  helperImage: "alpine:3.22",
} as const;

const decodeConfigFile = Schema.decodeUnknownEffect(Schema.fromJsonString(ConfigFile));

export class AgentConfigError extends Schema.TaggedErrorClass<AgentConfigError>()(
  "AgentConfigError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class AgentConfig extends Context.Service<AgentConfig, AgentConfigShape>()(
  "t3fleet/agent/Config",
) {
  static readonly layer = (config: AgentConfigShape) => Layer.succeed(AgentConfig)(config);

  static readonly layerFromEnv = Layer.effect(
    AgentConfig,
    Effect.gen(function* () {
      const filePath = yield* Config.string("FLEET_AGENT_CONFIG").pipe(Config.option);
      let fromFile: typeof ConfigFile.Type = {};
      if (Option.isSome(filePath)) {
        const contents = yield* Effect.tryPromise({
          try: () => NodeFs.readFile(filePath.value, "utf8"),
          catch: (cause) =>
            new AgentConfigError({ message: `cannot read config file ${filePath.value}`, cause }),
        });
        fromFile = yield* decodeConfigFile(contents).pipe(
          Effect.mapError(
            (cause) =>
              new AgentConfigError({ message: `invalid config file ${filePath.value}`, cause }),
          ),
        );
      }
      const env = {
        controllerUrl: yield* Config.string("FLEET_AGENT_CONTROLLER_URL").pipe(Config.option),
        nodeName: yield* Config.string("FLEET_AGENT_NODE_NAME").pipe(Config.option),
        stateDir: yield* Config.string("FLEET_AGENT_STATE_DIR").pipe(Config.option),
        joinToken: yield* Config.redacted("FLEET_AGENT_JOIN_TOKEN").pipe(Config.option),
        dockerRuntime: yield* Config.string("FLEET_AGENT_DOCKER_RUNTIME").pipe(Config.option),
        snapshotRetention: yield* Config.int("FLEET_AGENT_SNAPSHOT_RETENTION").pipe(Config.option),
        helperImage: yield* Config.string("FLEET_AGENT_HELPER_IMAGE").pipe(Config.option),
      };
      const controllerUrl = Option.getOrElse(env.controllerUrl, () => fromFile.controllerUrl ?? "");
      if (controllerUrl === "") {
        return yield* new AgentConfigError({
          message:
            "controller URL is required (FLEET_AGENT_CONTROLLER_URL or config file `controllerUrl`)",
        });
      }
      return AgentConfig.of({
        controllerUrl,
        nodeName: Option.getOrElse(env.nodeName, () => fromFile.nodeName ?? NodeOs.hostname()),
        stateDir: Option.getOrElse(env.stateDir, () => fromFile.stateDir ?? defaults.stateDir),
        joinToken: Option.orElse(env.joinToken, () =>
          fromFile.joinToken === undefined
            ? Option.none()
            : Option.some(Redacted.make(fromFile.joinToken)),
        ),
        dockerRuntime: Option.getOrElse(
          env.dockerRuntime,
          () => fromFile.dockerRuntime ?? defaults.dockerRuntime,
        ),
        snapshotRetention: Option.getOrElse(
          env.snapshotRetention,
          () => fromFile.snapshotRetention ?? defaults.snapshotRetention,
        ),
        helperImage: Option.getOrElse(
          env.helperImage,
          () => fromFile.helperImage ?? defaults.helperImage,
        ),
      });
    }),
  );
}
