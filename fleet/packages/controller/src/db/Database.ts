import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";

import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ControllerConfig } from "../Config.ts";
import * as Migrator from "./Migrator.ts";

/**
 * Provides `SqlClient` for the controller database and runs pending
 * migrations while the layer is built.
 */
export const layer = (options: { readonly filename: string }) =>
  Layer.effectDiscard(Migrator.run()).pipe(
    Layer.provideMerge(SqliteClient.layer({ filename: options.filename })),
  );

/** In-memory database for tests. */
export const layerMemory = layer({ filename: ":memory:" });

/** Database under `<dataDir>/controller.sqlite`, creating the directory. */
export const layerFromConfig = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ControllerConfig;
    yield* Effect.promise(() => NodeFs.mkdir(config.dataDir, { recursive: true }));
    return layer({ filename: NodePath.join(config.dataDir, "controller.sqlite") });
  }),
);
