import * as Schema from "effect/Schema";

import { CapacitySnapshot } from "./capacity.ts";
import {
  CreateEnvironmentSpec,
  EnvironmentDescriptor,
  ExecResult,
  PulledImage,
  VolumeSnapshot,
} from "./environment.ts";

/**
 * Controller <-> agent WebSocket protocol.
 *
 * JSON text frames, schema-validated on both sides. The first frame on every
 * connection is an agent->controller `hello`; the controller answers with
 * `welcome` or `rejected` (and closes). After a successful handshake:
 *
 * - controller->agent commands are `req` frames with correlation `id`s,
 *   answered by agent `res` frames carrying the same `id`,
 * - agent->controller streams are `event` frames (heartbeat today; status,
 *   logs, stats in later phases).
 */
export const PROTOCOL_VERSION = 1;

/** Path of the controller's agent WebSocket endpoint. */
export const AGENT_SOCKET_PATH = "/ws/agent";

// --- handshake -------------------------------------------------------------

export const JoinTokenAuth = Schema.Struct({
  method: Schema.Literal("join-token"),
  joinToken: Schema.String,
});

export const CredentialAuth = Schema.Struct({
  method: Schema.Literal("credential"),
  nodeId: Schema.String,
  credential: Schema.String,
});

export const AgentHello = Schema.Struct({
  kind: Schema.Literal("hello"),
  protocolVersion: Schema.Int,
  nodeName: Schema.String,
  /**
   * Host clients and the controller can reach this node's published container
   * ports at (phase-3 node-port endpoints). Optional: the controller falls
   * back to the connection's remote address. Phase 4 replaces node-port
   * endpoints with per-environment tailnet URLs.
   */
  endpointHost: Schema.optional(Schema.String),
  auth: Schema.Union([JoinTokenAuth, CredentialAuth]),
});
export type AgentHello = typeof AgentHello.Type;

export const ControllerWelcome = Schema.Struct({
  kind: Schema.Literal("welcome"),
  nodeId: Schema.String,
  /** Present only when the agent joined with a token: shown exactly once. */
  credential: Schema.optional(Schema.String),
  heartbeatIntervalMillis: Schema.Int,
});
export type ControllerWelcome = typeof ControllerWelcome.Type;

export const RejectionReason = Schema.Literals([
  "protocol-mismatch",
  "invalid-token",
  "invalid-credential",
]);
export type RejectionReason = typeof RejectionReason.Type;

export const ControllerRejected = Schema.Struct({
  kind: Schema.Literal("rejected"),
  reason: RejectionReason,
  message: Schema.String,
});
export type ControllerRejected = typeof ControllerRejected.Type;

// --- agent -> controller events ---------------------------------------------

export const HeartbeatEvent = Schema.Struct({
  kind: Schema.Literal("event"),
  type: Schema.Literal("heartbeat"),
  payload: CapacitySnapshot,
});
export type HeartbeatEvent = typeof HeartbeatEvent.Type;

// --- controller -> agent requests / agent responses -------------------------

export const PingRequest = Schema.Struct({
  kind: Schema.Literal("req"),
  id: Schema.String,
  type: Schema.Literal("ping"),
});
export type PingRequest = typeof PingRequest.Type;

export const ListEnvironmentsRequest = Schema.Struct({
  kind: Schema.Literal("req"),
  id: Schema.String,
  type: Schema.Literal("list-environments"),
});
export type ListEnvironmentsRequest = typeof ListEnvironmentsRequest.Type;

// Driver commands (phase 2). Each request carries a typed payload; the
// response payload schema for each type is listed below the envelope.

export const PullImageRequest = Schema.Struct({
  kind: Schema.Literal("req"),
  id: Schema.String,
  type: Schema.Literal("pull-image"),
  payload: Schema.Struct({ reference: Schema.String }),
});
export type PullImageRequest = typeof PullImageRequest.Type;

export const CreateEnvironmentRequest = Schema.Struct({
  kind: Schema.Literal("req"),
  id: Schema.String,
  type: Schema.Literal("create-environment"),
  payload: CreateEnvironmentSpec,
});
export type CreateEnvironmentRequest = typeof CreateEnvironmentRequest.Type;

export const StartEnvironmentRequest = Schema.Struct({
  kind: Schema.Literal("req"),
  id: Schema.String,
  type: Schema.Literal("start-environment"),
  payload: Schema.Struct({ environmentId: Schema.String }),
});
export type StartEnvironmentRequest = typeof StartEnvironmentRequest.Type;

export const StopEnvironmentRequest = Schema.Struct({
  kind: Schema.Literal("req"),
  id: Schema.String,
  type: Schema.Literal("stop-environment"),
  payload: Schema.Struct({ environmentId: Schema.String }),
});
export type StopEnvironmentRequest = typeof StopEnvironmentRequest.Type;

