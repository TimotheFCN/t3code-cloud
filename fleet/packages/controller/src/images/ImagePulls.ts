import type { ImagePullResult } from "@t3fleet/shared/image";
import { PullImagePayload } from "@t3fleet/shared/protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { Events } from "../events/Events.ts";
import { AgentConnections } from "../nodes/AgentConnections.ts";
import { NodeRegistry } from "../nodes/NodeRegistry.ts";
import { ImageNotFoundError, Images } from "./Images.ts";

const decodePullPayload = Schema.decodeUnknownEffect(PullImagePayload);

/** Pulls can move gigabytes over homelab links; allow minutes, not seconds. */
const PULL_TIMEOUT = "10 minutes";

/**
 * Controller-side image pull orchestration: instructs one node (or every
 * connected node) to `docker pull` a registered image, records the digest
 * the first successful node reports, and logs the outcome per node. Node
 * failures are reported, never thrown — a fleet-wide pull is best-effort
 * per node.
 */
export class ImagePulls extends Context.Service<
  ImagePulls,
  {
    readonly pull: (input: {
      readonly imageId: string;
      readonly nodeId?: string | undefined;
    }) => Effect.Effect<ReadonlyArray<ImagePullResult>, ImageNotFoundError>;
  }
>()("t3fleet/controller/ImagePulls") {
  static readonly layer = Layer.effect(
    ImagePulls,
    Effect.gen(function* () {
      const images = yield* Images;
      const registry = yield* NodeRegistry;
      const connections = yield* AgentConnections;
      const events = yield* Events;

      const pullOnNode = Effect.fn("ImagePulls.pullOnNode")(function* (
        nodeId: string,
        reference: string,
      ) {
        const payload = yield* connections.request(
          nodeId,
          { type: "pull-image", payload: { reference } },
          { timeout: PULL_TIMEOUT },
        );
        return yield* decodePullPayload(payload);
      });

      const pull = Effect.fn("ImagePulls.pull")(function* (input: {
        readonly imageId: string;
        readonly nodeId?: string | undefined;
      }) {
        const image = yield* images.get(input.imageId);
        const targets =
          input.nodeId === undefined
            ? [...(yield* SubscriptionRef.get(registry.connectedNodeIds))]
            : [input.nodeId];

        const results: Array<ImagePullResult> = [];
        for (const nodeId of targets) {
          const result: ImagePullResult = yield* pullOnNode(nodeId, image.reference).pipe(
            Effect.map((pulled): ImagePullResult => ({ nodeId, ok: true, digest: pulled.digest })),
            Effect.catch((error) =>
              Effect.succeed<ImagePullResult>({
                nodeId,
                ok: false,
                error: `${error._tag}: ${"message" in error ? error.message : String(error)}`,
              }),
            ),
          );
          results.push(result);
          yield* events.append({
            kind: result.ok ? "image-pulled" : "image-pull-failed",
            nodeId,
            payload: { imageId: image.id, reference: image.reference, ...result },
          });
        }

        const digest = results.find((result) => result.ok && result.digest != null)?.digest;
        if (digest != null) {
          yield* images.recordDigest({ imageId: image.id, digest }).pipe(Effect.orDie);
        }
        return results;
      });

      return ImagePulls.of({ pull });
    }),
  );
}
