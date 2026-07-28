import type { PairingLink } from "@t3fleet/shared/environment";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { Events } from "../events/Events.ts";
import { Vault } from "../vault/Vault.ts";
import { pairingUrl } from "./EnvironmentEndpoints.ts";
import { type EnvironmentRecordNotFoundError, EnvironmentsRepo } from "./EnvironmentsRepo.ts";
import { mintPairingCredential } from "./T3EnvironmentApi.ts";

export class EnvironmentNotReadyError extends Schema.TaggedErrorClass<EnvironmentNotReadyError>()(
  "EnvironmentNotReadyError",
  {
    environmentId: Schema.String,
    message: Schema.String,
  },
) {}

export class PairingMintError extends Schema.TaggedErrorClass<PairingMintError>()(
  "PairingMintError",
  {
    environmentId: Schema.String,
    message: Schema.String,
  },
) {}

/**
 * Mints one-time pairing links on demand through the environment's own auth
 * API, authorized by the vault-stored admin session (`architecture.md` §4
 * invariant 5: minted once per click, default TTL, never stored — the
 * credential exists only in the returned URL).
 */
export class PairingLinks extends Context.Service<
  PairingLinks,
  {
    readonly mint: (
      environmentId: string,
    ) => Effect.Effect<
      PairingLink,
      EnvironmentRecordNotFoundError | EnvironmentNotReadyError | PairingMintError
    >;
  }
>()("t3fleet/controller/PairingLinks") {
  static readonly layer: Layer.Layer<
    PairingLinks,
    never,
    Events | Vault | EnvironmentsRepo | HttpClient.HttpClient
  > = Layer.effect(
    PairingLinks,
    Effect.gen(function* () {
      const events = yield* Events;
      const vault = yield* Vault;
      const repo = yield* EnvironmentsRepo;
      const httpClient = yield* HttpClient.HttpClient;

      const mint = Effect.fn("PairingLinks.mint")(function* (environmentId: string) {
        const row = yield* repo.get(environmentId);
        if (
          row.createStep !== "ready" ||
          row.desiredState !== "running" ||
          row.endpointUrl === null ||
          row.t3SessionRef === null
        ) {
          return yield* new EnvironmentNotReadyError({
            environmentId,
            message: `environment is not ready (step ${row.createStep}, ${row.observedState})`,
          });
        }
        const token = yield* vault
          .read(row.t3SessionRef)
          .pipe(
            Effect.mapError(
              (error) => new PairingMintError({ environmentId, message: error._tag }),
            ),
          );
        const minted = yield* mintPairingCredential(
          httpClient,
          row.endpointUrl,
          token,
          "fleet",
        ).pipe(
          Effect.mapError(
            (error) => new PairingMintError({ environmentId, message: error.message }),
          ),
        );
        // The event records that a link was minted — never the link itself.
        yield* events.append({
          kind: "pairing-link-minted",
          nodeId: row.nodeId,
          payload: { environmentId },
        });
        return {
          url: pairingUrl(row.endpointUrl, minted.credential),
          expiresAt: minted.expiresAt,
        } satisfies PairingLink;
      });

      return PairingLinks.of({ mint });
    }),
  );
}
