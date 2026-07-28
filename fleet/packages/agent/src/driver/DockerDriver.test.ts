import { execFileSync } from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { AgentConfig, type AgentConfigShape } from "../Config.ts";
import { containerName, volumeName } from "./DockerDriver.ts";
import * as DockerDriver from "./DockerDriver.ts";
import { Driver } from "./Driver.ts";

/**
 * These tests exercise the driver against a real local Docker daemon and are
 * skipped when none is available (CI without Docker, contributors without
 * the daemon running). The sysbox runtime is intentionally NOT required:
 * the tests configure `runc` explicitly, which validates everything except
 * the sysbox flag itself (verified manually on a sysbox-capable host).
 */
const dockerAvailable = (() => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const HELPER_IMAGE = "alpine:3.22";
const TEST_IMAGE = "t3fleet-driver-test:latest";
// Exits promptly on SIGTERM so `docker stop` does not hit the 10s kill timeout.
const TEST_IMAGE_DOCKERFILE = `FROM ${HELPER_IMAGE}\nENTRYPOINT ["sh", "-c", "trap 'exit 0' TERM INT; while true; do sleep 1; done"]\n`;

const runId = NodeCrypto.randomBytes(4).toString("hex");
const envId = (suffix: string) => `p2test-${runId}-${suffix}`;
const createdEnvIds: Array<string> = [];

const docker = (args: ReadonlyArray<string>) =>
  execFileSync("docker", [...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });

let stateDir = "";

const makeConfig = (overrides?: Partial<AgentConfigShape>): AgentConfigShape => ({
  controllerUrl: "ws://unused-in-driver-tests",
  nodeName: "driver-test-node",
  stateDir,
  joinToken: Option.none(),
  dockerRuntime: "runc",
  snapshotRetention: 2,
  helperImage: HELPER_IMAGE,
  ...overrides,
});

/** A fresh driver layer per call — building two of them simulates an agent restart. */
const driverLayer = (overrides?: Partial<AgentConfigShape>) =>
  DockerDriver.layer.pipe(
    Layer.provideMerge(AgentConfig.layer(makeConfig(overrides))),
    Layer.provideMerge(NodeServices.layer),
  );

const track = (id: string) => {
  createdEnvIds.push(id);
  return id;
};

describe.skipIf(!dockerAvailable)("DockerDriver (real Docker)", () => {
  beforeAll(async () => {
    stateDir = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "fleet-driver-test-"));
    execFileSync("docker", ["pull", HELPER_IMAGE], { stdio: "ignore" });
    execFileSync("docker", ["build", "-t", TEST_IMAGE, "-"], {
      input: TEST_IMAGE_DOCKERFILE,
      stdio: ["pipe", "ignore", "ignore"],
    });
  }, 120_000);

  afterAll(async () => {
    for (const id of createdEnvIds) {
      try {
        execFileSync("docker", ["rm", "-f", containerName(id)], { stdio: "ignore" });
      } catch {
        // already removed
      }
      try {
        execFileSync("docker", ["volume", "rm", "-f", volumeName(id)], { stdio: "ignore" });
      } catch {
        // already removed
      }
    }
    await NodeFs.rm(stateDir, { recursive: true, force: true });
  });

  it.live(
    "runs the full lifecycle with labels, env vars, and published ports",
    () =>
      Effect.gen(function* () {
        const driver = yield* Driver;
        const id = track(envId("lifecycle"));

        const created = yield* driver.createEnvironment({
          id,
          name: "lifecycle-env",
          image: TEST_IMAGE,
          env: { T3FLEET_TEST_VALUE: "hello-fleet" },
          publishPorts: [{ containerPort: 8080 }],
        });
        expect(created.id).toBe(id);
        expect(created.name).toBe("lifecycle-env");
        expect(created.image).toBe(TEST_IMAGE);
        expect(created.state).toBe("created");
        expect(created.containerId).toBeDefined();
        expect(created.volumeName).toBe(volumeName(id));

        // The volume really exists and carries the environment label.
        const volumeInfo = docker(["volume", "inspect", volumeName(id)]);
        expect(volumeInfo).toContain(`"t3fleet.environment-id": "${id}"`);

        const started = yield* driver.startEnvironment(id);
        expect(started.state).toBe("running");
        // An ephemeral host port was resolved for the published container port.
        const binding = started.ports?.find((port) => port.containerPort === 8080);
        expect(binding?.hostPort).toBeGreaterThan(0);

        // Env vars injected at create reach processes inside.
        const env = yield* driver.execInEnvironment(id, ["printenv", "T3FLEET_TEST_VALUE"]);
        expect(env.exitCode).toBe(0);
        expect(env.stdout.trim()).toBe("hello-fleet");

        const stopped = yield* driver.stopEnvironment(id);
        expect(stopped.state).toBe("stopped");

        yield* driver.destroyEnvironment(id);
        const remaining = yield* driver.listEnvironments;
        expect(remaining.find((environment) => environment.id === id)).toBeUndefined();
        // Container and volume are gone from Docker itself.
        expect(() => docker(["container", "inspect", containerName(id)])).toThrow();
        expect(() => docker(["volume", "inspect", volumeName(id)])).toThrow();
      }).pipe(Effect.provide(driverLayer())),
    120_000,
  );

  it.live(
    "reconciles state from labels across agent restarts",
    () =>
      Effect.gen(function* () {
        const id = track(envId("reconcile"));

        // "First agent process" creates and starts the environment.
        yield* Effect.gen(function* () {
          const driver = yield* Driver;
          yield* driver.createEnvironment({ id, name: "reconcile-env", image: TEST_IMAGE });
          yield* driver.startEnvironment(id);
        }).pipe(Effect.provide(driverLayer()));

        // An unmanaged container without fleet labels must never be adopted.
        const unmanagedName = `p2test-${runId}-unmanaged`;
        docker(["run", "-d", "--name", unmanagedName, TEST_IMAGE]);

        try {
          // "Restarted agent": a fresh driver derives everything from labels.
          yield* Effect.gen(function* () {
            const driver = yield* Driver;
            const environments = yield* driver.listEnvironments;
            const adopted = environments.find((environment) => environment.id === id);
            expect(adopted).toBeDefined();
            expect(adopted!.state).toBe("running");
            expect(adopted!.name).toBe("reconcile-env");
            expect(environments.every((environment) => environment.id !== "")).toBe(true);

            // A retried create adopts instead of duplicating.
            const readopted = yield* driver.createEnvironment({
              id,
              name: "reconcile-env",
              image: TEST_IMAGE,
            });
            expect(readopted.containerId).toBe(adopted!.containerId);

            // The restarted agent can keep operating the adopted environment.
            const stopped = yield* driver.stopEnvironment(id);
            expect(stopped.state).toBe("stopped");
            yield* driver.destroyEnvironment(id);
          }).pipe(Effect.provide(driverLayer()));
        } finally {
          docker(["rm", "-f", unmanagedName]);
        }
      }),
    120_000,
  );

  it.live(
    "exec round-trips stdout, stderr, and the exit code",
    () =>
      Effect.gen(function* () {
        const driver = yield* Driver;
        const id = track(envId("exec"));
        yield* driver.createEnvironment({ id, name: "exec-env", image: TEST_IMAGE });
        yield* driver.startEnvironment(id);

        const result = yield* driver.execInEnvironment(id, [
          "sh",
          "-c",
          "echo to-stdout; echo to-stderr >&2; exit 3",
        ]);
        expect(result.exitCode).toBe(3);
        expect(result.stdout.trim()).toBe("to-stdout");
        expect(result.stderr.trim()).toBe("to-stderr");

        // Exec against a stopped environment is a driver error, not exit-code noise.
        yield* driver.stopEnvironment(id);
        const refused = yield* driver.execInEnvironment(id, ["true"]).pipe(Effect.flip);
        expect(refused._tag).toBe("DriverError");

        yield* driver.destroyEnvironment(id);
      }).pipe(Effect.provide(driverLayer())),
    120_000,
  );

  it.live(
    "snapshots and restores the environment volume with retention",
    () =>
      Effect.gen(function* () {
        const driver = yield* Driver;
        const id = track(envId("snapshot"));
        yield* driver.createEnvironment({ id, name: "snapshot-env", image: TEST_IMAGE });
        yield* driver.startEnvironment(id);

        yield* driver.execInEnvironment(id, ["sh", "-c", "echo v1 > /root/data.txt"]);
        const snapshot = yield* driver.snapshotVolume(id);
        expect(snapshot.sizeBytes).toBeGreaterThan(0);

        // Mutate after the snapshot, then roll back.
        yield* driver.execInEnvironment(id, ["sh", "-c", "echo v2 > /root/data.txt"]);
        yield* driver.stopEnvironment(id);
        yield* driver.restoreVolume(id, snapshot.path);
        yield* driver.startEnvironment(id);
        const restored = yield* driver.execInEnvironment(id, ["cat", "/root/data.txt"]);
        expect(restored.stdout.trim()).toBe("v1");

        // Restoring a running environment is refused.
        const refused = yield* driver.restoreVolume(id, snapshot.path).pipe(Effect.flip);
        expect(refused._tag).toBe("DriverError");

        // Retention (2 in this config): a third snapshot prunes the oldest.
        yield* driver.snapshotVolume(id);
        yield* driver.snapshotVolume(id);
        const snapshotDir = NodePath.join(stateDir, "snapshots", id);
        const entries = (yield* Effect.promise(() => NodeFs.readdir(snapshotDir))).filter((entry) =>
          entry.endsWith(".tar.gz"),
        );
        expect(entries).toHaveLength(2);

        yield* driver.stopEnvironment(id);
        yield* driver.destroyEnvironment(id);
      }).pipe(Effect.provide(driverLayer())),
    120_000,
  );

  it.live(
    "fails loudly when the configured runtime is missing — no privileged fallback",
    () =>
      Effect.gen(function* () {
        const driver = yield* Driver;
        const id = envId("missing-runtime");
        const outcome = yield* driver
          .createEnvironment({ id, name: "no-runtime", image: TEST_IMAGE })
          .pipe(Effect.flip);
        expect(outcome._tag).toBe("DriverError");
        const message = outcome._tag === "DriverError" ? outcome.message : "";
        expect(message).toContain("t3fleet-test-absent-runtime");
        expect(message).toContain("sysbox");
        expect(message).toContain("never falls back");
      }).pipe(Effect.provide(driverLayer({ dockerRuntime: "t3fleet-test-absent-runtime" }))),
    60_000,
  );

  it.live(
    "fails on unknown environments and destroys leftovers idempotently",
    () =>
      Effect.gen(function* () {
        const driver = yield* Driver;
        const missing = yield* driver.startEnvironment("env-does-not-exist").pipe(Effect.flip);
        expect(missing._tag).toBe("EnvironmentNotFoundError");

        // A volume orphaned by an interrupted destroy is still cleaned up.
        const id = track(envId("orphan"));
        yield* driver.createEnvironment({ id, name: "orphan-env", image: TEST_IMAGE });
        docker(["rm", "-f", containerName(id)]);
        yield* driver.destroyEnvironment(id);
        expect(() => docker(["volume", "inspect", volumeName(id)])).toThrow();

        const gone = yield* driver.destroyEnvironment(id).pipe(Effect.flip);
        expect(gone._tag).toBe("EnvironmentNotFoundError");
      }).pipe(Effect.provide(driverLayer())),
    60_000,
  );

  it.live(
    "pulls an image and reports its digest",
    () =>
      Effect.gen(function* () {
        const driver = yield* Driver;
        const pulled = yield* driver.pullImage(HELPER_IMAGE);
        expect(pulled.reference).toBe(HELPER_IMAGE);
        expect(pulled.digest).toContain("sha256:");
      }).pipe(Effect.provide(driverLayer())),
    120_000,
  );
});
