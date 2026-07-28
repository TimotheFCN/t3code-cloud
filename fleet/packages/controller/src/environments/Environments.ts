import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import type { EnvironmentSummary } from "@t3fleet/shared/environment";
import {
  EnvironmentPayload,
  ExecEnvironmentPayload,
  PullImagePayload,
} from "@t3fleet/shared/protocol";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { ControllerConfig } from "../Config.ts";
import { Events } from "../events/Events.ts";
import { Images } from "../images/Images.ts";
import { AgentConnections } from "../nodes/AgentConnections.ts";
import { NodeRegistry } from "../nodes/NodeRegistry.ts";
import { Vault } from "../vault/Vault.ts";
import { nodePortEndpoint } from "./EnvironmentEndpoints.ts";
import {
  type EnvironmentRecordNotFoundError,
  type EnvironmentRow,
  EnvironmentsRepo,
  toSummary,
} from "./EnvironmentsRepo.ts";
import { NoSchedulableNodeError, Scheduler } from "./Scheduler.ts";
import { fetchDescriptor, revokeSession } from "./T3EnvironmentApi.ts";

export class NoCurrentImageError extends Schema.TaggedErrorClass<NoCurrentImageError>()(
  "NoCurrentImageError",
  {
    message: Schema.String,
  },
) {}

/** Internal: any step failure, recorded on the row and logged — never thrown out of a runner. */
class StepFailure extends Schema.TaggedErrorClass<StepFailure>()("StepFailure", {
  step: Schema.String,
  message: Schema.String,
}) {}

/** The port the T3 server listens on inside every t3env container. */
export const T3_CONTAINER_PORT = 3773;

/** Label attached to the controller's admin sessions inside T3 servers. */
export const CONTROLLER_SESSION_LABEL = "fleet-controller";

/**
 * TTL for the controller-held admin session. Long-lived by design: it backs
 * status polling and pairing for the environment's whole life. Renewal is
 * a later-phase concern (recorded in the phase-3 handoff).
 */
const CONTROLLER_SESSION_TTL = "365d";

const decodePulled = Schema.decodeUnknownEffect(PullImagePayload);
const decodeDescriptorPayload = Schema.decodeUnknownEffect(EnvironmentPayload);
const decodeExec = Schema.decodeUnknownEffect(ExecEnvironmentPayload);

/** `t3 auth session issue --json` — only the fields the controller consumes. */
const IssuedSessionJson = Schema.Struct({
  sessionId: Schema.String,
  token: Schema.String,
});
const decodeIssuedSession = Schema.decodeUnknownEffect(Schema.fromJsonString(IssuedSessionJson));

/** `t3 auth session list --json` — enough to find stale controller sessions. */
const SessionListJson = Schema.Array(
  Schema.Struct({
    sessionId: Schema.String,
    client: Schema.optional(Schema.Struct({ label: Schema.optional(Schema.String) })),
  }),
);
const decodeSessionList = Schema.decodeUnknownEffect(Schema.fromJsonString(SessionListJson));

/** Destroy steps tolerate an environment the node no longer knows about. */
const notFoundIsFine = (error: StepFailure) =>
  error.message.includes("environment-not-found") ? Effect.void : Effect.fail(error);

/**
 * The environment lifecycle machine (`docs/fleet/architecture.md`
 * §Environment Lifecycle, minus the phase-4 tailnet parts).
 *
 * Create runs as persisted, re-runnable steps — side effect first, then the
 * step is recorded — so a controller restarted mid-create resumes from the
 * recorded step and converges: driver create/start are idempotent, health
 * polling is a read, and session issue revokes stale `fleet-controller`
 * sessions before issuing. `reconcile` (forked at layer start) re-drives
 * every environment whose desired and observed state disagree.
 *
 * Exec is used exactly twice, per the bootstrap-and-break-glass rule:
 * session bootstrap after health, and the optional uncommitted-work archive
 * during destroy. Everything else is HTTP.
 */
export class Environments extends Context.Service<
  Environments,
  {
    readonly create: (input: {
      readonly gitUrl: string;
      readonly gitBranch?: string | undefined;
      readonly nodeId?: string | undefined;
      readonly name?: string | undefined;
    }) => Effect.Effect<EnvironmentSummary, NoSchedulableNodeError | NoCurrentImageError>;
    readonly list: Effect.Effect<ReadonlyArray<EnvironmentSummary>>;
    readonly get: (id: string) => Effect.Effect<EnvironmentSummary, EnvironmentRecordNotFoundError>;
    readonly destroy: (
      id: string,
      options?: { readonly archive?: boolean | undefined },
    ) => Effect.Effect<EnvironmentSummary, EnvironmentRecordNotFoundError>;
    /** Awaits the currently running create/destroy runner, if any (tests). */
    readonly awaitRunner: (id: string) => Effect.Effect<void>;
  }
