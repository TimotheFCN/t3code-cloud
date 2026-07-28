import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { Driver } from "./Driver.ts";
import * as FakeDriver from "./FakeDriver.ts";

describe("FakeDriver", () => {
  it.effect("implements the environment lifecycle contract", () =>
    Effect.gen(function* () {
      const driver = yield* Driver;

      expect(yield* driver.listEnvironments).toEqual([]);

      const pulled = yield* driver.pullImage("t3env:test");
      expect(pulled.reference).toBe("t3env:test");
      expect(pulled.digest).toContain("sha256:");

      const created = yield* driver.createEnvironment({
        id: "env-1",
        name: "one",
        image: "t3env:test",
      });
      expect(created.state).toBe("created");

      // Create is idempotent per id: a retry adopts, never duplicates.
      const adopted = yield* driver.createEnvironment({
        id: "env-1",
        name: "one",
        image: "t3env:test",
      });
      expect(adopted).toEqual(created);
      expect(yield* driver.listEnvironments).toHaveLength(1);

      const started = yield* driver.startEnvironment("env-1");
      expect(started.state).toBe("running");

      const exec = yield* driver.execInEnvironment("env-1", ["echo", "hello"]);
      expect(exec.exitCode).toBe(0);
      expect(exec.stdout).toContain("echo hello");

      const snapshot = yield* driver.snapshotVolume("env-1");
      expect(snapshot.path).toContain("env-1");

      // Restoring a running environment is refused.
      const refused = yield* driver.restoreVolume("env-1", snapshot.path).pipe(Effect.flip);
      expect(refused._tag).toBe("DriverError");

      const stopped = yield* driver.stopEnvironment("env-1");
      expect(stopped.state).toBe("stopped");

      yield* driver.restoreVolume("env-1", snapshot.path);

      yield* driver.destroyEnvironment("env-1");
      expect(yield* driver.listEnvironments).toEqual([]);
    }).pipe(Effect.provide(FakeDriver.layer)),
  );

  it.effect("fails on unknown environments", () =>
    Effect.gen(function* () {
      const driver = yield* Driver;
      const outcome = yield* driver.startEnvironment("env-missing").pipe(Effect.flip);
      expect(outcome._tag).toBe("EnvironmentNotFoundError");
    }).pipe(Effect.provide(FakeDriver.layer)),
  );
});
