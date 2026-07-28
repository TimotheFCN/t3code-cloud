import * as Schema from "effect/Schema";

import { CapacitySnapshot } from "./capacity.ts";
import { EnvironmentDescriptor } from "./environment.ts";

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

export const ControllerRequest = Schema.Union([PingRequest, ListEnvironmentsRequest]);
export type ControllerRequest = typeof ControllerRequest.Type;

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
