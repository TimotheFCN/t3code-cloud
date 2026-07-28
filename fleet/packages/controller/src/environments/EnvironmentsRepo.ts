import type {
  EnvironmentActivity,
  EnvironmentCreateStep,
  EnvironmentDesiredState,
  EnvironmentObservedState,
  EnvironmentSummary,
} from "@t3fleet/shared/environment";
import { EnvironmentActivity as EnvironmentActivitySchema } from "@t3fleet/shared/environment";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export class EnvironmentRecordNotFoundError extends Schema.TaggedErrorClass<EnvironmentRecordNotFoundError>()(
  "EnvironmentRecordNotFoundError",
  {
    environmentId: Schema.String,
  },
) {}

const encodeActivity = Schema.encodeUnknownEffect(Schema.fromJsonString(EnvironmentActivitySchema));
const decodeActivity = Schema.decodeUnknownEffect(Schema.fromJsonString(EnvironmentActivitySchema));

export interface EnvironmentRow {
  readonly id: string;
  readonly name: string;
  readonly nodeId: string;
  readonly gitUrl: string;
  readonly gitBranch: string | null;
  readonly imageReference: string;
  readonly desiredState: EnvironmentDesiredState;
  readonly createStep: EnvironmentCreateStep;
  readonly observedState: EnvironmentObservedState;
  readonly endpointUrl: string | null;
  readonly tailnetDeviceId: string | null;
  readonly tsAuthKeyRef: string | null;
  readonly tsAuthKeyId: string | null;
  readonly statusDetail: string | null;
  readonly t3SessionRef: string | null;
  readonly t3SessionId: string | null;
  readonly t3EnvironmentId: string | null;
  readonly activity: EnvironmentActivity | null;
  readonly lastStatusAtMillis: number | null;
  readonly error: string | null;
  readonly archiveOnDestroy: boolean;
  readonly createdAtMillis: number;
  readonly updatedAtMillis: number;
}

interface RawRow {
  readonly id: string;
  readonly name: string;
  readonly node_id: string;
  readonly git_url: string;
  readonly git_branch: string | null;
  readonly image_reference: string;
  readonly desired_state: string;
  readonly create_step: string;
  readonly observed_state: string;
  readonly endpoint_url: string | null;
  readonly tailnet_device_id: string | null;
  readonly ts_authkey_ref: string | null;
  readonly ts_authkey_id: string | null;
  readonly status_detail: string | null;
  readonly t3_session_ref: string | null;
  readonly t3_session_id: string | null;
  readonly t3_environment_id: string | null;
  readonly activity_json: string | null;
  readonly last_status_at: number | null;
  readonly error: string | null;
  readonly archive_on_destroy: number;
  readonly created_at: number;
  readonly updated_at: number;
}

export const toSummary = (row: EnvironmentRow): EnvironmentSummary => ({
  id: row.id,
  name: row.name,
  nodeId: row.nodeId,
  gitUrl: row.gitUrl,
  gitBranch: row.gitBranch,
  imageReference: row.imageReference,
  desiredState: row.desiredState,
  createStep: row.createStep,
  observedState: row.observedState,
  endpointUrl: row.endpointUrl,
  tailnetDeviceId: row.tailnetDeviceId,
  t3EnvironmentId: row.t3EnvironmentId,
  statusDetail: row.statusDetail,
  activity: row.activity,
  lastStatusAtMillis: row.lastStatusAtMillis,
  error: row.error,
  createdAtMillis: row.createdAtMillis,
  updatedAtMillis: row.updatedAtMillis,
});

/**
 * SQL access to the `environments` table, shared by the lifecycle machine
 * (`Environments`), the status poller, and pairing-link minting. Never
 * stores secrets: `t3_session_ref` is a vault reference.
 */
