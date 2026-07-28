import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { ControllerConfig } from "../Config.ts";
import { Events } from "../events/Events.ts";
import { Vault } from "../vault/Vault.ts";
import { type EnvironmentRow, EnvironmentsRepo } from "./EnvironmentsRepo.ts";
import { fetchActivity, fetchDescriptor } from "./T3EnvironmentApi.ts";

/**
 * Steady-state observation over HTTP (`architecture.md` §2): every interval,
 * each ready environment gets an unauthenticated descriptor probe
 * (liveness + identity) and, when alive, an orchestration snapshot with the
 * vault-stored admin session (activity for the inventory and phase 7's idle
 * detection). Observed-state transitions are persisted and logged as events;
 * steady states are not re-logged.
 */
export class StatusPoller extends Context.Service<
  StatusPoller,
  {
    /** One full polling pass over all ready environments (used by tests). */
    readonly pollOnce: Effect.Effect<void>;
  }
>()("t3fleet/controller/StatusPoller") {
  static readonly layer: Layer.Layer<
    StatusPoller,
    never,
    ControllerConfig | Events | Vault | EnvironmentsRepo | HttpClient.HttpClient
  > = Layer.effect(
    StatusPoller,
    Effect.gen(function* () {
      const config = yield* ControllerConfig;
      const events = yield* Events;
      const vault = yield* Vault;
      const repo = yield* EnvironmentsRepo;
      const httpClient = yield* HttpClient.HttpClient;
      const scope = yield* Effect.scope;

      const pollEnvironment = Effect.fn("StatusPoller.pollEnvironment")(function* (
        row: EnvironmentRow,
      ) {
        if (row.endpointUrl === null) {
          return;
        }
        const descriptor = yield* fetchDescriptor(httpClient, row.endpointUrl).pipe(Effect.result);
        let observed: EnvironmentRow["observedState"];
        let activity = null;
        if (descriptor._tag === "Success") {
          observed = "running";
          if (row.t3SessionRef !== null) {
            const token = yield* vault.read(row.t3SessionRef).pipe(Effect.option);
            if (token._tag === "Some") {
              const fetched = yield* fetchActivity(httpClient, row.endpointUrl, token.value).pipe(
                Effect.result,
              );
              if (fetched._tag === "Success") {
                activity = fetched.success;
              } else {
                yield* Effect.logWarning(
                  `environment ${row.id}: activity poll failed: ${fetched.failure.message}`,
                );
              }
            }
          }
        } else {
          observed = "unreachable";
        }
        yield* repo.recordStatus({ id: row.id, observedState: observed, activity });
        if (observed !== row.observedState) {
          yield* events.append({
            kind: "environment-status-changed",
            nodeId: row.nodeId,
            payload: { environmentId: row.id, from: row.observedState, to: observed },
          });
        }
      });

      const pollOnce = Effect.gen(function* () {
        const rows = yield* repo.list;
        for (const row of rows) {
          if (row.desiredState === "running" && row.createStep === "ready") {
            yield* pollEnvironment(row);
          }
        }
      });

      yield* pollOnce.pipe(
        Effect.repeat(Schedule.spaced(Duration.millis(config.statusPollIntervalMillis))),
        Effect.forkIn(scope),
      );

      return StatusPoller.of({ pollOnce });
    }),
  );
}
