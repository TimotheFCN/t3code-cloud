import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Layer from "effect/Layer";

import { ControllerConfig } from "./Config.ts";
import * as Controller from "./Controller.ts";

NodeRuntime.runMain(
  Layer.launch(Controller.layer.pipe(Layer.provide(ControllerConfig.layerFromEnv))),
);
