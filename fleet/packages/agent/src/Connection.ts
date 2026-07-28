import {
  AGENT_SOCKET_PATH,
  type AgentHello,
  type AgentToController,
  type ControllerRequest,
  decodeControllerToAgent,
  encodeAgentToController,
  type ListEnvironmentsPayload,
  PROTOCOL_VERSION,
  type PongPayload,
} from "@t3fleet/shared/protocol";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Socket from "effect/unstable/socket/Socket";

import { AgentConfig } from "./Config.ts";
import { CredentialStore } from "./CredentialStore.ts";
import { Driver } from "./driver/Driver.ts";
import * as Heartbeat from "./Heartbeat.ts";

/** The controller refused the handshake; retrying cannot help. */
export class AgentRejectedError extends Schema.TaggedErrorClass<AgentRejectedError>()(
  "AgentRejectedError",
  {
    reason: Schema.String,
    message: Schema.String,
  },
) {}

/** First join needs a join token, reconnects need the stored credential. */
export class MissingJoinTokenError extends Schema.TaggedErrorClass<MissingJoinTokenError>()(
  "MissingJoinTokenError",
  {
    message: Schema.String,
  },
) {}

/** Converts the configured controller origin into the agent WebSocket URL. */
export const agentSocketUrl = (controllerUrl: string): string => {
  const url = new URL(controllerUrl);
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }
  url.pathname = AGENT_SOCKET_PATH;
  return url.toString();
};

const reconnectBackoff = Schedule.exponential("500 millis").pipe(
  Schedule.jittered,
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(30))),
  ),
);

/**
 * The agent's main loop: dial the controller, handshake (join token on first
 * connect, stored credential afterwards), persist the issued credential,
 * heartbeat at the interval the controller dictates, and answer controller
 * requests. Reconnects forever with jittered exponential backoff, capped at
 * 30 seconds; a handshake rejection is fatal.
 */
export const run = Effect.gen(function* () {
  const config = yield* AgentConfig;
  const store = yield* CredentialStore;
  const driver = yield* Driver;
  const wsUrl = agentSocketUrl(config.controllerUrl);

  const buildHello = Effect.gen(function* () {
    const stored = yield* store.load;
    if (Option.isSome(stored)) {
      const hello: AgentHello = {
        kind: "hello",
        protocolVersion: PROTOCOL_VERSION,
        nodeName: config.nodeName,
        auth: {
          method: "credential",
          nodeId: stored.value.nodeId,
          credential: Redacted.value(stored.value.credential),
        },
      };
      return hello;
    }
    if (Option.isSome(config.joinToken)) {
      const hello: AgentHello = {
        kind: "hello",
        protocolVersion: PROTOCOL_VERSION,
        nodeName: config.nodeName,
        auth: { method: "join-token", joinToken: Redacted.value(config.joinToken.value) },
      };
      return hello;
    }
    return yield* new MissingJoinTokenError({
      message:
        "no stored credential and no join token (FLEET_AGENT_JOIN_TOKEN) — cannot join the fleet",
    });
  });

  const connectOnce = Effect.gen(function* () {
    const hello = yield* buildHello;
    const socket = yield* Socket.makeWebSocket(wsUrl);
    const writeRaw = yield* socket.writer;
    const write = (message: AgentToController) =>
      encodeAgentToController(message).pipe(Effect.orDie, Effect.flatMap(writeRaw));

    let welcomed = false;

    const heartbeatLoop = (intervalMillis: number) =>
      Heartbeat.snapshotCapacity(config.stateDir).pipe(
        Effect.flatMap((capacity) =>
          write({ kind: "event", type: "heartbeat", payload: capacity }),
        ),
        Effect.repeat(Schedule.spaced(Duration.millis(intervalMillis))),
      );

    const respond = (request: ControllerRequest) =>
      Effect.gen(function* () {
        switch (request.type) {
          case "ping": {
            const payload: PongPayload = { pong: true };
            return yield* write({ kind: "res", id: request.id, ok: true, payload });
          }
          case "list-environments": {
            return yield* driver.listEnvironments.pipe(
              Effect.flatMap((environments) => {
                const payload: ListEnvironmentsPayload = { environments };
                return write({ kind: "res", id: request.id, ok: true, payload });
              }),
              Effect.catchTag("DriverError", (error) =>
                write({
                  kind: "res",
                  id: request.id,
                  ok: false,
                  error: { code: "driver-error", message: error.message },
                }),
              ),
            );
          }
        }
      });

    const handleMessage = (text: string) =>
      Effect.gen(function* () {
        const message = yield* decodeControllerToAgent(text).pipe(Effect.orDie);
        switch (message.kind) {
          case "welcome": {
            welcomed = true;
            if (message.credential !== undefined) {
              yield* store.save({
                nodeId: message.nodeId,
                credential: Redacted.make(message.credential),
              });
              yield* Effect.logInfo(`joined fleet as ${message.nodeId}, credential stored`);
            } else {
              yield* Effect.logInfo(`reconnected as ${message.nodeId}`);
            }
            // Forked into the connection scope: lives until the socket loop
            // ends, at which point it is interrupted with the scope.
            return yield* Effect.forkScoped(heartbeatLoop(message.heartbeatIntervalMillis));
          }
          case "rejected": {
            return yield* new AgentRejectedError({
              reason: message.reason,
              message: message.message,
            });
          }
          case "req": {
            return yield* respond(message);
          }
        }
      });

    yield* socket
      .runString(handleMessage, {
        onOpen: Effect.orDie(write(hello)),
      })
      .pipe(
        // A drop of an established connection counts as a clean end so the
        // outer retry backoff resets; failures before `welcome` propagate and
        // back off.
        Effect.catchIf(
          (error) => Socket.isSocketError(error) && welcomed,
          (error) => Effect.logWarning(`controller connection lost: ${String(error)}`),
        ),
      );
  }).pipe(Effect.scoped);

  yield* connectOnce.pipe(
    Effect.retry({
      while: (error) => error._tag === "SocketError",
      schedule: reconnectBackoff,
    }),
    Effect.repeat(Schedule.spaced("1 second")),
  );
});
