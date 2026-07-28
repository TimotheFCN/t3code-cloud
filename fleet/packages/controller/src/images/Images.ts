import * as NodeCrypto from "node:crypto";

import type { ImageSummary } from "@t3fleet/shared/image";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export class ImageNotFoundError extends Schema.TaggedErrorClass<ImageNotFoundError>()(
  "ImageNotFoundError",
  {
    imageId: Schema.String,
  },
) {}

export class ImageAlreadyExistsError extends Schema.TaggedErrorClass<ImageAlreadyExistsError>()(
  "ImageAlreadyExistsError",
  {
    reference: Schema.String,
  },
) {}

interface ImageRow {
  readonly id: string;
  readonly reference: string;
  readonly digest: string | null;
  readonly is_current: number;
  readonly created_at: number;
  readonly updated_at: number;
}

const toSummary = (row: ImageRow): ImageSummary => ({
  id: row.id,
  reference: row.reference,
  digest: row.digest,
  isCurrent: row.is_current === 1,
  createdAtMillis: row.created_at,
  updatedAtMillis: row.updated_at,
});

/**
 * The controller's base-image registry (`architecture.md` §3 `images`).
 * Rows store pullable references plus the digest observed on pull; exactly
 * one image is "current" — the one new environments are created from
 * (enforced by a partial unique index, maintained transactionally here).
 */
export class Images extends Context.Service<
  Images,
  {
    readonly register: (input: {
      readonly reference: string;
    }) => Effect.Effect<ImageSummary, ImageAlreadyExistsError>;
    readonly list: Effect.Effect<ReadonlyArray<ImageSummary>>;
    readonly get: (imageId: string) => Effect.Effect<ImageSummary, ImageNotFoundError>;
    readonly setCurrent: (imageId: string) => Effect.Effect<ImageSummary, ImageNotFoundError>;
    readonly recordDigest: (input: {
      readonly imageId: string;
      readonly digest: string;
    }) => Effect.Effect<void, ImageNotFoundError>;
    readonly current: Effect.Effect<Option.Option<ImageSummary>>;
  }
>()("t3fleet/controller/Images") {
  static readonly layer = Layer.effect(
    Images,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const get = Effect.fn("Images.get")(function* (imageId: string) {
        const rows = yield* sql<ImageRow>`SELECT * FROM images WHERE id = ${imageId}`.pipe(
          Effect.orDie,
        );
        if (rows[0] === undefined) {
          return yield* new ImageNotFoundError({ imageId });
        }
        return toSummary(rows[0]);
      });

      const register = Effect.fn("Images.register")(function* (input: {
        readonly reference: string;
      }) {
        const existing = yield* sql<{
          id: string;
        }>`SELECT id FROM images WHERE reference = ${input.reference}`.pipe(Effect.orDie);
        if (existing.length > 0) {
          return yield* new ImageAlreadyExistsError({ reference: input.reference });
        }
        const id = `img-${NodeCrypto.randomBytes(6).toString("hex")}`;
        const now = yield* Clock.currentTimeMillis;
        // The first registered image becomes current automatically so a
        // fresh install has a usable default without a second call.
        const currentRows = yield* sql<{
          id: string;
        }>`SELECT id FROM images WHERE is_current = 1`.pipe(Effect.orDie);
        const isCurrent = currentRows.length === 0 ? 1 : 0;
        yield* sql`
          INSERT INTO images (id, reference, digest, is_current, created_at, updated_at)
          VALUES (${id}, ${input.reference}, NULL, ${isCurrent}, ${now}, ${now})
        `.pipe(Effect.orDie);
        return yield* get(id).pipe(Effect.orDie);
      });

      const list = Effect.gen(function* () {
        const rows = yield* sql<ImageRow>`SELECT * FROM images ORDER BY created_at ASC`.pipe(
          Effect.orDie,
        );
        return rows.map(toSummary);
      });

      const setCurrent = Effect.fn("Images.setCurrent")(function* (imageId: string) {
        yield* get(imageId);
        const now = yield* Clock.currentTimeMillis;
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`UPDATE images SET is_current = 0, updated_at = ${now} WHERE is_current = 1`;
              yield* sql`UPDATE images SET is_current = 1, updated_at = ${now} WHERE id = ${imageId}`;
            }),
          )
          .pipe(Effect.orDie);
        return yield* get(imageId);
      });

      const recordDigest = Effect.fn("Images.recordDigest")(function* (input: {
        readonly imageId: string;
        readonly digest: string;
      }) {
        yield* get(input.imageId);
        const now = yield* Clock.currentTimeMillis;
        yield* sql`
          UPDATE images SET digest = ${input.digest}, updated_at = ${now} WHERE id = ${input.imageId}
        `.pipe(Effect.orDie);
      });

      const current = Effect.gen(function* () {
        const rows = yield* sql<ImageRow>`SELECT * FROM images WHERE is_current = 1`.pipe(
          Effect.orDie,
        );
        return rows[0] === undefined ? Option.none() : Option.some(toSummary(rows[0]));
      });

      return Images.of({ register, list, get, setCurrent, recordDigest, current });
    }),
  );
}
