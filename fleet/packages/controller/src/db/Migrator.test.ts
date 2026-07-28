import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as Database from "./Database.ts";

const listTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
  `;
  return rows.map((row) => row.name);
});

const countApplied = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM migrations`;
  return rows[0]!.n;
});

describe("Migrator", () => {
  it.effect("creates the phase-1 schema", () =>
    Effect.gen(function* () {
      const tables = yield* listTables;
      expect(tables).toContain("nodes");
      expect(tables).toContain("join_tokens");
      expect(tables).toContain("events");
      expect(tables).toContain("migrations");
    }).pipe(Effect.provide(Database.layerMemory)),
  );

  it.effect("is idempotent across restarts on the same database file", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() =>
        NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "fleet-migrator-")),
      );
      const filename = NodePath.join(dir, "controller.sqlite");

      // First "controller start".
      const first = yield* countApplied.pipe(Effect.provide(Database.layer({ filename })));
      // Second "controller start" against the same file: migrator must skip
      // everything already applied.
      const second = yield* countApplied.pipe(Effect.provide(Database.layer({ filename })));

      expect(first).toBe(1);
      expect(second).toBe(1);

      yield* Effect.promise(() => NodeFs.rm(dir, { recursive: true, force: true }));
    }),
  );
});
