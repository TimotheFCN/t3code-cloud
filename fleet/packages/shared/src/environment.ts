import * as Schema from "effect/Schema";

/**
 * Environment as reported by a node's driver. Phase 2 extended the minimal
 * phase-1 shape with the container/volume identity and published ports the
 * docker driver derives from labels; phase 3 (lifecycle) builds on it.
 */
export const EnvironmentState = Schema.Literals(["created", "running", "stopped"]);
export type EnvironmentState = typeof EnvironmentState.Type;

export const EnvironmentDescriptor = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  image: Schema.String,
  state: EnvironmentState,
  /** Runtime identifiers, present when a real container backs the environment. */
  containerId: Schema.optional(Schema.String),
  volumeName: Schema.optional(Schema.String),
});
export type EnvironmentDescriptor = typeof EnvironmentDescriptor.Type;

/**
 * What the controller sends to create an environment. Env vars are the
 * configuration hook (`T3CODE_*` server config, `T3ENV_*` bootstrap inputs,
 * `TS_AUTHKEY` for the tailnet join). Environments are reached over their
 * own tailnet HTTPS endpoint — no ports are published on the node.
 */
export const CreateEnvironmentSpec = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  image: Schema.String,
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
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

// --- controller-side environment model (phase 3) -----------------------------

/** What the operator wants: the environment exists and serves, or is gone. */
export const EnvironmentDesiredState = Schema.Literals(["running", "destroyed"]);
export type EnvironmentDesiredState = typeof EnvironmentDesiredState.Type;

/**
 * Persisted progress of the create step machine. Steps are re-runnable: a
 * controller restarted mid-create resumes from the recorded step and
 * converges (driver create/start are idempotent, health polling is a read,
 * session issue revokes stale controller sessions before issuing).
 */
export const EnvironmentCreateStep = Schema.Literals([
  "scheduled",
  "image-ready",
  "key-minted",
  "created",
  "started",
  "tailnet-joined",
  "healthy",
  "session-issued",
  "ready",
]);
export type EnvironmentCreateStep = typeof EnvironmentCreateStep.Type;

/** What the controller last observed about the environment. */
export const EnvironmentObservedState = Schema.Literals([
  "creating",
  "running",
  "unreachable",
  "error",
  "destroying",
  "destroyed",
]);
export type EnvironmentObservedState = typeof EnvironmentObservedState.Type;

/**
 * Activity summary derived from `GET /api/orchestration/snapshot`, persisted
 * with every status poll. Deliberately carries enough for phase 7's idle
 * predicate: a turn currently running and the moment anything last changed.
 */
export const EnvironmentActivity = Schema.Struct({
  threadCount: Schema.Int,
  /** Threads whose latest turn is in state `running`. */
  runningTurnCount: Schema.Int,
  /** ISO timestamp of the most recently updated thread, if any. */
  lastThreadUpdatedAt: Schema.NullOr(Schema.String),
  /** ISO timestamp of the snapshot itself (`OrchestrationReadModel.updatedAt`). */
  snapshotUpdatedAt: Schema.String,
});
export type EnvironmentActivity = typeof EnvironmentActivity.Type;

/**
 * The environment as served by the controller's inventory API
 * (`GET /api/environments`); the phase-6 dashboard consumes this shape.
 * Never carries secrets — the T3 admin session lives in the vault.
 */
export const EnvironmentSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  nodeId: Schema.String,
  gitUrl: Schema.String,
  gitBranch: Schema.NullOr(Schema.String),
  imageReference: Schema.String,
  desiredState: EnvironmentDesiredState,
  createStep: EnvironmentCreateStep,
  observedState: EnvironmentObservedState,
  /**
   * Base URL clients reach the T3 server at: the environment's own tailnet
   * HTTPS endpoint (`https://env-<id>.<tailnet>.ts.net`), recorded once the
   * device appears on the tailnet.
   */
  endpointUrl: Schema.NullOr(Schema.String),
  /** Tailscale device id backing the endpoint (deleted on destroy). */
  tailnetDeviceId: Schema.NullOr(Schema.String),
  /** The T3 server's own environment id, from the descriptor endpoint. */
  t3EnvironmentId: Schema.NullOr(Schema.String),
  /**
   * Human-readable progress note for slow mid-create waits (e.g. HTTPS
   * certificate issuance); null outside those windows.
   */
  statusDetail: Schema.NullOr(Schema.String),
  activity: Schema.NullOr(EnvironmentActivity),
  lastStatusAtMillis: Schema.NullOr(Schema.Number),
  error: Schema.NullOr(Schema.String),
  createdAtMillis: Schema.Number,
  updatedAtMillis: Schema.Number,
});
export type EnvironmentSummary = typeof EnvironmentSummary.Type;

/** A minted one-time pairing link. Returned once, never stored. */
export const PairingLink = Schema.Struct({
  /** Ready-to-open `<endpoint>/pair#token=...` URL. */
  url: Schema.String,
  expiresAt: Schema.String,
});
export type PairingLink = typeof PairingLink.Type;
