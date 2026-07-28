import type { NodeSummary } from "@t3fleet/shared/node";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { NodeRegistry } from "../nodes/NodeRegistry.ts";

export class NoSchedulableNodeError extends Schema.TaggedErrorClass<NoSchedulableNodeError>()(
  "NoSchedulableNodeError",
  {
    message: Schema.String,
  },
) {}

/**
 * Pure placement: an explicit node must be connected; otherwise pick the
 * connected node with the most free memory from its latest capacity snapshot
 * (simple bin-packing per `docs/fleet/architecture.md` §fleet-controller).
 * Nodes that never reported capacity sort last but remain eligible.
 */
export const place = (
  nodes: ReadonlyArray<NodeSummary>,
  connected: ReadonlySet<string>,
  explicitNodeId?: string,
): NodeSummary | NoSchedulableNodeError => {
  if (explicitNodeId !== undefined) {
    const node = nodes.find((candidate) => candidate.id === explicitNodeId);
    if (node === undefined) {
      return new NoSchedulableNodeError({ message: `node ${explicitNodeId} is not registered` });
    }
    if (!connected.has(node.id)) {
      return new NoSchedulableNodeError({ message: `node ${explicitNodeId} is not connected` });
    }
    return node;
  }
  const candidates = nodes
    .filter((candidate) => connected.has(candidate.id))
    .toSorted(
      (left, right) =>
        (right.capacity?.memoryFreeBytes ?? -1) - (left.capacity?.memoryFreeBytes ?? -1),
    );
  if (candidates[0] === undefined) {
    return new NoSchedulableNodeError({ message: "no connected nodes to schedule on" });
  }
  return candidates[0];
};

/** Picks the node a new environment is created on. */
export class Scheduler extends Context.Service<
  Scheduler,
  {
    readonly pick: (input?: {
      readonly nodeId?: string | undefined;
    }) => Effect.Effect<NodeSummary, NoSchedulableNodeError>;
  }
>()("t3fleet/controller/Scheduler") {
  static readonly layer = Layer.effect(
    Scheduler,
    Effect.gen(function* () {
      const registry = yield* NodeRegistry;

      const pick = Effect.fn("Scheduler.pick")(function* (input?: {
        readonly nodeId?: string | undefined;
      }) {
        const nodes = yield* registry.list;
        const connected = yield* SubscriptionRef.get(registry.connectedNodeIds);
        const placed = place(nodes, connected, input?.nodeId);
        if (placed instanceof NoSchedulableNodeError) {
          return yield* placed;
        }
        return placed;
      });

      return Scheduler.of({ pick });
    }),
  );
}
