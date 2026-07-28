import * as Schema from "effect/Schema";

/**
 * Environment as reported by a node's driver. Phase 1 defines the minimal
 * shape the driver interface needs; phase 2 (docker driver) and phase 3
 * (lifecycle) extend it.
 */
export const EnvironmentState = Schema.Literals(["created", "running", "stopped"]);
export type EnvironmentState = typeof EnvironmentState.Type;

export const EnvironmentDescriptor = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  image: Schema.String,
  state: EnvironmentState,
});
export type EnvironmentDescriptor = typeof EnvironmentDescriptor.Type;
