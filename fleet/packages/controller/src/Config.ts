import * as NodeFs from "node:fs/promises";

import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Controller configuration. Sources, later ones win:
 *
 * 1. built-in defaults
 * 2. JSON config file (path from `FLEET_CONTROLLER_CONFIG`)
 * 3. `FLEET_CONTROLLER_*` environment variables
 */
export interface ControllerConfigShape {
  readonly host: string;
  readonly port: number;
  /** Directory holding the SQLite database (created on demand). */
  readonly dataDir: string;
  /** Interval agents are told to heartbeat at. */
  readonly heartbeatIntervalMillis: number;
  /** Default TTL for minted join tokens when the API caller passes none. */
  readonly joinTokenTtlSeconds: number;
  /** Interval between environment status polls (descriptor + snapshot). */
  readonly statusPollIntervalMillis: number;
  /** How long a create waits for the T3 server to answer its descriptor. */
  readonly environmentHealthTimeoutMillis: number;
}

export const defaults: ControllerConfigShape = {
  host: "127.0.0.1",
  port: 9400,
  dataDir: "./.data/controller",
  heartbeatIntervalMillis: 10_000,
  joinTokenTtlSeconds: 900,
  statusPollIntervalMillis: 15_000,
  environmentHealthTimeoutMillis: 180_000,
};

const ConfigFile = Schema.Struct({
  host: Schema.optional(Schema.String),
  port: Schema.optional(Schema.Int),
  dataDir: Schema.optional(Schema.String),
  heartbeatIntervalMillis: Schema.optional(Schema.Int),
  joinTokenTtlSeconds: Schema.optional(Schema.Int),
  statusPollIntervalMillis: Schema.optional(Schema.Int),
  environmentHealthTimeoutMillis: Schema.optional(Schema.Int),
});

const decodeConfigFile = Schema.decodeUnknownEffect(Schema.fromJsonString(ConfigFile));

export class ControllerConfig extends Context.Service<ControllerConfig, ControllerConfigShape>()(
  "t3fleet/controller/Config",
) {
  static readonly layer = (config: ControllerConfigShape) =>
    Layer.succeed(ControllerConfig)(config);

  /** Loads defaults <- optional JSON file <- environment variables. */
  static readonly layerFromEnv = Layer.effect(
    ControllerConfig,
    Effect.gen(function* () {
      const filePath = yield* Config.string("FLEET_CONTROLLER_CONFIG").pipe(Config.option);
      let fromFile: typeof ConfigFile.Type = {};
      if (Option.isSome(filePath)) {
        const contents = yield* Effect.tryPromise({
          try: () => NodeFs.readFile(filePath.value, "utf8"),
          catch: (cause) =>
            new ControllerConfigError({
              message: `cannot read config file ${filePath.value}`,
              cause,
            }),
        });
        fromFile = yield* decodeConfigFile(contents).pipe(
          Effect.mapError(
            (cause) =>
              new ControllerConfigError({
                message: `invalid config file ${filePath.value}`,
                cause,
              }),
          ),
        );
      }
      const env = {
        host: yield* Config.string("FLEET_CONTROLLER_HOST").pipe(Config.option),
        port: yield* Config.port("FLEET_CONTROLLER_PORT").pipe(Config.option),
        dataDir: yield* Config.string("FLEET_CONTROLLER_DATA_DIR").pipe(Config.option),
        heartbeatIntervalMillis: yield* Config.int("FLEET_CONTROLLER_HEARTBEAT_INTERVAL_MS").pipe(
          Config.option,
        ),
        joinTokenTtlSeconds: yield* Config.int("FLEET_CONTROLLER_JOIN_TOKEN_TTL_SECONDS").pipe(
          Config.option,
        ),
        statusPollIntervalMillis: yield* Config.int(
          "FLEET_CONTROLLER_STATUS_POLL_INTERVAL_MS",
        ).pipe(Config.option),
        environmentHealthTimeoutMillis: yield* Config.int(
          "FLEET_CONTROLLER_ENVIRONMENT_HEALTH_TIMEOUT_MS",
        ).pipe(Config.option),
      };
      return ControllerConfig.of({
        host: Option.getOrElse(env.host, () => fromFile.host ?? defaults.host),
        port: Option.getOrElse(env.port, () => fromFile.port ?? defaults.port),
        dataDir: Option.getOrElse(env.dataDir, () => fromFile.dataDir ?? defaults.dataDir),
        heartbeatIntervalMillis: Option.getOrElse(
          env.heartbeatIntervalMillis,
          () => fromFile.heartbeatIntervalMillis ?? defaults.heartbeatIntervalMillis,
        ),
        joinTokenTtlSeconds: Option.getOrElse(
          env.joinTokenTtlSeconds,
          () => fromFile.joinTokenTtlSeconds ?? defaults.joinTokenTtlSeconds,
        ),
        statusPollIntervalMillis: Option.getOrElse(
          env.statusPollIntervalMillis,
          () => fromFile.statusPollIntervalMillis ?? defaults.statusPollIntervalMillis,
        ),
        environmentHealthTimeoutMillis: Option.getOrElse(
          env.environmentHealthTimeoutMillis,
          () => fromFile.environmentHealthTimeoutMillis ?? defaults.environmentHealthTimeoutMillis,
        ),
      });
    }),
  );
}

export class ControllerConfigError extends Schema.TaggedErrorClass<ControllerConfigError>()(
  "ControllerConfigError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