export class EnvironmentsRepo extends Context.Service<
  EnvironmentsRepo,
  {
    readonly insert: (input: {
      readonly id: string;
      readonly name: string;
      readonly nodeId: string;
      readonly gitUrl: string;
      readonly gitBranch: string | null;
      readonly imageReference: string;
    }) => Effect.Effect<EnvironmentRow>;
    readonly get: (id: string) => Effect.Effect<EnvironmentRow, EnvironmentRecordNotFoundError>;
    readonly find: (id: string) => Effect.Effect<Option.Option<EnvironmentRow>>;
    readonly list: Effect.Effect<ReadonlyArray<EnvironmentRow>>;
    readonly setCreateStep: (id: string, step: EnvironmentCreateStep) => Effect.Effect<void>;
    /** Records the minted tailnet auth key (vault ref + Tailscale key id). */
    readonly setTailnetKey: (input: {
      readonly id: string;
      readonly keyRef: string;
      readonly keyId: string;
    }) => Effect.Effect<void>;
    /** Clears the auth-key bookkeeping once the device has joined. */
    readonly clearTailnetKey: (id: string) => Effect.Effect<void>;
    readonly setTailnetDevice: (input: {
      readonly id: string;
      readonly deviceId: string;
      readonly endpointUrl: string;
    }) => Effect.Effect<void>;
    readonly setStatusDetail: (id: string, detail: string | null) => Effect.Effect<void>;
    readonly setT3Identity: (input: {
      readonly id: string;
      readonly t3EnvironmentId: string;
    }) => Effect.Effect<void>;
    readonly setSession: (input: {
      readonly id: string;
      readonly sessionRef: string;
      readonly sessionId: string;
    }) => Effect.Effect<void>;
    readonly clearSession: (id: string) => Effect.Effect<void>;
    readonly setObservedState: (id: string, state: EnvironmentObservedState) => Effect.Effect<void>;
    readonly markError: (id: string, message: string) => Effect.Effect<void>;
    readonly markDesiredDestroyed: (input: {
      readonly id: string;
      readonly archive: boolean;
    }) => Effect.Effect<void>;
    readonly markDestroyed: (id: string) => Effect.Effect<void>;
    readonly recordStatus: (input: {
      readonly id: string;
      readonly observedState: EnvironmentObservedState;
      readonly activity: EnvironmentActivity | null;
    }) => Effect.Effect<void>;
  }
