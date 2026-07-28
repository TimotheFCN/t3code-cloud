import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  type AgentToController,
  type ControllerToAgent,
  decodeAgentToController,
  decodeControllerToAgent,
  encodeAgentToController,
  encodeControllerToAgent,
  PROTOCOL_VERSION,
} from "./protocol.ts";

const capacity = {
  cpuCount: 8,
  loadAverage1m: 0.42,
  memoryTotalBytes: 32e9,
  memoryFreeBytes: 16e9,
  diskTotalBytes: 1e12,
  diskFreeBytes: 5e11,
};

describe("protocol envelope", () => {
  it.effect("round-trips every agent->controller message", () =>
    Effect.gen(function* () {
      const messages: ReadonlyArray<AgentToController> = [
        {
          kind: "hello",
          protocolVersion: PROTOCOL_VERSION,
          nodeName: "node-a",
          auth: { method: "join-token", joinToken: "fjt_test" },
        },
        {
          kind: "hello",
          protocolVersion: PROTOCOL_VERSION,
          nodeName: "node-a",
          auth: { method: "credential", nodeId: "node-1", credential: "fnc_test" },
        },
        {
          kind: "hello",
          protocolVersion: PROTOCOL_VERSION,
          nodeName: "node-a",
          endpointHost: "10.0.0.7",
          auth: { method: "credential", nodeId: "node-1", credential: "fnc_test" },
        },
        { kind: "event", type: "heartbeat", payload: capacity },
        { kind: "res", id: "r1", ok: true, payload: { pong: true } },
        { kind: "res", id: "r2", ok: false, error: { code: "driver-error", message: "boom" } },
        {
          kind: "res",
          id: "r3",
          ok: true,
          payload: {
            id: "env-1",
            name: "one",
            image: "t3env:test",
            state: "running",
            containerId: "abc",
            volumeName: "t3env-env-1-home",
            ports: [{ containerPort: 3773, hostPort: 32768 }],
          },
        },
        {
          kind: "res",
          id: "r4",
          ok: true,
          payload: { exitCode: 3, stdout: "out", stderr: "err" },
        },
      ];
      for (const message of messages) {
        const wire = yield* encodeAgentToController(message);
        expect(typeof wire).toBe("string");
        expect(yield* decodeAgentToController(wire)).toEqual(message);
      }
    }),
  );

  it.effect("round-trips every controller->agent message", () =>
    Effect.gen(function* () {
      const messages: ReadonlyArray<ControllerToAgent> = [
        {
          kind: "welcome",
          nodeId: "node-1",
          credential: "fnc_new",
          heartbeatIntervalMillis: 10_000,
        },
        { kind: "welcome", nodeId: "node-1", heartbeatIntervalMillis: 10_000 },
        { kind: "rejected", reason: "protocol-mismatch", message: "nope" },
        { kind: "req", id: "r1", type: "ping" },
        { kind: "req", id: "r2", type: "list-environments" },
        { kind: "req", id: "r3", type: "pull-image", payload: { reference: "t3env:0.1.0" } },
        {
          kind: "req",
          id: "r4",
          type: "create-environment",
          payload: {
            id: "env-1",
            name: "one",
            image: "t3env:0.1.0",
            env: { T3CODE_PORT: "3773" },
            publishPorts: [{ containerPort: 3773 }],
          },
        },
        { kind: "req", id: "r5", type: "start-environment", payload: { environmentId: "env-1" } },
        { kind: "req", id: "r6", type: "stop-environment", payload: { environmentId: "env-1" } },
        {
          kind: "req",
          id: "r7",
          type: "destroy-environment",
          payload: { environmentId: "env-1" },
        },
        {
          kind: "req",
          id: "r8",
          type: "exec-environment",
          payload: { environmentId: "env-1", command: ["echo", "hello"] },
        },
        { kind: "req", id: "r9", type: "snapshot-volume", payload: { environmentId: "env-1" } },
      ];
      for (const message of messages) {
        const wire = yield* encodeControllerToAgent(message);
        expect(yield* decodeControllerToAgent(wire)).toEqual(message);
      }
    }),
  );

  it.effect("rejects malformed frames", () =>
    Effect.gen(function* () {
      const outcome = yield* decodeAgentToController('{"kind":"nonsense"}').pipe(Effect.flip);
      expect(outcome._tag).toBe("SchemaError");
    }),
  );
});
