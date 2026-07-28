import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AgentConfig } from "./Config.ts";
import * as Connection from "./Connection.ts";
import { CredentialStore } from "./CredentialStore.ts";
import * as DockerDriver from "./driver/DockerDriver.ts";

const MainLayer = Layer.mergeAll(
  CredentialStore.layer,
  DockerDriver.layer,
  NodeSocket.layerWebSocketConstructor,
).pipe(Layer.provideMerge(AgentConfig.layerFromEnv), Layer.provideMerge(NodeServices.layer));

NodeRuntime.runMain(Connection.run.pipe(Effect.provide(MainLayer)));
