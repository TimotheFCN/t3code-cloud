import type { EnvironmentDescriptor, EnvironmentState } from "@t3fleet/shared/environment";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Driver, EnvironmentNotFoundError, type CreateEnvironmentInput } from "./Driver.ts";

/**
 * In-memory driver used by tests (and as the placeholder wiring until the
 * phase-2 docker driver lands). State transitions mirror what the docker
 * driver will report: created -> running -> stopped, destroy removes.
 */
export const layer = Layer.sync(Driver)(() => {
  const environments = new Map<string, { name: string; image: string; state: EnvironmentState }>();

  const descriptor = (id: string): EnvironmentDescriptor => {
    const entry = environments.get(id)!;
    return { id, name: entry.name, image: entry.image, state: entry.state };
  };

  const require = (operation: string) =>
    Effect.fn(`FakeDriver.${operation}`)(function* (environmentId: string) {
      if (!environments.has(environmentId)) {
        return yield* new EnvironmentNotFoundError({ environmentId });
      }
    });

  return Driver.of({
    createEnvironment: Effect.fn("FakeDriver.createEnvironment")(function* (
      input: CreateEnvironmentInput,
    ) {
      environments.set(input.id, { name: input.name, image: input.image, state: "created" });
      return descriptor(input.id);
    }),
    startEnvironment: Effect.fn("FakeDriver.startEnvironment")(function* (environmentId: string) {
      yield* require("startEnvironment")(environmentId);
      environments.get(environmentId)!.state = "running";
      return descriptor(environmentId);
    }),
    stopEnvironment: Effect.fn("FakeDriver.stopEnvironment")(function* (environmentId: string) {
      yield* require("stopEnvironment")(environmentId);
      environments.get(environmentId)!.state = "stopped";
      return descriptor(environmentId);
    }),
    destroyEnvironment: Effect.fn("FakeDriver.destroyEnvironment")(function* (
      environmentId: string,
    ) {
      yield* require("destroyEnvironment")(environmentId);
      environments.delete(environmentId);
    }),
    execInEnvironment: Effect.fn("FakeDriver.execInEnvironment")(function* (
      environmentId: string,
      command: ReadonlyArray<string>,
    ) {
      yield* require("execInEnvironment")(environmentId);
      return { exitCode: 0, stdout: `fake-exec: ${command.join(" ")}`, stderr: "" };
    }),
    snapshotVolume: Effect.fn("FakeDriver.snapshotVolume")(function* (
      environmentId: string,
      destinationPath: string,
    ) {
      yield* require("snapshotVolume")(environmentId);
      return { path: destinationPath };
    }),
    listEnvironments: Effect.sync(() => [...environments.keys()].map((id) => descriptor(id))),
  });
});
