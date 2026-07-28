import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { Driver } from "./Driver.ts";
import * as FakeDriver from "./FakeDriver.ts";

describe("FakeDriver", () => {
  it.effect("implements the environment lifecycle contract", () =>
    Effect.gen(function* () {
      const driver = yield* Driver;

      expect(yield* driver.listEnvironments).toEqual([]);

      const created = yield* driver.createEnvironment({
        id: "env-1",
        name: "one",
        image: "t3env:test",
      });
      expect(created.state).toBe("created");

      const started = yield* driver.startEnvironment("env-1");
      expect(started.state).toBe("running");

      const exec = yield* driver.execInEnvironment("env-1", ["echo", "hello"]);
      expect(exec.exitCode).toBe(0);
      expect(exec.stdout).toContain("echo hello");

      const snapshot = yield* driver.snapshotVolume("env-1", "/tmp/snap.tar");
      expect(snapshot.path).toBe("/tmp/snap.tar");

      const stopped = yield* driver.stopEnvironment("env-1");
      expect(stopped.state).toBe("stopped");

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
