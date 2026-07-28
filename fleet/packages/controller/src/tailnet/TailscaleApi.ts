import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpBody from "effect/unstable/http/HttpBody";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

/**
 * Thin typed layer over the Tailscale control API (v2) — exactly the four
 * operations Fleet needs: OAuth token exchange, tagged auth-key minting,
 * device lookup by hostname, and device/key deletion. The `-` tailnet alias
 * ("the tailnet of the authenticated credential") is used throughout, so no
 * tailnet name is ever configured.
 *
 * Secrets (`client_secret`, access tokens, minted keys) are `Redacted` and
 * never appear in error messages: failures carry the HTTP status and a
 * bounded slice of the response body only.
 */

export class TailscaleApiError extends Schema.TaggedErrorClass<TailscaleApiError>()(
  "TailscaleApiError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

const OauthTokenResponse = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.optional(Schema.Number),
});
const decodeOauthToken = Schema.decodeUnknownEffect(OauthTokenResponse);

const CreatedKeyResponse = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
});
const decodeCreatedKey = Schema.decodeUnknownEffect(CreatedKeyResponse);

const DevicesResponse = Schema.Struct({
  devices: Schema.Array(
    Schema.Struct({
      /** Legacy numeric id — accepted by the device endpoints. */
      id: Schema.String,
      /** Preferred stable identifier (`node-...`), present on current API versions. */
      nodeId: Schema.optional(Schema.String),
      hostname: Schema.String,
      /** MagicDNS FQDN, e.g. `env-a1b2c3d4.tail1234.ts.net`. */
      name: Schema.String,
    }),
  ),
});
const decodeDevices = Schema.decodeUnknownEffect(DevicesResponse);

export interface TailnetDevice {
  readonly deviceId: string;
  readonly hostname: string;
  /** MagicDNS FQDN the HTTPS endpoint is built from. */
  readonly name: string;
}

const fail = (operation: string) => (cause: unknown) =>
  new TailscaleApiError({ operation, message: String(cause) });

const bearer = (token: Redacted.Redacted<string>) => ({
  authorization: `Bearer ${Redacted.value(token)}`,
});

const okJson =
  (operation: string, timeout: Duration.Input) =>
  <E>(
    response: Effect.Effect<HttpClientResponse.HttpClientResponse, E>,
  ): Effect.Effect<unknown, TailscaleApiError> =>
    Effect.gen(function* () {
      const result = yield* response.pipe(
        Effect.timeout(timeout),
        Effect.mapError(fail(operation)),
      );
      if (result.status < 200 || result.status >= 300) {
        // The body of an error response never contains our secrets, but keep
        // it bounded — it is destined for logs and step errors.
        const body = yield* result.text.pipe(Effect.orElseSucceed(() => ""));
        return yield* new TailscaleApiError({
          operation,
          message: `Tailscale API returned ${result.status}: ${body.slice(0, 300)}`,
        });
      }
      return yield* result.json.pipe(Effect.mapError(fail(operation)));
    });

/** OAuth 2.0 client-credentials exchange: client id/secret -> access token. */
export const exchangeToken = Effect.fn("TailscaleApi.exchangeToken")(function* (
  client: HttpClient.HttpClient,
  baseUrl: string,
  clientId: string,
  clientSecret: Redacted.Redacted<string>,
) {
  const json = yield* okJson(
    "exchangeToken",
    "15 seconds",
  )(
    client.post(`${baseUrl}/api/v2/oauth/token`, {
      body: HttpBody.urlParams([
        ["grant_type", "client_credentials"],
        ["client_id", clientId],
        ["client_secret", Redacted.value(clientSecret)],
      ]),
    }),
  );
  const decoded = yield* decodeOauthToken(json).pipe(
    // The raw payload contains the access token — never surface it.
    Effect.mapError(
      () =>
        new TailscaleApiError({
          operation: "exchangeToken",
          message: "could not parse the OAuth token response",
        }),
    ),
  );
  return {
    accessToken: Redacted.make(decoded.access_token),
    expiresInSeconds: decoded.expires_in ?? 3600,
  };
});

