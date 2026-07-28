import {
  AGENT_SOCKET_PATH,
  type AgentHello,
  type AgentToController,
  type ControllerRequest,
  decodeControllerToAgent,
  type DestroyEnvironmentPayload,
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
import { Driver, type DriverError, type EnvironmentNotFoundError } from "./driver/Driver.ts";
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

  const helloBase = {
    kind: "hello",
    protocolVersion: PROTOCOL_VERSION,
    nodeName: config.nodeName,
    ...(Option.isSome(config.advertiseHost) ? { endpointHost: config.advertiseHost.value } : {}),
  } as const;

  const buildHello = Effect.gen(function* () {
    const stored = yield* store.load;
    if (Option.isSome(stored)) {
      const hello: AgentHello = {
        ...helloBase,
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
        ...helloBase,
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

    /**
     * Runs a driver operation and answers the request: success payload on
     * `ok`, typed error codes for the two driver failure modes.
     */
    const respondDriver = <A>(
      requestId: string,
      operation: Effect.Effect<A, DriverError | EnvironmentNotFoundError>,
    ) =>
      operation.pipe(
        Effect.flatMap((payload) => write({ kind: "res", id: requestId, ok: true, payload })),
        Effect.catchTag("DriverError", (error) =>
          write({
            kind: "res",
            id: requestId,
            ok: false,
            error: { code: "driver-error", message: error.message },
          }),
        ),
        Effect.catchTag("EnvironmentNotFoundError", (error) =>
          write({
            kind: "res",
            id: requestId,
            ok: false,
            error: {
              code: "environment-not-found",
              message: `environment ${error.environmentId} not found on this node`,
            },
          }),
        ),
      );

    const respond = (request: ControllerRequest) =>
      Effect.gen(function* () {
        switch (request.type) {
          case "ping": {
            const payload: PongPayload = { pong: true };
            return yield* write({ kind: "res", id: request.id, ok: true, payload });
          }
          case "list-environments": {
            return yield* respondDriver(
              request.id,
              driver.listEnvironments.pipe(
                Effect.map((environments): ListEnvironmentsPayload => ({ environments })),
              ),
            );
          }
          case "pull-image": {
            return yield* respondDriver(request.id, driver.pullImage(request.payload.reference));
          }
          case "create-environment": {
            return yield* respondDriver(request.id, driver.createEnvironment(request.payload));
          }
          case "start-environment": {
            return yield* respondDriver(
              request.id,
              driver.startEnvironment(request.payload.environmentId),
            );
          }
          case "stop-environment": {
            return yield* respondDriver(
              request.id,
              driver.stopEnvironment(request.payload.environmentId),
            );
          }
          case "destroy-environment": {
            return yield* respondDriver(
              request.id,
              driver
                .destroyEnvironment(request.payload.environmentId)
                .pipe(Effect.map((): DestroyEnvironmentPayload => ({ destroyed: true }))),
            );
          }
          case "exec-environment": {
            return yield* respondDriver(
              request.id,
              driver.execInEnvironment(request.payload.environmentId, request.payload.command),
            );
          }
          case "snapshot-volume": {
            return yield* respondDriver(
              request.id,
              driver.snapshotVolume(request.payload.environmentId),
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
