import * as Schema from "effect/Schema";

/**
 * A base image known to the controller registry. `reference` is the pullable
 * OCI reference (e.g. `registry.example/t3env:1.2.0`); `digest` is recorded
 * after the first successful pull. Exactly one image is "current" — the one
 * new environments are created from.
 */
export const ImageSummary = Schema.Struct({
  id: Schema.String,
  reference: Schema.String,
  digest: Schema.NullOr(Schema.String),
  isCurrent: Schema.Boolean,
  createdAtMillis: Schema.Number,
  updatedAtMillis: Schema.Number,
});
export type ImageSummary = typeof ImageSummary.Type;

/** Per-node outcome of a controller-orchestrated image pull. */
export const ImagePullResult = Schema.Struct({
  nodeId: Schema.String,
  ok: Schema.Boolean,
  digest: Schema.optional(Schema.NullOr(Schema.String)),
  error: Schema.optional(Schema.String),
});
export type ImagePullResult = typeof ImagePullResult.Type;
