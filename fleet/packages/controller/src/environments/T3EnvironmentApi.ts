import type { EnvironmentActivity } from "@t3fleet/shared/environment";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpBody from "effect/unstable/http/HttpBody";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

/**
 * The controller's HTTP surface onto a running T3 server — the only
 * steady-state channel after bootstrap (`architecture.md` §2). All
 * authenticated requests carry the vault-stored admin session as a bearer
 * token; the token never appears in errors or logs.
 */

export class T3RequestError extends Schema.TaggedErrorClass<T3RequestError>()("T3RequestError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

/** `GET /.well-known/t3/environment` — unauthenticated identity/liveness. */
const T3Descriptor = Schema.Struct({
  environmentId: Schema.String,
  label: Schema.String,
  serverVersion: Schema.String,
});
export type T3Descriptor = typeof T3Descriptor.Type;
const decodeDescriptor = Schema.decodeUnknownEffect(T3Descriptor);

/** The slice of `OrchestrationReadModel` the controller derives activity from. */
const T3Snapshot = Schema.Struct({
  threads: Schema.Array(
    Schema.Struct({
      updatedAt: Schema.String,
      latestTurn: Schema.NullOr(Schema.Struct({ state: Schema.String })),
    }),
  ),
  updatedAt: Schema.String,
});
const decodeSnapshot = Schema.decodeUnknownEffect(T3Snapshot);

/** `POST /api/auth/pairing-token` result (`AuthPairingCredentialResult`). */
const T3PairingCredential = Schema.Struct({
  id: Schema.String,
  credential: Schema.String,
  expiresAt: Schema.String,
});
export type T3PairingCredential = typeof T3PairingCredential.Type;
const decodePairingCredential = Schema.decodeUnknownEffect(T3PairingCredential);

const fail = (operation: string) => (cause: unknown) =>
  new T3RequestError({ operation, message: String(cause) });

const bearer = (token: Redacted.Redacted<string>) => ({
  authorization: `Bearer ${Redacted.value(token)}`,
});

const okJson =
  (operation: string, timeout: Duration.Input) =>
  <E>(
    response: Effect.Effect<HttpClientResponse.HttpClientResponse, E>,
  ): Effect.Effect<unknown, T3RequestError> =>
    Effect.gen(function* () {
      const result = yield* response.pipe(
        Effect.timeout(timeout),
        Effect.mapError(fail(operation)),
      );
      if (result.status < 200 || result.status >= 300) {
        return yield* new T3RequestError({
          operation,
          message: `unexpected status ${result.status}`,
        });
      }
      return yield* result.json.pipe(Effect.mapError(fail(operation)));
    });

export const fetchDescriptor = Effect.fn("T3EnvironmentApi.fetchDescriptor")(function* (
  client: HttpClient.HttpClient,
  endpointUrl: string,
) {
  const json = yield* okJson(
    "fetchDescriptor",
    "5 seconds",
  )(client.get(`${endpointUrl}/.well-known/t3/environment`));
  return yield* decodeDescriptor(json).pipe(Effect.mapError(fail("fetchDescriptor")));
});

export const fetchActivity = Effect.fn("T3EnvironmentApi.fetchActivity")(function* (
  client: HttpClient.HttpClient,
  endpointUrl: string,
  token: Redacted.Redacted<string>,
) {
  const json = yield* okJson(
    "fetchActivity",
    "10 seconds",
  )(client.get(`${endpointUrl}/api/orchestration/snapshot`, { headers: bearer(token) }));
  const snapshot = yield* decodeSnapshot(json).pipe(Effect.mapError(fail("fetchActivity")));
  const lastThreadUpdatedAt = snapshot.threads
    .map((thread) => thread.updatedAt)
    .toSorted()
    .at(-1);
  const activity: EnvironmentActivity = {
    threadCount: snapshot.threads.length,
    runningTurnCount: snapshot.threads.filter((thread) => thread.latestTurn?.state === "running")
      .length,
    lastThreadUpdatedAt: lastThreadUpdatedAt ?? null,
    snapshotUpdatedAt: snapshot.updatedAt,
  };
  return activity;
});

export const mintPairingCredential = Effect.fn("T3EnvironmentApi.mintPairingCredential")(function* (
  client: HttpClient.HttpClient,
  endpointUrl: string,
  token: Redacted.Redacted<string>,
  label: string,
) {
  const json = yield* okJson(
    "mintPairingCredential",
    "10 seconds",
  )(
    client.post(`${endpointUrl}/api/auth/pairing-token`, {
      headers: bearer(token),
      body: HttpBody.jsonUnsafe({ label }),
    }),
  );
  return yield* decodePairingCredential(json).pipe(Effect.mapError(fail("mintPairingCredential")));
});

/** Best-effort: revokes the controller's own session before destroy. */
export const revokeSession = Effect.fn("T3EnvironmentApi.revokeSession")(function* (
  client: HttpClient.HttpClient,
  endpointUrl: string,
  token: Redacted.Redacted<string>,
  sessionId: string,
) {
  yield* okJson(
    "revokeSession",
    "10 seconds",
  )(
    client.post(`${endpointUrl}/api/auth/clients/revoke`, {
      headers: bearer(token),
      body: HttpBody.jsonUnsafe({ sessionId }),
    }),
  );
});
