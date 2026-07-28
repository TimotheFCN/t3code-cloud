import * as Schema from "effect/Schema";

/**
 * Point-in-time capacity snapshot reported by an agent with every heartbeat.
 * All byte counts are plain numbers (safe integers up to 2^53 cover realistic
 * hardware sizes).
 */
export const CapacitySnapshot = Schema.Struct({
  cpuCount: Schema.Int,
  loadAverage1m: Schema.Number,
  memoryTotalBytes: Schema.Number,
  memoryFreeBytes: Schema.Number,
  diskTotalBytes: Schema.Number,
  diskFreeBytes: Schema.Number,
});
export type CapacitySnapshot = typeof CapacitySnapshot.Type;
