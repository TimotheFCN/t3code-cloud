import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";

import type { CapacitySnapshot } from "@t3fleet/shared/capacity";
import * as Effect from "effect/Effect";

/**
 * Samples host capacity for the heartbeat: CPU count and 1-minute load from
 * `node:os`, disk totals from `statfs` on the given directory (the agent's
 * state dir — a proxy for the volume environments will live on).
 */
export const snapshotCapacity = Effect.fn("Heartbeat.snapshotCapacity")(function* (
  directory: string,
) {
  const disk = yield* Effect.tryPromise(() => NodeFs.statfs(directory)).pipe(
    Effect.orElseSucceed(() => null),
  );
  const capacity: CapacitySnapshot = {
    cpuCount: NodeOs.cpus().length,
    loadAverage1m: NodeOs.loadavg()[0] ?? 0,
    memoryTotalBytes: NodeOs.totalmem(),
    memoryFreeBytes: NodeOs.freemem(),
    diskTotalBytes: disk === null ? 0 : disk.bsize * disk.blocks,
    diskFreeBytes: disk === null ? 0 : disk.bsize * disk.bavail,
  };
  return capacity;
});
