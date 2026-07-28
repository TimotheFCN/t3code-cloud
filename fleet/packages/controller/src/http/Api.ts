import { ImagePullResult, ImageSummary } from "@t3fleet/shared/image";
import { NodeSummary } from "@t3fleet/shared/node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "effect/unstable/httpapi";

import { ImageAlreadyExistsError, ImageNotFoundError, Images } from "../images/Images.ts";
import { ImagePulls } from "../images/ImagePulls.ts";
import { JoinTokens } from "../nodes/JoinTokens.ts";
import { NodeRegistry } from "../nodes/NodeRegistry.ts";

const SystemGroup = HttpApiGroup.make("system").add(
  HttpApiEndpoint.get("health", "/healthz", {
    success: Schema.Struct({ status: Schema.Literal("ok") }),
  }),
);

const NodesGroup = HttpApiGroup.make("nodes").add(
  HttpApiEndpoint.get("list", "/api/nodes", {
    success: Schema.Array(NodeSummary),
  }),
);

const JoinTokensGroup = HttpApiGroup.make("joinTokens").add(
  HttpApiEndpoint.post("create", "/api/join-tokens", {
    payload: Schema.Struct({
      ttlSeconds: Schema.optional(
        Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 86_400 })),
      ),
    }),
    success: Schema.Struct({
      /** Plaintext join token — returned exactly once, only its hash is stored. */
      token: Schema.String,
      expiresAtMillis: Schema.Number,
    }),
  }),
);

const ImageNotFound = ImageNotFoundError.pipe(HttpApiSchema.status(404));
const ImageAlreadyExists = ImageAlreadyExistsError.pipe(HttpApiSchema.status(409));

const ImagesGroup = HttpApiGroup.make("images").add(
  HttpApiEndpoint.get("list", "/api/images", {
    success: Schema.Array(ImageSummary),
  }),
  HttpApiEndpoint.post("register", "/api/images", {
    payload: Schema.Struct({ reference: Schema.String }),
    success: ImageSummary,
    error: ImageAlreadyExists,
  }),
  HttpApiEndpoint.post("setCurrent", "/api/images/:id/current", {
    params: { id: Schema.String },
    success: ImageSummary,
    error: ImageNotFound,
  }),
  HttpApiEndpoint.post("pull", "/api/images/:id/pull", {
    params: { id: Schema.String },
    payload: Schema.Struct({
      /** Pull on one node; omitted = every connected node. */
      nodeId: Schema.optional(Schema.String),
    }),
    success: Schema.Struct({ results: Schema.Array(ImagePullResult) }),
    error: ImageNotFound,
  }),
);

export class FleetApi extends HttpApi.make("fleet")
  .add(SystemGroup)
  .add(NodesGroup)
  .add(JoinTokensGroup)
  .add(ImagesGroup) {}

const SystemHandlers = HttpApiBuilder.group(
  FleetApi,
  "system",
  Effect.fn(function* (handlers) {
    return handlers.handle("health", () => Effect.succeed({ status: "ok" as const }));
  }),
);

const NodesHandlers = HttpApiBuilder.group(
  FleetApi,
  "nodes",
  Effect.fn(function* (handlers) {
    const registry = yield* NodeRegistry;
    return handlers.handle("list", () => registry.list);
  }),
);

const JoinTokensHandlers = HttpApiBuilder.group(
  FleetApi,
  "joinTokens",
  Effect.fn(function* (handlers) {
    const joinTokens = yield* JoinTokens;
    return handlers.handle("create", ({ payload }) =>
      Effect.gen(function* () {
        const minted = yield* joinTokens.mint(
          payload.ttlSeconds === undefined ? undefined : { ttlSeconds: payload.ttlSeconds },
        );
        return { token: Redacted.value(minted.token), expiresAtMillis: minted.expiresAtMillis };
      }),
    );
  }),
);

const ImagesHandlers = HttpApiBuilder.group(
  FleetApi,
  "images",
  Effect.fn(function* (handlers) {
    const images = yield* Images;
    const pulls = yield* ImagePulls;
    return handlers
      .handle("list", () => images.list)
      .handle("register", ({ payload }) => images.register({ reference: payload.reference }))
      .handle("setCurrent", ({ params }) => images.setCurrent(params.id))
      .handle("pull", ({ params, payload }) =>
        pulls
          .pull({ imageId: params.id, nodeId: payload.nodeId })
          .pipe(Effect.map((results) => ({ results }))),
      );
  }),
);

/** All HTTP API routes (health, node inventory, join tokens, images). */
export const layer = HttpApiBuilder.layer(FleetApi).pipe(
  Layer.provide([SystemHandlers, NodesHandlers, JoinTokensHandlers, ImagesHandlers]),
);
