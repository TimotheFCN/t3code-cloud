import * as Schema from "effect/Schema";

import { CapacitySnapshot } from "./capacity.ts";

export const NodeHealth = Schema.Literals(["online", "offline"]);
export type NodeHealth = typeof NodeHealth.Type;

/**
 * Node inventory entry as exposed by the controller HTTP API (and consumed by
 * the phase-6 dashboard). `health` is derived from `lastSeenAtMillis`: a node
 * is `online` when its last heartbeat is within ~3 heartbeat intervals.
 */
export const NodeSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  health: NodeHealth,
  connected: Schema.Boolean,
  protocolVersion: Schema.Int,
  lastSeenAtMillis: Schema.NullOr(Schema.Number),
  capacity: Schema.NullOr(CapacitySnapshot),
  createdAtMillis: Schema.Number,
});
export type NodeSummary = typeof NodeSummary.Type;
