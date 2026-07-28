import type {
  CreateEnvironmentSpec,
  EnvironmentDescriptor,
  ExecResult,
  PulledImage,
  VolumeSnapshot,
} from "@t3fleet/shared/environment";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class DriverError extends Schema.TaggedErrorClass<DriverError>()("DriverError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class EnvironmentNotFoundError extends Schema.TaggedErrorClass<EnvironmentNotFoundError>()(
  "EnvironmentNotFoundError",
  {
    environmentId: Schema.String,
  },
) {}

export type { CreateEnvironmentSpec, ExecResult, PulledImage, VolumeSnapshot };

/**
 * The seam between the controller model and container runtimes
 * (`docs/fleet/architecture.md` — fleet-agent; `architecture.md` §2). The
 * `docker` driver (phase 2) is the production implementation; `FakeDriver`
 * backs tests. The controller never references Docker concepts — everything
 * it knows arrives through these methods.
 *
 * Contract notes:
 *
 * - `createEnvironment` is idempotent per environment id: recreating an id
 *   that already exists adopts the existing environment (crash-safe retries).
 * - `snapshotVolume` writes a tarball under the driver's snapshot directory
 *   and applies retention; `restoreVolume` replaces the volume contents from
 *   such a tarball and requires the environment to be stopped.
 * - `pullImage` fetches an image so `createEnvironment` can use it; it
 *   reports the resolved digest for the controller's image registry.
 */
export class Driver extends Context.Service<
  Driver,
  {
    readonly pullImage: (reference: string) => Effect.Effect<PulledImage, DriverError>;
    readonly createEnvironment: (
      spec: CreateEnvironmentSpec,
    ) => Effect.Effect<EnvironmentDescriptor, DriverError>;
    readonly startEnvironment: (
      environmentId: string,
    ) => Effect.Effect<EnvironmentDescriptor, DriverError | EnvironmentNotFoundError>;
    readonly stopEnvironment: (
      environmentId: string,
    ) => Effect.Effect<EnvironmentDescriptor, DriverError | EnvironmentNotFoundError>;
    readonly destroyEnvironment: (
      environmentId: string,
    ) => Effect.Effect<void, DriverError | EnvironmentNotFoundError>;
    readonly execInEnvironment: (
      environmentId: string,
      command: ReadonlyArray<string>,
    ) => Effect.Effect<ExecResult, DriverError | EnvironmentNotFoundError>;
    readonly snapshotVolume: (
      environmentId: string,
    ) => Effect.Effect<VolumeSnapshot, DriverError | EnvironmentNotFoundError>;
    readonly restoreVolume: (
      environmentId: string,
      snapshotPath: string,
    ) => Effect.Effect<void, DriverError | EnvironmentNotFoundError>;
    readonly listEnvironments: Effect.Effect<ReadonlyArray<EnvironmentDescriptor>, DriverError>;
  }
>()("t3fleet/agent/Driver") {}
