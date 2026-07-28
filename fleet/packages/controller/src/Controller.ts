import { createServer } from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import { ControllerConfig } from "./Config.ts";
import * as Database from "./db/Database.ts";
import { Environments } from "./environments/Environments.ts";
import { EnvironmentsRepo } from "./environments/EnvironmentsRepo.ts";
import { PairingLinks } from "./environments/PairingLinks.ts";
import { Scheduler } from "./environments/Scheduler.ts";
import { StatusPoller } from "./environments/StatusPoller.ts";
import { Events } from "./events/Events.ts";
import * as Api from "./http/Api.ts";
import * as AgentSocket from "./http/AgentSocket.ts";
import { ImagePulls } from "./images/ImagePulls.ts";
import { Images } from "./images/Images.ts";
import { AgentConnections } from "./nodes/AgentConnections.ts";
import { JoinTokens } from "./nodes/JoinTokens.ts";
import { NodeRegistry } from "./nodes/NodeRegistry.ts";
import { Vault } from "./vault/Vault.ts";

/** HTTP API routes plus the agent WebSocket endpoint. */
export const Routes = Layer.mergeAll(Api.layer, AgentSocket.layer);

/**
 * Controller domain services. Requires `SqlClient` and `ControllerConfig`;
 * exposes every service so tests and the composed server share one wiring.
 */
export const Services = Layer.mergeAll(
  ImagePulls.layer,
  Environments.layer,
  PairingLinks.layer,
  StatusPoller.layer,
).pipe(
  Layer.provideMerge(Scheduler.layer),
  Layer.provideMerge(Layer.mergeAll(NodeRegistry.layer, Images.layer, EnvironmentsRepo.layer)),
  Layer.provideMerge(Layer.mergeAll(JoinTokens.layer, Events.layer, AgentConnections.layer)),
  Layer.provideMerge(Layer.mergeAll(Vault.layer, FetchHttpClient.layer)),
);

const HttpServerFromConfig = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ControllerConfig;
    return NodeHttpServer.layer(createServer, { port: config.port, host: config.host });
  }),
);

/**
 * The whole controller: HTTP server (API + agent socket), domain services,
 * SQLite database with migrations. Requires only `ControllerConfig`.
 */
export const layer = HttpRouter.serve(Routes).pipe(
  Layer.provideMerge(Services),
  Layer.provideMerge(Database.layerFromConfig),
  Layer.provideMerge(HttpServerFromConfig),
);
