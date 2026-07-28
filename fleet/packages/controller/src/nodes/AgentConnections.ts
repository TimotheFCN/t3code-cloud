import * as NodeCrypto from "node:crypto";

import type {
  AgentResponse,
  ControllerRequest,
  ControllerRequestBody,
  ControllerToAgent,
} from "@t3fleet/shared/protocol";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class NodeNotConnectedError extends Schema.TaggedErrorClass<NodeNotConnectedError>()(
  "NodeNotConnectedError",
  {
    nodeId: Schema.String,
  },
) {}

export class AgentRequestError extends Schema.TaggedErrorClass<AgentRequestError>()(
  "AgentRequestError",
  {
    nodeId: Schema.String,
    code: Schema.String,
    message: Schema.String,
  },
) {}

export class AgentRequestTimeoutError extends Schema.TaggedErrorClass<AgentRequestTimeoutError>()(
  "AgentRequestTimeoutError",
  {
    nodeId: Schema.String,
    requestType: Schema.String,
  },
) {}

interface Connection {
  readonly write: (message: ControllerToAgent) => Effect.Effect<void>;
  readonly pending: Map<string, Deferred.Deferred<unknown, AgentRequestError>>;
}

/**
 * Live agent connections and the correlation-id request/response machinery.
 * The socket endpoint registers a writer per joined node; `request` sends a
 * `req` frame and resolves when the matching `res` frame arrives.
 */
export class AgentConnections extends Context.Service<
  AgentConnections,
  {
    readonly register: (
      nodeId: string,
      write: (message: ControllerToAgent) => Effect.Effect<void>,
    ) => Effect.Effect<void>;
    readonly unregister: (nodeId: string) => Effect.Effect<void>;
    readonly handleResponse: (nodeId: string, response: AgentResponse) => Effect.Effect<void>;
    readonly request: (
      nodeId: string,
      body: ControllerRequestBody,
      options?: { readonly timeout?: Duration.Input },
    ) => Effect.Effect<
      unknown,
      NodeNotConnectedError | AgentRequestError | AgentRequestTimeoutError
    >;
  }
>()("t3fleet/controller/AgentConnections") {
  static readonly layer = Layer.sync(AgentConnections)(() => {
    const connections = new Map<string, Connection>();

    const register = (nodeId: string, write: (message: ControllerToAgent) => Effect.Effect<void>) =>
      Effect.sync(() => {
        connections.set(nodeId, { write, pending: new Map() });
      });

    const unregister = (nodeId: string) =>
      Effect.gen(function* () {
        const connection = connections.get(nodeId);
        if (connection === undefined) {
          return;
        }
        connections.delete(nodeId);
        for (const [requestId, deferred] of connection.pending) {
          connection.pending.delete(requestId);
          yield* Deferred.fail(
            deferred,
            new AgentRequestError({ nodeId, code: "disconnected", message: "agent disconnected" }),
          );
        }
      });

    const handleResponse = (nodeId: string, response: AgentResponse) =>
      Effect.gen(function* () {
        const connection = connections.get(nodeId);
        const deferred = connection?.pending.get(response.id);
        if (connection === undefined || deferred === undefined) {
          return;
        }
        connection.pending.delete(response.id);
        if (response.ok) {
          yield* Deferred.succeed(deferred, response.payload);
        } else {
          yield* Deferred.fail(
            deferred,
            new AgentRequestError({
              nodeId,
              code: response.error.code,
              message: response.error.message,
            }),
          );
        }
      });

    const request = Effect.fn("AgentConnections.request")(function* (
      nodeId: string,
      body: ControllerRequestBody,
      options?: { readonly timeout?: Duration.Input },
    ) {
      const connection = connections.get(nodeId);
      if (connection === undefined) {
        return yield* new NodeNotConnectedError({ nodeId });
      }
      const requestId = NodeCrypto.randomUUID();
      const deferred = yield* Deferred.make<unknown, AgentRequestError>();
      connection.pending.set(requestId, deferred);
      yield* connection.write({ kind: "req", id: requestId, ...body } as ControllerRequest);
      return yield* Deferred.await(deferred).pipe(
        Effect.timeoutOrElse({
          // Driver commands (image pulls, stops, snapshots) can legitimately
          // take minutes; callers set a timeout fitting the operation.
          duration: options?.timeout ?? Duration.seconds(10),
          orElse: () =>
            Effect.sync(() => connection.pending.delete(requestId)).pipe(
              Effect.andThen(new AgentRequestTimeoutError({ nodeId, requestType: body.type })),
            ),
        }),
        Effect.onInterrupt(() => Effect.sync(() => connection.pending.delete(requestId))),
      );
    });

    return AgentConnections.of({ register, unregister, handleResponse, request });
  });
}