export const DestroyEnvironmentRequest = Schema.Struct({
  kind: Schema.Literal("req"),
  id: Schema.String,
  type: Schema.Literal("destroy-environment"),
  payload: Schema.Struct({ environmentId: Schema.String }),
});
export type DestroyEnvironmentRequest = typeof DestroyEnvironmentRequest.Type;

export const ExecEnvironmentRequest = Schema.Struct({
  kind: Schema.Literal("req"),
  id: Schema.String,
  type: Schema.Literal("exec-environment"),
  payload: Schema.Struct({
    environmentId: Schema.String,
    command: Schema.Array(Schema.String),
  }),
});
export type ExecEnvironmentRequest = typeof ExecEnvironmentRequest.Type;

export const SnapshotVolumeRequest = Schema.Struct({
  kind: Schema.Literal("req"),
  id: Schema.String,
  type: Schema.Literal("snapshot-volume"),
  payload: Schema.Struct({ environmentId: Schema.String }),
});
export type SnapshotVolumeRequest = typeof SnapshotVolumeRequest.Type;

export const ControllerRequest = Schema.Union([
  PingRequest,
  ListEnvironmentsRequest,
  PullImageRequest,
  CreateEnvironmentRequest,
  StartEnvironmentRequest,
  StopEnvironmentRequest,
  DestroyEnvironmentRequest,
  ExecEnvironmentRequest,
  SnapshotVolumeRequest,
]);
export type ControllerRequest = typeof ControllerRequest.Type;

/**
 * A request without its envelope fields — what callers of
 * `AgentConnections.request` supply; the correlation `id` is generated there.
 */
export type ControllerRequestBody = {
  [K in ControllerRequest["type"]]: Omit<Extract<ControllerRequest, { type: K }>, "kind" | "id">;
}[ControllerRequest["type"]];

/**
 * Response payloads are `Unknown` in the envelope; the requesting side decodes
 * the payload with the schema matching the request `type` (see
 * `PongPayload` / `ListEnvironmentsPayload`).
 */
export const AgentResponseOk = Schema.Struct({
  kind: Schema.Literal("res"),
  id: Schema.String,
  ok: Schema.Literal(true),
  payload: Schema.Unknown,
});
export type AgentResponseOk = typeof AgentResponseOk.Type;

export const AgentResponseError = Schema.Struct({
  kind: Schema.Literal("res"),
  id: Schema.String,
  ok: Schema.Literal(false),
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
  }),
});
export type AgentResponseError = typeof AgentResponseError.Type;

export const AgentResponse = Schema.Union([AgentResponseOk, AgentResponseError]);
export type AgentResponse = typeof AgentResponse.Type;

export const PongPayload = Schema.Struct({
  pong: Schema.Literal(true),
});
export type PongPayload = typeof PongPayload.Type;

export const ListEnvironmentsPayload = Schema.Struct({
  environments: Schema.Array(EnvironmentDescriptor),
});
export type ListEnvironmentsPayload = typeof ListEnvironmentsPayload.Type;

export const PullImagePayload = PulledImage;
export type PullImagePayload = typeof PullImagePayload.Type;

export const EnvironmentPayload = EnvironmentDescriptor;
export type EnvironmentPayload = typeof EnvironmentPayload.Type;

export const DestroyEnvironmentPayload = Schema.Struct({
  destroyed: Schema.Literal(true),
});
export type DestroyEnvironmentPayload = typeof DestroyEnvironmentPayload.Type;

export const ExecEnvironmentPayload = ExecResult;
export type ExecEnvironmentPayload = typeof ExecEnvironmentPayload.Type;

export const SnapshotVolumePayload = VolumeSnapshot;
export type SnapshotVolumePayload = typeof SnapshotVolumePayload.Type;

// --- wire unions -------------------------------------------------------------

export const AgentToController = Schema.Union([AgentHello, HeartbeatEvent, AgentResponse]);
export type AgentToController = typeof AgentToController.Type;

export const ControllerToAgent = Schema.Union([
  ControllerWelcome,
  ControllerRejected,
  ControllerRequest,
]);
export type ControllerToAgent = typeof ControllerToAgent.Type;

/** Codecs between wire JSON strings and typed messages. */
export const AgentToControllerFromString = Schema.fromJsonString(AgentToController);
export const ControllerToAgentFromString = Schema.fromJsonString(ControllerToAgent);

export const decodeAgentToController = Schema.decodeUnknownEffect(AgentToControllerFromString);
export const encodeAgentToController = Schema.encodeUnknownEffect(AgentToControllerFromString);
export const decodeControllerToAgent = Schema.decodeUnknownEffect(ControllerToAgentFromString);
export const encodeControllerToAgent = Schema.encodeUnknownEffect(ControllerToAgentFromString);
