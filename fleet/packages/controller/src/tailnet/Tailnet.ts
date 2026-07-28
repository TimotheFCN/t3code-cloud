import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { ControllerConfig } from "../Config.ts";
import { Vault } from "../vault/Vault.ts";
import {
  createAuthKey,
  deleteAuthKey,
  deleteDevice,
  exchangeToken,
  findDeviceByHostname,
  type TailnetDevice,
  TailscaleApiError,
} from "./TailscaleApi.ts";
import { TailnetSettings } from "./TailnetSettings.ts";

export class TailnetNotConfiguredError extends Schema.TaggedErrorClass<TailnetNotConfiguredError>()(
  "TailnetNotConfiguredError",
  {
    message: Schema.String,
  },
) {}

const notConfigured = () =>
  new TailnetNotConfiguredError({
    message:
      "Tailscale is not configured — provide an OAuth client via PUT /api/settings/tailscale first",
  });

/** Refresh the cached access token when less than this much lifetime is left. */
const TOKEN_REFRESH_MARGIN_MILLIS = 60_000;

interface CachedToken {
  /** Cache key: a reconfigured OAuth client invalidates the cached token. */
  readonly secretRef: string;
  readonly token: Redacted.Redacted<string>;
  readonly expiresAtMillis: number;
}

/**
 * The controller's tailnet integration (`docs/fleet/architecture.md`
 * §Networking): mints per-environment tagged auth keys through the
 * operator's Tailscale OAuth client and deletes devices on destroy. Access
 * tokens are cached until near expiry; every secret stays `Redacted`.
 */
export class Tailnet extends Context.Service<
  Tailnet,
  {
    readonly configured: Effect.Effect<boolean>;
    /** Mints one single-use, pre-authorized, non-ephemeral tagged auth key. */
    readonly mintAuthKey: (
      environmentId: string,
    ) => Effect.Effect<
      { readonly keyId: string; readonly key: Redacted.Redacted<string> },
      TailnetNotConfiguredError | TailscaleApiError
    >;
    readonly findDevice: (
      hostname: string,
    ) => Effect.Effect<Option.Option<TailnetDevice>, TailnetNotConfiguredError | TailscaleApiError>;
    /** Deletes a device; an already-gone device is success. */
    readonly deleteDevice: (
      deviceId: string,
    ) => Effect.Effect<"deleted" | "not-found", TailnetNotConfiguredError | TailscaleApiError>;
    /** Deletes an auth key; an already-gone key is success. */
    readonly deleteAuthKey: (
      keyId: string,
    ) => Effect.Effect<"deleted" | "not-found", TailnetNotConfiguredError | TailscaleApiError>;
  }
>()("t3fleet/controller/Tailnet") {
  static readonly layer: Layer.Layer<
    Tailnet,
    never,
    ControllerConfig | TailnetSettings | Vault | HttpClient.HttpClient
  > = Layer.effect(
    Tailnet,
    Effect.gen(function* () {
      const config = yield* ControllerConfig;
      const settings = yield* TailnetSettings;
      const vault = yield* Vault;
      const httpClient = yield* HttpClient.HttpClient;
      const cache = yield* Ref.make<Option.Option<CachedToken>>(Option.none());

      const configured = settings.status.pipe(Effect.map((status) => status.configured));

      /** Resolves the configuration and a valid access token (cached). */
      const accessToken = Effect.fn("Tailnet.accessToken")(function* () {
        const configuration = yield* settings.read;
        if (Option.isNone(configuration)) {
          return yield* notConfigured();
        }
        const now = yield* Clock.currentTimeMillis;
        const cached = yield* Ref.get(cache);
        if (
          Option.isSome(cached) &&
          cached.value.secretRef === configuration.value.secretRef &&
          now < cached.value.expiresAtMillis - TOKEN_REFRESH_MARGIN_MILLIS
        ) {
          return { configuration: configuration.value, token: cached.value.token };
        }
        const secret = yield* vault.read(configuration.value.secretRef).pipe(
          Effect.mapError(
            (error) =>
              new TailscaleApiError({
                operation: "readOauthSecret",
                message: `cannot read the OAuth client secret from the vault (${error._tag})`,
              }),
          ),
        );
        const exchanged = yield* exchangeToken(
          httpClient,
          config.tailscaleApiUrl,
          configuration.value.clientId,
          secret,
        );
        yield* Ref.set(
          cache,
          Option.some<CachedToken>({
            secretRef: configuration.value.secretRef,
            token: exchanged.accessToken,
            expiresAtMillis: now + exchanged.expiresInSeconds * 1000,
          }),
        );
        return { configuration: configuration.value, token: exchanged.accessToken };
      });

      const mintAuthKey = Effect.fn("Tailnet.mintAuthKey")(function* (environmentId: string) {
        const { configuration, token } = yield* accessToken();
        return yield* createAuthKey(httpClient, config.tailscaleApiUrl, token, {
          tag: configuration.tag,
          expirySeconds: config.tsAuthKeyTtlSeconds,
          description: `t3fleet ${environmentId}`,
        });
      });

      const findDevice = Effect.fn("Tailnet.findDevice")(function* (hostname: string) {
        const { token } = yield* accessToken();
        return yield* findDeviceByHostname(httpClient, config.tailscaleApiUrl, token, hostname);
      });

      const deleteDeviceById = Effect.fn("Tailnet.deleteDevice")(function* (deviceId: string) {
        const { token } = yield* accessToken();
        return yield* deleteDevice(httpClient, config.tailscaleApiUrl, token, deviceId);
      });

      const deleteAuthKeyById = Effect.fn("Tailnet.deleteAuthKey")(function* (keyId: string) {
        const { token } = yield* accessToken();
        return yield* deleteAuthKey(httpClient, config.tailscaleApiUrl, token, keyId);
      });

      return Tailnet.of({
        configured,
        mintAuthKey,
        findDevice,
        deleteDevice: deleteDeviceById,
        deleteAuthKey: deleteAuthKeyById,
      });
    }),
  );
}
