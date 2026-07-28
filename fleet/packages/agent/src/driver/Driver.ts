import type { EnvironmentDescriptor } from "@t3fleet/shared/environment";
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

export interface CreateEnvironmentInput {
  readonly id: string;
  readonly name: string;
  readonly image: string;
}

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface VolumeSnapshot {
  readonly path: string;
}

/**
 * The seam between the controller model and container runtimes
 * (`docs/fleet/architecture.md` — fleet-agent; `architecture.md` §2). Phase 1
 * ships only the in-memory `FakeDriver`; phase 2 implements `docker` behind
 * this same interface. The controller never references Docker concepts —
 * everything it knows arrives through these methods.
 */
export class Driver extends Context.Service<
  Driver,
  {
    readonly createEnvironment: (
      input: CreateEnvironmentInput,
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
      destinationPath: string,
    ) => Effect.Effect<VolumeSnapshot, DriverError | EnvironmentNotFoundError>;
    readonly listEnvironments: Effect.Effect<ReadonlyArray<EnvironmentDescriptor>, DriverError>;
  }
>()("t3fleet/agent/Driver") {}
