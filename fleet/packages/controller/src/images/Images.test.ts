import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Database from "../db/Database.ts";
import { Images } from "./Images.ts";

const TestLayer = Images.layer.pipe(Layer.provideMerge(Database.layerMemory));

describe("Images", () => {
  it.effect("registers images; the first one becomes current", () =>
    Effect.gen(function* () {
      const images = yield* Images;

      expect(Option.isNone(yield* images.current)).toBe(true);

      const first = yield* images.register({ reference: "t3env:0.1.0" });
      expect(first.reference).toBe("t3env:0.1.0");
      expect(first.isCurrent).toBe(true);
      expect(first.digest).toBeNull();

      const second = yield* images.register({ reference: "t3env:0.2.0" });
      expect(second.isCurrent).toBe(false);

      const all = yield* images.list;
      expect(all).toHaveLength(2);
      expect(Option.getOrThrow(yield* images.current).id).toBe(first.id);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("rejects duplicate references", () =>
    Effect.gen(function* () {
      const images = yield* Images;
      yield* images.register({ reference: "t3env:dup" });
      const outcome = yield* images.register({ reference: "t3env:dup" }).pipe(Effect.flip);
      expect(outcome._tag).toBe("ImageAlreadyExistsError");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("moves the current flag atomically", () =>
    Effect.gen(function* () {
      const images = yield* Images;
      const first = yield* images.register({ reference: "t3env:0.1.0" });
      const second = yield* images.register({ reference: "t3env:0.2.0" });

      const promoted = yield* images.setCurrent(second.id);
      expect(promoted.isCurrent).toBe(true);

      const all = yield* images.list;
      expect(all.filter((image) => image.isCurrent)).toHaveLength(1);
      expect(all.find((image) => image.id === first.id)!.isCurrent).toBe(false);
      expect(Option.getOrThrow(yield* images.current).id).toBe(second.id);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("records the pulled digest", () =>
    Effect.gen(function* () {
      const images = yield* Images;
      const image = yield* images.register({ reference: "t3env:0.1.0" });
      yield* images.recordDigest({
        imageId: image.id,
        digest: "t3env@sha256:abc",
      });
      const all = yield* images.list;
      expect(all[0]!.digest).toBe("t3env@sha256:abc");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("fails on unknown image ids", () =>
    Effect.gen(function* () {
      const images = yield* Images;
      const outcome = yield* images.setCurrent("img-missing").pipe(Effect.flip);
      expect(outcome._tag).toBe("ImageNotFoundError");
    }).pipe(Effect.provide(TestLayer)),
  );
});
