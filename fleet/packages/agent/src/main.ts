import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AgentConfig } from "./Config.ts";
import * as Connection from "./Connection.ts";
import { CredentialStore } from "./CredentialStore.ts";
import * as FakeDriver from "./driver/FakeDriver.ts";

// The FakeDriver placeholder is replaced by the docker driver in phase 2.
const MainLayer = Layer.mergeAll(
  CredentialStore.layer,
  FakeDriver.layer,
  NodeSocket.layerWebSocketConstructor,
).pipe(Layer.provideMerge(AgentConfig.layerFromEnv));

NodeRuntime.runMain(Connection.run.pipe(Effect.provide(MainLayer)));
