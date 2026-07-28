import { EnvironmentSummary, PairingLink } from "@t3fleet/shared/environment";
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

import { Environments, NoCurrentImageError } from "../environments/Environments.ts";
import { EnvironmentRecordNotFoundError } from "../environments/EnvironmentsRepo.ts";
import {
  EnvironmentNotReadyError,
  PairingLinks,
  PairingMintError,
} from "../environments/PairingLinks.ts";
import { NoSchedulableNodeError } from "../environments/Scheduler.ts";
import { ImageAlreadyExistsError, ImageNotFoundError, Images } from "../images/Images.ts";
import { ImagePulls } from "../images/ImagePulls.ts";
import { JoinTokens } from "../nodes/JoinTokens.ts";
import { NodeRegistry } from "../nodes/NodeRegistry.ts";
import { TailnetNotConfiguredError } from "../tailnet/Tailnet.ts";
import { TailnetSettings } from "../tailnet/TailnetSettings.ts";
import { VaultError } from "../vault/Vault.ts";

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

const EnvironmentNotFound = EnvironmentRecordNotFoundError.pipe(HttpApiSchema.status(404));
const EnvironmentNotReady = EnvironmentNotReadyError.pipe(HttpApiSchema.status(409));
const PairingMintFailed = PairingMintError.pipe(HttpApiSchema.status(502));
const NoSchedulableNode = NoSchedulableNodeError.pipe(HttpApiSchema.status(409));
const NoCurrentImage = NoCurrentImageError.pipe(HttpApiSchema.status(409));
const TailnetNotConfigured = TailnetNotConfiguredError.pipe(HttpApiSchema.status(409));
const VaultFailure = VaultError.pipe(HttpApiSchema.status(500));

/** Non-secret view of the Tailscale OAuth configuration. */
const TailscaleSettingsView = Schema.Struct({
  configured: Schema.Boolean,
  clientId: Schema.NullOr(Schema.String),
  tag: Schema.String,
});

const SettingsGroup = HttpApiGroup.make("settings").add(
  HttpApiEndpoint.get("tailscale", "/api/settings/tailscale", {
    success: TailscaleSettingsView,
  }),
  // Stores/replaces the Tailscale OAuth client. The secret goes through the
  // vault seam; it is accepted here once and never returned by any endpoint.
  HttpApiEndpoint.put("tailscaleUpdate", "/api/settings/tailscale", {
    payload: Schema.Struct({
      clientId: Schema.String.check(Schema.isMinLength(1)),
      clientSecret: Schema.String.check(Schema.isMinLength(1)),
      /** ACL tag minted keys carry; defaults to `tag:t3-env`. */
      tag: Schema.optional(Schema.String),
    }),
    success: TailscaleSettingsView,
    error: VaultFailure,
  }),
);

const EnvironmentsGroup = HttpApiGroup.make("environments").add(
  HttpApiEndpoint.get("list", "/api/environments", {
    success: Schema.Array(EnvironmentSummary),
  }),
  // Returns immediately with the persisted record; the create step machine
  // continues in the background — poll `GET /api/environments/:id`.
  HttpApiEndpoint.post("create", "/api/environments", {
    payload: Schema.Struct({
      gitUrl: Schema.String,
      gitBranch: Schema.optional(Schema.String),
      nodeId: Schema.optional(Schema.String),
      name: Schema.optional(Schema.String),
    }),
    success: EnvironmentSummary,
    error: [NoSchedulableNode, NoCurrentImage, TailnetNotConfigured],
  }),
  HttpApiEndpoint.get("get", "/api/environments/:id", {
    params: { id: Schema.String },
    success: EnvironmentSummary,
    error: EnvironmentNotFound,
  }),
  HttpApiEndpoint.post("pairingLink", "/api/environments/:id/pairing-link", {
    params: { id: Schema.String },
    success: PairingLink,
    error: [EnvironmentNotFound, EnvironmentNotReady, PairingMintFailed],
  }),
  HttpApiEndpoint.post("destroy", "/api/environments/:id/destroy", {
    params: { id: Schema.String },
    payload: Schema.Struct({
      /** Archive uncommitted work into controller storage before destroying. */
      archive: Schema.optional(Schema.Boolean),
    }),
    success: EnvironmentSummary,
    error: EnvironmentNotFound,
  }),
);

export class FleetApi extends HttpApi.make("fleet")
  .add(SystemGroup)
  .add(NodesGroup)
  .add(JoinTokensGroup)
  .add(ImagesGroup)
  .add(EnvironmentsGroup)
  .add(SettingsGroup) {}

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

const SettingsHandlers = HttpApiBuilder.group(
  FleetApi,
  "settings",
  Effect.fn(function* (handlers) {
    const settings = yield* TailnetSettings;
    return handlers
      .handle("tailscale", () => settings.status)
      .handle("tailscaleUpdate", ({ payload }) =>
        settings.configure({
          clientId: payload.clientId,
          clientSecret: Redacted.make(payload.clientSecret),
          tag: payload.tag,
        }),
      );
  }),
);

const EnvironmentsHandlers = HttpApiBuilder.group(
  FleetApi,
  "environments",
  Effect.fn(function* (handlers) {
    const environments = yield* Environments;
    const pairingLinks = yield* PairingLinks;
    return handlers
      .handle("list", () => environments.list)
      .handle("create", ({ payload }) =>
        environments.create({
          gitUrl: payload.gitUrl,
          gitBranch: payload.gitBranch,
          nodeId: payload.nodeId,
          name: payload.name,
        }),
      )
      .handle("get", ({ params }) => environments.get(params.id))
      .handle("pairingLink", ({ params }) => pairingLinks.mint(params.id))
      .handle("destroy", ({ params, payload }) =>
        environments.destroy(params.id, { archive: payload.archive }),
      );
  }),
);

/** All HTTP API routes (health, nodes, join tokens, images, environments, settings). */
export const layer = HttpApiBuilder.layer(FleetApi).pipe(
  Layer.provide([
    SystemHandlers,
    NodesHandlers,
    JoinTokensHandlers,
    ImagesHandlers,
    EnvironmentsHandlers,
    SettingsHandlers,
  ]),
);
