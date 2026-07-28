import * as Schema from "effect/Schema";

/**
 * Environment as reported by a node's driver. Phase 2 extended the minimal
 * phase-1 shape with the container/volume identity and published ports the
 * docker driver derives from labels; phase 3 (lifecycle) builds on it.
 */
export const EnvironmentState = Schema.Literals(["created", "running", "stopped"]);
export type EnvironmentState = typeof EnvironmentState.Type;

/**
 * A container-port-to-host-port publication. `hostPort` is omitted in a
 * create spec to let the runtime pick an ephemeral port; descriptors of
 * running environments carry the resolved value.
 */
export const PortBinding = Schema.Struct({
  containerPort: Schema.Int,
  hostPort: Schema.optional(Schema.Int),
});
export type PortBinding = typeof PortBinding.Type;

export const EnvironmentDescriptor = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  image: Schema.String,
  state: EnvironmentState,
  /** Runtime identifiers, present when a real container backs the environment. */
  containerId: Schema.optional(Schema.String),
  volumeName: Schema.optional(Schema.String),
  /** Resolved port publications; only populated while the container runs. */
  ports: Schema.optional(Schema.Array(PortBinding)),
});
export type EnvironmentDescriptor = typeof EnvironmentDescriptor.Type;

/**
 * What the controller sends to create an environment. Env vars and port
 * publications are the phase-3 hooks (T3CODE_* config, node-port access
 * until the phase-4 tailnet takes over).
 */
export const CreateEnvironmentSpec = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  image: Schema.String,
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  publishPorts: Schema.optional(Schema.Array(PortBinding)),
});
export type CreateEnvironmentSpec = typeof CreateEnvironmentSpec.Type;

/** Result of `execInEnvironment`: the command's own outcome, not the driver's. */
export const ExecResult = Schema.Struct({
  exitCode: Schema.Int,
  stdout: Schema.String,
  stderr: Schema.String,
});
export type ExecResult = typeof ExecResult.Type;

/** A volume snapshot tarball written on the node that owns the environment. */
export const VolumeSnapshot = Schema.Struct({
  path: Schema.String,
  createdAtMillis: Schema.Number,
  sizeBytes: Schema.Number,
});
export type VolumeSnapshot = typeof VolumeSnapshot.Type;

/** Result of pulling an image on a node. */
export const PulledImage = Schema.Struct({
  reference: Schema.String,
  /** Repo digest (`name@sha256:...`) when the registry provides one. */
  digest: Schema.NullOr(Schema.String),
});
export type PulledImage = typeof PulledImage.Type;
