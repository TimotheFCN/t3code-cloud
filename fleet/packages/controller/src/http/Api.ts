import { NodeSummary } from "@t3fleet/shared/node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

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

export class FleetApi extends HttpApi.make("fleet")
  .add(SystemGroup)
  .add(NodesGroup)
  .add(JoinTokensGroup) {}

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

/** All HTTP API routes (health, node inventory, join tokens). */
export const layer = HttpApiBuilder.layer(FleetApi).pipe(
  Layer.provide([SystemHandlers, NodesHandlers, JoinTokensHandlers]),
);
