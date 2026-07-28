import { describe, expect, it } from "@effect/vitest";
import type { CapacitySnapshot } from "@t3fleet/shared/capacity";
import type { NodeSummary } from "@t3fleet/shared/node";

import { NoSchedulableNodeError, place } from "./Scheduler.ts";

const capacity = (memoryFreeBytes: number): CapacitySnapshot => ({
  cpuCount: 8,
  loadAverage1m: 0.5,
  memoryTotalBytes: 64e9,
  memoryFreeBytes,
  diskTotalBytes: 1e12,
  diskFreeBytes: 5e11,
});

const node = (id: string, memoryFreeBytes: number | null): NodeSummary => ({
  id,
  name: id,
  protocolVersion: 1,
  health: "online",
  connected: true,
  lastSeenAtMillis: 0,
  capacity: memoryFreeBytes === null ? null : capacity(memoryFreeBytes),
  createdAtMillis: 0,
});

describe("Scheduler.place", () => {
  it("bin-packs on free memory: picks the connected node with the most", () => {
    const nodes = [node("node-a", 2e9), node("node-b", 8e9), node("node-c", 4e9)];
    const connected = new Set(["node-a", "node-b", "node-c"]);
    const placed = place(nodes, connected);
    expect(placed).toMatchObject({ id: "node-b" });
  });

  it("ignores disconnected nodes even when they have the most free memory", () => {
    const nodes = [node("node-a", 2e9), node("node-b", 8e9)];
    const connected = new Set(["node-a"]);
    const placed = place(nodes, connected);
    expect(placed).toMatchObject({ id: "node-a" });
  });

  it("nodes without a capacity snapshot sort last but stay eligible", () => {
    const nodes = [node("node-a", null), node("node-b", 1)];
    const connected = new Set(["node-a", "node-b"]);
    expect(place(nodes, connected)).toMatchObject({ id: "node-b" });

    const onlyUnknown = place([node("node-a", null)], new Set(["node-a"]));
    expect(onlyUnknown).toMatchObject({ id: "node-a" });
  });

  it("honors an explicit connected node regardless of free memory", () => {
    const nodes = [node("node-a", 2e9), node("node-b", 8e9)];
    const connected = new Set(["node-a", "node-b"]);
    const placed = place(nodes, connected, "node-a");
    expect(placed).toMatchObject({ id: "node-a" });
  });

  it("rejects an explicit node that is unknown or disconnected", () => {
    const nodes = [node("node-a", 2e9)];
    expect(place(nodes, new Set(["node-a"]), "node-x")).toBeInstanceOf(NoSchedulableNodeError);
    expect(place(nodes, new Set<string>(), "node-a")).toBeInstanceOf(NoSchedulableNodeError);
  });

  it("fails when no node is connected", () => {
    const nodes = [node("node-a", 2e9)];
    expect(place(nodes, new Set<string>())).toBeInstanceOf(NoSchedulableNodeError);
  });
});