>()("t3fleet/controller/EnvironmentsRepo") {
  static readonly layer = Layer.effect(
    EnvironmentsRepo,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const fromRaw = Effect.fn("EnvironmentsRepo.fromRaw")(function* (raw: RawRow) {
        return {
          id: raw.id,
          name: raw.name,
          nodeId: raw.node_id,
          gitUrl: raw.git_url,
          gitBranch: raw.git_branch,
          imageReference: raw.image_reference,
          desiredState: raw.desired_state as EnvironmentDesiredState,
          createStep: raw.create_step as EnvironmentCreateStep,
          observedState: raw.observed_state as EnvironmentObservedState,
          endpointUrl: raw.endpoint_url,
          tailnetDeviceId: raw.tailnet_device_id,
          tsAuthKeyRef: raw.ts_authkey_ref,
          tsAuthKeyId: raw.ts_authkey_id,
          statusDetail: raw.status_detail,
          t3SessionRef: raw.t3_session_ref,
          t3SessionId: raw.t3_session_id,
          t3EnvironmentId: raw.t3_environment_id,
          activity:
            raw.activity_json === null
              ? null
              : yield* decodeActivity(raw.activity_json).pipe(Effect.orDie),
          lastStatusAtMillis: raw.last_status_at,
          error: raw.error,
          archiveOnDestroy: raw.archive_on_destroy === 1,
          createdAtMillis: raw.created_at,
          updatedAtMillis: raw.updated_at,
        } satisfies EnvironmentRow;
      });

      const find = Effect.fn("EnvironmentsRepo.find")(function* (id: string) {
        const rows = yield* sql<RawRow>`SELECT * FROM environments WHERE id = ${id}`.pipe(
          Effect.orDie,
        );
        return rows[0] === undefined ? Option.none() : Option.some(yield* fromRaw(rows[0]));
      });

      const get = Effect.fn("EnvironmentsRepo.get")(function* (id: string) {
        const found = yield* find(id);
        if (Option.isNone(found)) {
          return yield* new EnvironmentRecordNotFoundError({ environmentId: id });
        }
        return found.value;
      });

      const insert = Effect.fn("EnvironmentsRepo.insert")(function* (input: {
        readonly id: string;
        readonly name: string;
        readonly nodeId: string;
        readonly gitUrl: string;
        readonly gitBranch: string | null;
        readonly imageReference: string;
      }) {
        const now = yield* Clock.currentTimeMillis;
        yield* sql`
          INSERT INTO environments (
            id, name, node_id, git_url, git_branch, image_reference,
            desired_state, create_step, observed_state, created_at, updated_at
          ) VALUES (
            ${input.id}, ${input.name}, ${input.nodeId}, ${input.gitUrl},
            ${input.gitBranch}, ${input.imageReference},
            'running', 'scheduled', 'creating', ${now}, ${now}
          )
        `.pipe(Effect.orDie);
        return yield* get(input.id).pipe(Effect.orDie);
      });

      const list = Effect.gen(function* () {
        const rows = yield* sql<RawRow>`
          SELECT * FROM environments ORDER BY created_at ASC
        `.pipe(Effect.orDie);
        const mapped: Array<EnvironmentRow> = [];
        for (const raw of rows) {
          mapped.push(yield* fromRaw(raw));
        }
        return mapped;
      });

      const touch = Effect.fn("EnvironmentsRepo.touch")(function* (id: string) {
        const now = yield* Clock.currentTimeMillis;
        yield* sql`UPDATE environments SET updated_at = ${now} WHERE id = ${id}`.pipe(Effect.orDie);
      });

      const setCreateStep = Effect.fn("EnvironmentsRepo.setCreateStep")(function* (
        id: string,
        step: EnvironmentCreateStep,
      ) {
        yield* sql`UPDATE environments SET create_step = ${step} WHERE id = ${id}`.pipe(
          Effect.orDie,
        );
        yield* touch(id);
      });

      const setTailnetKey = Effect.fn("EnvironmentsRepo.setTailnetKey")(function* (input: {
        readonly id: string;
        readonly keyRef: string;
        readonly keyId: string;
      }) {
        yield* sql`
          UPDATE environments SET ts_authkey_ref = ${input.keyRef}, ts_authkey_id = ${input.keyId}
          WHERE id = ${input.id}
        `.pipe(Effect.orDie);
        yield* touch(input.id);
      });

      const clearTailnetKey = Effect.fn("EnvironmentsRepo.clearTailnetKey")(function* (id: string) {
        yield* sql`
          UPDATE environments SET ts_authkey_ref = NULL, ts_authkey_id = NULL WHERE id = ${id}
        `.pipe(Effect.orDie);
        yield* touch(id);
      });

      const setTailnetDevice = Effect.fn("EnvironmentsRepo.setTailnetDevice")(function* (input: {
        readonly id: string;
        readonly deviceId: string;
        readonly endpointUrl: string;
      }) {
        yield* sql`
          UPDATE environments
          SET tailnet_device_id = ${input.deviceId}, endpoint_url = ${input.endpointUrl}
          WHERE id = ${input.id}
        `.pipe(Effect.orDie);
        yield* touch(input.id);
      });

      const setStatusDetail = Effect.fn("EnvironmentsRepo.setStatusDetail")(function* (
        id: string,
        detail: string | null,
      ) {
        yield* sql`UPDATE environments SET status_detail = ${detail} WHERE id = ${id}`.pipe(
          Effect.orDie,
        );
        yield* touch(id);
      });

      const setT3Identity = Effect.fn("EnvironmentsRepo.setT3Identity")(function* (input: {
        readonly id: string;
        readonly t3EnvironmentId: string;
      }) {
        yield* sql`
          UPDATE environments SET t3_environment_id = ${input.t3EnvironmentId}
          WHERE id = ${input.id}
        `.pipe(Effect.orDie);
        yield* touch(input.id);
      });

      const setSession = Effect.fn("EnvironmentsRepo.setSession")(function* (input: {
        readonly id: string;
        readonly sessionRef: string;
        readonly sessionId: string;
      }) {
        yield* sql`
          UPDATE environments
          SET t3_session_ref = ${input.sessionRef}, t3_session_id = ${input.sessionId}
          WHERE id = ${input.id}
        `.pipe(Effect.orDie);
        yield* touch(input.id);
      });

      const clearSession = Effect.fn("EnvironmentsRepo.clearSession")(function* (id: string) {
        yield* sql`
          UPDATE environments SET t3_session_ref = NULL, t3_session_id = NULL WHERE id = ${id}
        `.pipe(Effect.orDie);
        yield* touch(id);
      });

      const setObservedState = Effect.fn("EnvironmentsRepo.setObservedState")(function* (
        id: string,
        state: EnvironmentObservedState,
      ) {
        yield* sql`UPDATE environments SET observed_state = ${state} WHERE id = ${id}`.pipe(
          Effect.orDie,
        );
        yield* touch(id);
      });

      const markError = Effect.fn("EnvironmentsRepo.markError")(function* (
        id: string,
        message: string,
      ) {
        yield* sql`
          UPDATE environments SET observed_state = 'error', error = ${message}, status_detail = NULL
          WHERE id = ${id}
        `.pipe(Effect.orDie);
        yield* touch(id);
      });

      const markDesiredDestroyed = Effect.fn("EnvironmentsRepo.markDesiredDestroyed")(
        function* (input: { readonly id: string; readonly archive: boolean }) {
          yield* sql`
          UPDATE environments
          SET desired_state = 'destroyed', observed_state = 'destroying',
              archive_on_destroy = ${input.archive ? 1 : 0}, error = NULL
          WHERE id = ${input.id}
        `.pipe(Effect.orDie);
          yield* touch(input.id);
        },
      );

      const markDestroyed = Effect.fn("EnvironmentsRepo.markDestroyed")(function* (id: string) {
        yield* sql`
          UPDATE environments
          SET observed_state = 'destroyed', endpoint_url = NULL, tailnet_device_id = NULL,
              ts_authkey_ref = NULL, ts_authkey_id = NULL, status_detail = NULL
          WHERE id = ${id}
        `.pipe(Effect.orDie);
        yield* touch(id);
      });

      const recordStatus = Effect.fn("EnvironmentsRepo.recordStatus")(function* (input: {
        readonly id: string;
        readonly observedState: EnvironmentObservedState;
        readonly activity: EnvironmentActivity | null;
      }) {
        const now = yield* Clock.currentTimeMillis;
        const activityJson =
          input.activity === null ? null : yield* encodeActivity(input.activity).pipe(Effect.orDie);
        // Activity is only overwritten by fresh data — an unreachable poll
        // keeps the last known activity for phase 7's idle window logic.
        if (activityJson === null) {
          yield* sql`
            UPDATE environments
            SET observed_state = ${input.observedState}, last_status_at = ${now}, updated_at = ${now}
            WHERE id = ${input.id}
          `.pipe(Effect.orDie);
        } else {
          yield* sql`
            UPDATE environments
            SET observed_state = ${input.observedState}, activity_json = ${activityJson},
                last_status_at = ${now}, updated_at = ${now}
            WHERE id = ${input.id}
          `.pipe(Effect.orDie);
        }
      });

      return EnvironmentsRepo.of({
        insert,
        get,
        find,
        list,
        setCreateStep,
        setTailnetKey,
        clearTailnetKey,
        setTailnetDevice,
        setStatusDetail,
        setT3Identity,
        setSession,
        clearSession,
        setObservedState,
        markError,
        markDesiredDestroyed,
        markDestroyed,
        recordStatus,
      });
    }),
  );
}
