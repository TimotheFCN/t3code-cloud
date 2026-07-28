import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const defaultMigrationsDir = fileURLToPath(new URL("./migrations/", import.meta.url));

/**
 * Forward-only migrator: applies `NNN_name.sql` files in filename order,
 * recording each applied file in the `migrations` table. Files already
 * recorded are skipped, so running the migrator repeatedly is a no-op.
 *
 * Constraint on migration files: plain statements separated by `;` at the end
 * of a line — no triggers or other constructs containing embedded semicolons.
 */
export const run = Effect.fn("Migrator.run")(function* (options?: {
  readonly migrationsDir?: string;
}) {
  const migrationsDir = options?.migrationsDir ?? defaultMigrationsDir;
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`;

  const entries = yield* Effect.promise(() => NodeFs.readdir(migrationsDir));
  const files = entries.filter((entry) => entry.endsWith(".sql")).toSorted();

  const appliedRows = yield* sql<{ name: string }>`SELECT name FROM migrations`;
  const applied = new Set(appliedRows.map((row) => row.name));

  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }
    const contents = yield* Effect.promise(() =>
      NodeFs.readFile(NodePath.join(migrationsDir, file), "utf8"),
    );
    const statements = contents
      .split(/;\s*(?:\r?\n|$)/)
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const statement of statements) {
          yield* sql.unsafe(statement);
        }
        const now = yield* Clock.currentTimeMillis;
        yield* sql`INSERT INTO migrations (name, applied_at) VALUES (${file}, ${now})`;
      }),
    );
    yield* Effect.logInfo(`applied migration ${file}`);
  }
});