/**
 * Mints one single-use, pre-authorized, **non-ephemeral** tagged auth key.
 * Non-ephemeral is deliberate: a suspended environment's device must not be
 * garbage-collected by Tailscale — Fleet deletes devices explicitly on
 * destroy.
 */
export const createAuthKey = Effect.fn("TailscaleApi.createAuthKey")(function* (
  client: HttpClient.HttpClient,
  baseUrl: string,
  token: Redacted.Redacted<string>,
  input: {
    readonly tag: string;
    readonly expirySeconds: number;
    readonly description: string;
  },
) {
  const json = yield* okJson(
    "createAuthKey",
    "15 seconds",
  )(
    client.post(`${baseUrl}/api/v2/tailnet/-/keys`, {
      headers: bearer(token),
      body: HttpBody.jsonUnsafe({
        capabilities: {
          devices: {
            create: {
              reusable: false,
              ephemeral: false,
              preauthorized: true,
              tags: [input.tag],
            },
          },
        },
        expirySeconds: input.expirySeconds,
        description: input.description,
      }),
    }),
  );
  const decoded = yield* decodeCreatedKey(json).pipe(
    // The raw payload contains the key — never surface it.
    Effect.mapError(
      () =>
        new TailscaleApiError({
          operation: "createAuthKey",
          message: "could not parse the created-key response",
        }),
    ),
  );
  return { keyId: decoded.id, key: Redacted.make(decoded.key) };
});

/** Finds a device by hostname (Tailscale lowercases device host names). */
export const findDeviceByHostname = Effect.fn("TailscaleApi.findDeviceByHostname")(function* (
  client: HttpClient.HttpClient,
  baseUrl: string,
  token: Redacted.Redacted<string>,
  hostname: string,
) {
  const json = yield* okJson(
    "findDeviceByHostname",
    "15 seconds",
  )(client.get(`${baseUrl}/api/v2/tailnet/-/devices`, { headers: bearer(token) }));
  const decoded = yield* decodeDevices(json).pipe(Effect.mapError(fail("findDeviceByHostname")));
  const wanted = hostname.toLowerCase();
  const device = decoded.devices.find((entry) => entry.hostname.toLowerCase() === wanted);
  return device === undefined
    ? Option.none<TailnetDevice>()
    : Option.some<TailnetDevice>({
        deviceId: device.nodeId ?? device.id,
        hostname: device.hostname,
        name: device.name,
      });
});

/** Deletes a device; an already-gone device (404) is success. */
export const deleteDevice = Effect.fn("TailscaleApi.deleteDevice")(function* (
  client: HttpClient.HttpClient,
  baseUrl: string,
  token: Redacted.Redacted<string>,
  deviceId: string,
) {
  const response = yield* client
    .del(`${baseUrl}/api/v2/device/${encodeURIComponent(deviceId)}`, { headers: bearer(token) })
    .pipe(Effect.timeout("15 seconds"), Effect.mapError(fail("deleteDevice")));
  if (response.status === 404) {
    return "not-found" as const;
  }
  if (response.status < 200 || response.status >= 300) {
    const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    return yield* new TailscaleApiError({
      operation: "deleteDevice",
      message: `Tailscale API returned ${response.status}: ${body.slice(0, 300)}`,
    });
  }
  return "deleted" as const;
});

/** Deletes an auth key; an already-gone key (404) is success. */
export const deleteAuthKey = Effect.fn("TailscaleApi.deleteAuthKey")(function* (
  client: HttpClient.HttpClient,
  baseUrl: string,
  token: Redacted.Redacted<string>,
  keyId: string,
) {
  const response = yield* client
    .del(`${baseUrl}/api/v2/tailnet/-/keys/${encodeURIComponent(keyId)}`, {
      headers: bearer(token),
    })
    .pipe(Effect.timeout("15 seconds"), Effect.mapError(fail("deleteAuthKey")));
  if (response.status === 404) {
    return "not-found" as const;
  }
  if (response.status < 200 || response.status >= 300) {
    const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    return yield* new TailscaleApiError({
      operation: "deleteAuthKey",
      message: `Tailscale API returned ${response.status}: ${body.slice(0, 300)}`,
    });
  }
  return "deleted" as const;
});
