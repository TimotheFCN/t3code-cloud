import type {
  CreateEnvironmentSpec,
  EnvironmentDescriptor,
  EnvironmentState,
  ExecResult,
  PortBinding,
} from "@t3fleet/shared/environment";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Driver, DriverError, EnvironmentNotFoundError } from "./Driver.ts";

export interface FakeDriverOptions {
  /**
   * Resolves the host port for a published container port (the docker
   * driver's ephemeral-port behavior). Defaults to the container port
   * itself. Lifecycle tests point this at a real local test server.
   */
  readonly resolveHostPort?: (containerPort: number) => number;
  /**
   * Overrides exec results per command; returning `undefined` falls back to
   * the default echo behavior. Lifecycle tests emulate `t3 auth ...` output
   * with this.
   */
  readonly exec?: (environmentId: string, command: ReadonlyArray<string>) => ExecResult | undefined;
  /** Observes every create spec (tests assert env vars / port publications). */
  readonly onCreate?: (spec: CreateEnvironmentSpec) => void;
}

interface FakeEnvironment {
  name: string;
  image: string;
  state: EnvironmentState;
  publishPorts: ReadonlyArray<PortBinding>;
}

/**
 * In-memory driver used by tests (and as placeholder wiring where no Docker
 * daemon exists). Mirrors the docker driver's contract: created -> running ->
 * stopped, destroy removes, create adopts an existing id, restore requires a
 * stopped environment, published ports resolve while running.
 *
 * `makeService` builds a standalone service value whose state outlives layer
 * builds — tests reuse one across "agent restarts" the way real nodes keep
 * their containers across controller restarts.
 */
export const makeService = (options: FakeDriverOptions = {}): Driver["Service"] => {
  const environments = new Map<string, FakeEnvironment>();
  const resolveHostPort = options.resolveHostPort ?? ((containerPort: number) => containerPort);

  const descriptor = (id: string): EnvironmentDescriptor => {
    const entry = environments.get(id)!;
    const ports =
      entry.state === "running"
        ? entry.publishPorts.map((port) => ({
            containerPort: port.containerPort,
            hostPort: port.hostPort ?? resolveHostPort(port.containerPort),
          }))
        : [];
    return {
      id,
      name: entry.name,
      image: entry.image,
      state: entry.state,
      ...(ports.length > 0 ? { ports } : {}),
    };
  };

  const require = (operation: string) =>
    Effect.fn(`FakeDriver.${operation}`)(function* (environmentId: string) {
      if (!environments.has(environmentId)) {
        return yield* new EnvironmentNotFoundError({ environmentId });
      }
    });

  return Driver.of({
    pullImage: Effect.fn("FakeDriver.pullImage")(function* (reference: string) {
      return { reference, digest: `${reference}@sha256:${"0".repeat(64)}` };
    }),
    createEnvironment: Effect.fn("FakeDriver.createEnvironment")(function* (
      spec: CreateEnvironmentSpec,
    ) {
      options.onCreate?.(spec);
      if (!environments.has(spec.id)) {
        environments.set(spec.id, {
          name: spec.name,
          image: spec.image,
          state: "created",
          publishPorts: spec.publishPorts ?? [],
        });
      }
      return descriptor(spec.id);
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
      const overridden = options.exec?.(environmentId, command);
      if (overridden !== undefined) {
        return overridden;
      }
      return { exitCode: 0, stdout: `fake-exec: ${command.join(" ")}`, stderr: "" };
    }),
    snapshotVolume: Effect.fn("FakeDriver.snapshotVolume")(function* (environmentId: string) {
      yield* require("snapshotVolume")(environmentId);
      const now = yield* Clock.currentTimeMillis;
      return {
        path: `/fake/snapshots/${environmentId}/${now}.tar.gz`,
        createdAtMillis: now,
        sizeBytes: 0,
      };
    }),
    restoreVolume: Effect.fn("FakeDriver.restoreVolume")(function* (
      environmentId: string,
      snapshotPath: string,
    ) {
      yield* require("restoreVolume")(environmentId);
      if (environments.get(environmentId)!.state === "running") {
        return yield* new DriverError({
          operation: "restoreVolume",
          message: `environment ${environmentId} must be stopped before restoring ${snapshotPath}`,
        });
      }
    }),
    listEnvironments: Effect.sync(() => [...environments.keys()].map((id) => descriptor(id))),
  });
};

export const make = (options: FakeDriverOptions = {}) =>
  Layer.sync(Driver)(() => makeService(options));

export const layer = make();
