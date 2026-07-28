import {
  AGENT_SOCKET_PATH,
  type AgentHello,
  type ControllerToAgent,
  decodeAgentToController,
  encodeControllerToAgent,
  PROTOCOL_VERSION,
  type RejectionReason,
} from "@t3fleet/shared/protocol";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Socket from "effect/unstable/socket/Socket";

import { ControllerConfig } from "../Config.ts";
import { AgentConnections } from "../nodes/AgentConnections.ts";
import { NodeRegistry } from "../nodes/NodeRegistry.ts";

/** Internal signal that ends the read loop after a handshake rejection. */
class HandshakeRejected extends Schema.TaggedErrorClass<HandshakeRejected>()("HandshakeRejected", {
  reason: Schema.String,
}) {}

class ProtocolViolation extends Schema.TaggedErrorClass<ProtocolViolation>()("ProtocolViolation", {
  message: Schema.String,
}) {}

/** Node reports IPv4 peers of a dual-stack listener as `::ffff:a.b.c.d`. */
const stripPort = (address: string): string =>
  address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;

/**
 * The controller side of the agent protocol: accepts the WebSocket upgrade,
 * runs the hello handshake (join token or credential), then processes
 * heartbeat events and responses to controller requests until the socket
 * closes.
 */
export const layer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const registry = yield* NodeRegistry;
    const connections = yield* AgentConnections;
    const config = yield* ControllerConfig;

    const handleConnection = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const socket = yield* Effect.orDie(request.upgrade);
      const writeRaw = yield* socket.writer;
      const write = (message: ControllerToAgent) =>
        encodeControllerToAgent(message).pipe(Effect.orDie, Effect.flatMap(writeRaw), Effect.orDie);
      const reject = (reason: RejectionReason, message: string) =>
        Effect.gen(function* () {
          yield* write({ kind: "rejected", reason, message });
          yield* Effect.orDie(writeRaw(new Socket.CloseEvent(1008, reason)));
          return yield* new HandshakeRejected({ reason });
        });

      let joinedNodeId: string | null = null;

      const handleHello = (hello: AgentHello) =>
        Effect.gen(function* () {
          if (hello.protocolVersion !== PROTOCOL_VERSION) {
            return yield* reject(
              "protocol-mismatch",
              `controller speaks protocol version ${PROTOCOL_VERSION}, agent sent ${hello.protocolVersion}`,
            );
          }
          if (hello.auth.method === "join-token") {
            const joined = yield* registry
              .registerWithToken({
                token: hello.auth.joinToken,
                nodeName: hello.nodeName,
                protocolVersion: hello.protocolVersion,
              })
              .pipe(
                Effect.catchTag("InvalidJoinTokenError", (error) =>
                  reject("invalid-token", `join token rejected: ${error.reason}`),
                ),
              );
            joinedNodeId = joined.nodeId;
            yield* write({
              kind: "welcome",
              nodeId: joined.nodeId,
              credential: Redacted.value(joined.credential),
              heartbeatIntervalMillis: config.heartbeatIntervalMillis,
            });
          } else {
            const auth = hello.auth;
            yield* registry
              .authenticate({ nodeId: auth.nodeId, credential: auth.credential })
              .pipe(
                Effect.catchTag("InvalidCredentialError", () =>
                  reject("invalid-credential", "credential rejected"),
                ),
              );
            joinedNodeId = auth.nodeId;
            yield* write({
              kind: "welcome",
              nodeId: auth.nodeId,
              heartbeatIntervalMillis: config.heartbeatIntervalMillis,
            });
          }
          const nodeId = joinedNodeId;
          // Phase-3 node-port endpoints: record where this node's published
          // container ports are reachable. Agent-advertised host wins; the
          // connection's remote address is the fallback.
          const remoteHost = Option.map(request.remoteAddress, stripPort);
          const host = hello.endpointHost ?? Option.getOrNull(remoteHost);
          if (host !== null) {
            yield* registry.recordEndpointHost({ nodeId, host });
          }
          yield* connections.register(nodeId, write);
          yield* registry.markConnected(nodeId);
        });

      const handleMessage = (text: string) =>
        Effect.gen(function* () {
          const message = yield* decodeAgentToController(text).pipe(
            Effect.mapError(() => new ProtocolViolation({ message: "malformed frame" })),
          );
          if (joinedNodeId === null) {
            if (message.kind !== "hello") {
              return yield* new ProtocolViolation({
                message: `expected hello, got ${message.kind}`,
              });
            }
            return yield* handleHello(message);
          }
          switch (message.kind) {
            case "hello": {
              return yield* new ProtocolViolation({ message: "duplicate hello" });
            }
            case "event": {
              return yield* registry.recordHeartbeat({
                nodeId: joinedNodeId,
                capacity: message.payload,
              });
            }
            case "res": {
              return yield* connections.handleResponse(joinedNodeId, message);
            }
          }
        });

      yield* socket.runString(handleMessage).pipe(
        Effect.catchTag("SocketError", (error) => Effect.logDebug("agent socket closed", error)),
        Effect.catchTag("HandshakeRejected", (error) =>
          Effect.logInfo(`agent handshake rejected: ${error.reason}`),
        ),
        Effect.catchTag("ProtocolViolation", (error) =>
          Effect.logWarning(`agent protocol violation: ${error.message}`),
        ),
        Effect.ensuring(
          Effect.suspend(() =>
            joinedNodeId === null
              ? Effect.void
              : Effect.andThen(
                  connections.unregister(joinedNodeId),
                  registry.markDisconnected(joinedNodeId),
                ),
          ),
        ),
      );

      return HttpServerResponse.empty();
    });

    yield* router.add("GET", AGENT_SOCKET_PATH, handleConnection);
  }),
);