>()("t3fleet/controller/Environments") {
  static readonly layer: Layer.Layer<
    Environments,
    never,
    | ControllerConfig
    | Events
    | Images
    | AgentConnections
    | NodeRegistry
    | Vault
    | EnvironmentsRepo
    | Scheduler
    | HttpClient.HttpClient
  > = Layer.effect(
    Environments,
    Effect.gen(function* () {
      const config = yield* ControllerConfig;
      const events = yield* Events;
      const images = yield* Images;
      const connections = yield* AgentConnections;
      const registry = yield* NodeRegistry;
      const vault = yield* Vault;
      const repo = yield* EnvironmentsRepo;
      const scheduler = yield* Scheduler;
      const httpClient = yield* HttpClient.HttpClient;
      const scope = yield* Effect.scope;

      // One runner fiber per environment; a new operation replaces (and
      // interrupts) the previous one, so create and destroy never interleave
      // for the same environment.
      const runners = new Map<string, Fiber.Fiber<void>>();

      const spawn = (id: string, work: Effect.Effect<void>) =>
        Effect.gen(function* () {
          const existing = runners.get(id);
          if (existing !== undefined) {
            yield* Fiber.interrupt(existing);
          }
          const fiber = yield* work.pipe(Effect.forkIn(scope));
          runners.set(id, fiber);
        });

      const awaitRunner = (id: string) =>
        Effect.suspend(() => {
          const fiber = runners.get(id);
          return fiber === undefined ? Effect.void : Effect.ignore(Fiber.await(fiber));
        });

      const stepFail = (step: string) => (cause: unknown) => {
        const record =
          typeof cause === "object" && cause !== null ? (cause as Record<string, unknown>) : {};
        const message = "message" in record ? String(record["message"]) : String(cause);
        // Keep the agent's typed error code visible (e.g. environment-not-found).
        const code = typeof record["code"] === "string" ? `${record["code"]}: ` : "";
        return new StepFailure({ step, message: `${code}${message}` });
      };

      const request = (
        nodeId: string,
        body: Parameters<typeof connections.request>[1],
        step: string,
        timeout: Duration.Input,
      ) => connections.request(nodeId, body, { timeout }).pipe(Effect.mapError(stepFail(step)));

      /**
       * Reconnecting agents register within moments of a controller restart;
       * reconciliation waits for the environment's node instead of failing
       * immediately.
       */
      const awaitNodeConnected = Effect.fn("Environments.awaitNodeConnected")(function* (
        nodeId: string,
      ) {
        yield* SubscriptionRef.get(registry.connectedNodeIds).pipe(
          Effect.repeat({
            until: (connected) => connected.has(nodeId),
            schedule: Schedule.spaced("250 millis"),
          }),
          Effect.timeoutOrElse({
            duration: "5 minutes",
            orElse: () =>
              new StepFailure({
                step: "await-node",
                message: `node ${nodeId} did not connect`,
              }),
          }),
        );
      });

      const execJson = Effect.fn("Environments.execJson")(function* (
        row: EnvironmentRow,
        command: ReadonlyArray<string>,
        step: string,
      ) {
        const payload = yield* request(
          row.nodeId,
          { type: "exec-environment", payload: { environmentId: row.id, command } },
          step,
          "1 minute",
        );
        const result = yield* decodeExec(payload).pipe(Effect.mapError(stepFail(step)));
        if (result.exitCode !== 0) {
          // stderr only — stdout of auth commands may carry a token.
          return yield* new StepFailure({
            step,
            message: `${command[0]} ${command[1] ?? ""} exited ${result.exitCode}: ${result.stderr.slice(0, 500)}`,
          });
        }
        return result.stdout;
      });

      // --- create step machine -------------------------------------------

      const stepImageReady = Effect.fn("Environments.stepImageReady")(function* (
        row: EnvironmentRow,
      ) {
        const payload = yield* request(
          row.nodeId,
          { type: "pull-image", payload: { reference: row.imageReference } },
          "image-ready",
          "10 minutes",
        );
        yield* decodePulled(payload).pipe(Effect.mapError(stepFail("image-ready")));
      });

      const stepCreated = Effect.fn("Environments.stepCreated")(function* (row: EnvironmentRow) {
        yield* request(
          row.nodeId,
          {
            type: "create-environment",
            payload: {
              id: row.id,
              name: row.name,
              image: row.imageReference,
              env: {
                T3ENV_GIT_URL: row.gitUrl,
                ...(row.gitBranch === null ? {} : { T3ENV_GIT_BRANCH: row.gitBranch }),
              },
              publishPorts: [{ containerPort: T3_CONTAINER_PORT }],
            },
          },
          "created",
          "2 minutes",
        );
      });

      const stepStarted = Effect.fn("Environments.stepStarted")(function* (row: EnvironmentRow) {
        const payload = yield* request(
          row.nodeId,
          { type: "start-environment", payload: { environmentId: row.id } },
          "started",
          "1 minute",
        );
        const descriptor = yield* decodeDescriptorPayload(payload).pipe(
          Effect.mapError(stepFail("started")),
        );
        const hostPort = descriptor.ports?.find(
          (port) => port.containerPort === T3_CONTAINER_PORT,
        )?.hostPort;
        if (hostPort === undefined) {
          return yield* new StepFailure({
            step: "started",
            message: `no host port published for container port ${T3_CONTAINER_PORT}`,
          });
        }
        const host = yield* registry.endpointHost(row.nodeId);
        if (Option.isNone(host)) {
          return yield* new StepFailure({
            step: "started",
            message: `no endpoint host recorded for node ${row.nodeId}`,
          });
        }
        yield* repo.setEndpoint({
          id: row.id,
          hostPort,
          endpointUrl: nodePortEndpoint(host.value, hostPort),
        });
      });

      const stepHealthy = Effect.fn("Environments.stepHealthy")(function* (row: EnvironmentRow) {
        const fresh = yield* repo.get(row.id).pipe(Effect.mapError(stepFail("healthy")));
        if (fresh.endpointUrl === null) {
          return yield* new StepFailure({ step: "healthy", message: "no endpoint URL recorded" });
        }
        // The entrypoint clones, runs the setup hook, and registers the
        // project before `t3 serve` starts — a healthy descriptor implies the
        // whole bootstrap sequence succeeded.
        const descriptor = yield* fetchDescriptor(httpClient, fresh.endpointUrl).pipe(
          Effect.retry({
            while: (error) => error._tag === "T3RequestError",
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.timeoutOrElse({
            duration: Duration.millis(config.environmentHealthTimeoutMillis),
            orElse: () =>
              new StepFailure({
                step: "healthy",
                message: `T3 server did not become healthy within ${config.environmentHealthTimeoutMillis}ms (check container logs on the node)`,
              }),
          }),
          Effect.mapError((error) =>
            error instanceof StepFailure ? error : stepFail("healthy")(error),
          ),
        );
        yield* repo.setT3Identity({ id: row.id, t3EnvironmentId: descriptor.environmentId });
      });

      const stepSessionIssued = Effect.fn("Environments.stepSessionIssued")(function* (
        row: EnvironmentRow,
      ) {
        // Convergence: a crash between issuing and persisting leaves a stale
        // session behind — revoke anything labeled as ours before issuing.
        const listOutput = yield* execJson(
          row,
          ["t3", "auth", "session", "list", "--json"],
          "session-issued",
        );
        const sessions = yield* decodeSessionList(listOutput.trim()).pipe(
          Effect.mapError(stepFail("session-issued")),
        );
        for (const session of sessions) {
          if (session.client?.label === CONTROLLER_SESSION_LABEL) {
            yield* execJson(
              row,
              ["t3", "auth", "session", "revoke", session.sessionId],
              "session-issued",
            );
          }
        }
        const issueOutput = yield* execJson(
          row,
          [
            "t3",
            "auth",
            "session",
            "issue",
            "--json",
            "--label",
            CONTROLLER_SESSION_LABEL,
            "--ttl",
            CONTROLLER_SESSION_TTL,
          ],
          "session-issued",
        );
        const issued = yield* decodeIssuedSession(issueOutput.trim()).pipe(
          // Deliberately drops the decode cause: the raw output contains the token.
          Effect.mapError(
            () =>
              new StepFailure({
                step: "session-issued",
                message: "could not parse `t3 auth session issue --json` output",
              }),
          ),
        );
        const sessionRef = yield* vault
          .store(Redacted.make(issued.token))
          .pipe(Effect.mapError(stepFail("session-issued")));
        yield* repo.setSession({ id: row.id, sessionRef, sessionId: issued.sessionId });
      });

      const runCreate = Effect.fn("Environments.runCreate")(function* (id: string) {
        const outcome = yield* Effect.gen(function* () {
          let row = yield* repo.get(id).pipe(Effect.mapError(stepFail("load")));
          yield* awaitNodeConnected(row.nodeId);
          // Each arm performs its side effect, then records the step; a crash
          // in between re-runs the arm, which is safe by construction.
          while (row.createStep !== "ready") {
            switch (row.createStep) {
              case "scheduled": {
                yield* stepImageReady(row);
                yield* repo.setCreateStep(id, "image-ready");
                break;
              }
              case "image-ready": {
                yield* stepCreated(row);
                yield* repo.setCreateStep(id, "created");
                break;
              }
              case "created": {
                yield* stepStarted(row);
                yield* repo.setCreateStep(id, "started");
                break;
              }
              case "started": {
                yield* stepHealthy(row);
                yield* repo.setCreateStep(id, "healthy");
                break;
              }
              case "healthy": {
                yield* stepSessionIssued(row);
                yield* repo.setCreateStep(id, "session-issued");
                break;
              }
              case "session-issued": {
                yield* repo.setObservedState(id, "running");
                yield* repo.setCreateStep(id, "ready");
                break;
              }
            }
            row = yield* repo.get(id).pipe(Effect.mapError(stepFail("load")));
          }
          return row;
        }).pipe(Effect.result);

        if (outcome._tag === "Success") {
          yield* events.append({
            kind: "environment-ready",
            nodeId: outcome.success.nodeId,
            payload: { environmentId: id, endpointUrl: outcome.success.endpointUrl },
          });
          return;
        }
        const failure = outcome.failure;
        const message = `create failed at step ${failure.step}: ${failure.message}`;
        yield* Effect.logWarning(`environment ${id}: ${message}`);
        yield* repo.markError(id, message);
        yield* events.append({
          kind: "environment-create-failed",
          payload: { environmentId: id, step: failure.step, message: failure.message },
        });
      });

      // --- destroy -------------------------------------------------------

      const archiveUncommittedWork = Effect.fn("Environments.archiveUncommittedWork")(function* (
        row: EnvironmentRow,
      ) {
        // `git add -A -N` stages intent for untracked files so `git diff`
        // includes them; the patch is the whole uncommitted final state.
        const patch = yield* execJson(
          row,
          ["sh", "-c", "cd /root/workspace && git add -A -N >/dev/null 2>&1 && git diff HEAD"],
          "archive",
        );
        if (patch.trim().length === 0) {
          yield* Effect.logInfo(`environment ${row.id}: no uncommitted work to archive`);
          return;
        }
        const archivesDir = NodePath.resolve(config.dataDir, "archives");
        yield* Effect.promise(() => NodeFs.mkdir(archivesDir, { recursive: true }));
        const now = yield* Clock.currentTimeMillis;
        const path = NodePath.join(archivesDir, `${row.id}-${now}.patch.gz`);
        yield* Effect.promise(() =>
          NodeFs.writeFile(path, NodeZlib.gzipSync(Buffer.from(patch, "utf8"))),
        );
        yield* Effect.logInfo(`environment ${row.id}: archived uncommitted work to ${path}`);
      });

      const runDestroy = Effect.fn("Environments.runDestroy")(function* (id: string) {
        const outcome = yield* Effect.gen(function* () {
          const row = yield* repo.get(id).pipe(Effect.mapError(stepFail("load")));
          yield* awaitNodeConnected(row.nodeId);

          if (row.archiveOnDestroy) {
            // Best-effort: a stopped or broken container must not block destroy.
            yield* archiveUncommittedWork(row).pipe(
              Effect.catch((error) =>
                Effect.logWarning(`environment ${id}: final-work archive failed: ${error.message}`),
              ),
            );
          }

          // Best-effort HTTP revoke of the controller's own session; if the
          // server is already unreachable the auth database dies with the
          // volume anyway.
          if (row.endpointUrl !== null && row.t3SessionRef !== null && row.t3SessionId !== null) {
            const token = yield* vault.read(row.t3SessionRef).pipe(Effect.option);
            if (Option.isSome(token)) {
              yield* revokeSession(httpClient, row.endpointUrl, token.value, row.t3SessionId).pipe(
                Effect.catch((error) =>
                  Effect.logWarning(`environment ${id}: session revoke failed: ${error.message}`),
                ),
              );
            }
          }

          yield* request(
            row.nodeId,
            { type: "stop-environment", payload: { environmentId: id } },
            "stop",
            "2 minutes",
          ).pipe(Effect.asVoid, Effect.catch(notFoundIsFine));

          yield* request(
            row.nodeId,
            { type: "destroy-environment", payload: { environmentId: id } },
            "destroy",
            "2 minutes",
          ).pipe(Effect.asVoid, Effect.catch(notFoundIsFine));

          if (row.t3SessionRef !== null) {
            yield* vault.delete(row.t3SessionRef).pipe(Effect.mapError(stepFail("destroy")));
            yield* repo.clearSession(id);
          }
          yield* repo.markDestroyed(id);
          return row;
        }).pipe(Effect.result);

        if (outcome._tag === "Success") {
          yield* events.append({
            kind: "environment-destroyed",
            nodeId: outcome.success.nodeId,
            payload: { environmentId: id },
          });
          return;
        }
        const failure = outcome.failure;
        const message = `destroy failed at step ${failure.step}: ${failure.message}`;
        yield* Effect.logWarning(`environment ${id}: ${message}`);
        // Desired state stays `destroyed`; reconciliation retries on restart.
        yield* repo.markError(id, message);
        yield* events.append({
          kind: "environment-destroy-failed",
          payload: { environmentId: id, step: failure.step, message: failure.message },
        });
      });

      // --- public operations ----------------------------------------------

      const create = Effect.fn("Environments.create")(function* (input: {
        readonly gitUrl: string;
        readonly gitBranch?: string | undefined;
        readonly nodeId?: string | undefined;
        readonly name?: string | undefined;
      }) {
        const image = yield* images.current;
        if (Option.isNone(image)) {
          return yield* new NoCurrentImageError({
            message: "no current base image — register one via POST /api/images first",
          });
        }
        const node = yield* scheduler.pick({ nodeId: input.nodeId });
        const id = `env-${NodeCrypto.randomBytes(4).toString("hex")}`;
        const row = yield* repo.insert({
          id,
          name: input.name ?? id,
          nodeId: node.id,
          gitUrl: input.gitUrl,
          gitBranch: input.gitBranch ?? null,
          imageReference: image.value.reference,
        });
        yield* events.append({
          kind: "environment-create-requested",
          nodeId: node.id,
          payload: { environmentId: id, gitUrl: input.gitUrl, gitBranch: input.gitBranch ?? null },
        });
        yield* spawn(id, runCreate(id));
        return toSummary(row);
      });

      const list = repo.list.pipe(Effect.map((rows) => rows.map((row) => toSummary(row))));

      const get = Effect.fn("Environments.get")(function* (id: string) {
        return toSummary(yield* repo.get(id));
      });

      const destroy = Effect.fn("Environments.destroy")(function* (
        id: string,
        options?: { readonly archive?: boolean | undefined },
      ) {
        const row = yield* repo.get(id);
        yield* repo.markDesiredDestroyed({ id, archive: options?.archive ?? false });
        yield* events.append({
          kind: "environment-destroy-requested",
          nodeId: row.nodeId,
          payload: { environmentId: id, archive: options?.archive ?? false },
        });
        yield* spawn(id, runDestroy(id));
        return toSummary(yield* repo.get(id));
      });

      /**
       * Startup reconciliation: re-drive every environment whose desired and
       * observed state disagree. Mid-create rows resume their step machine;
       * mid-destroy rows re-run destroy (every destroy action converges).
       * Failed creates (observed `error`, desired `running`) are not retried
       * automatically — the operator destroys or investigates.
       */
      const reconcile = Effect.gen(function* () {
        const rows = yield* repo.list;
        for (const row of rows) {
          if (row.desiredState === "destroyed" && row.observedState !== "destroyed") {
            yield* Effect.logInfo(`reconcile: resuming destroy of ${row.id}`);
            yield* spawn(row.id, runDestroy(row.id));
          } else if (
            row.desiredState === "running" &&
            row.createStep !== "ready" &&
            row.observedState === "creating"
          ) {
            yield* Effect.logInfo(
              `reconcile: resuming create of ${row.id} from step ${row.createStep}`,
            );
            yield* spawn(row.id, runCreate(row.id));
          }
        }
      });

      yield* reconcile;

      return Environments.of({ create, list, get, destroy, awaitRunner });
    }),
  );
}
