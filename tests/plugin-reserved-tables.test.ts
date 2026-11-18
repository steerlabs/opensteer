import { createHash } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Effect, Exit } from "effect";
import { expect, test } from "vitest";
import type { AppSqlStorage } from "../packages/plugin-engine/apps/src/contracts/sql.ts";
import { migrate } from "../packages/plugin-engine/apps/src/implementation/sql.ts";
import { rewriteUpstreamFile } from "@opensteer/plugin-engine-catalog";
import names from "../packages/plugin-engine/upstream-names.json" with { type: "json" };

// The reserved tables' names before and after the rename come from the rules data.
const table = (suffix: string) => {
  const rule = names.rules.find(
    (candidate) => candidate.scope === "reserved-table" && candidate.to.endsWith(suffix),
  );
  if (rule === undefined) throw new Error(suffix);
  return rule;
};
const history = table("_migrations");
const receipts = table("_step_receipts");
const legacy = table("_legacy_rows");

/** A Durable Object's SQL storage over an in-memory SQLite database. */
const storage = (database: DatabaseSync): AppSqlStorage => ({
  sql: {
    exec: (query, ...bindings) => {
      const rows = /^\s*(?:SELECT|PRAGMA)/iu.test(query)
        ? (database.prepare(query).all(...(bindings as SQLInputValue[])) as Record<
            string,
            string
          >[])
        : bindings.length > 0
          ? (database.prepare(query).run(...(bindings as SQLInputValue[])), [])
          : (database.exec(query), []);
      return {
        columnNames: Object.keys(rows[0] ?? {}),
        rowsRead: rows.length,
        rowsWritten: 0,
        toArray: () => rows,
      };
    },
  },
  transactionSync: (work) => {
    database.exec("BEGIN");
    try {
      const result = work();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  },
});
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const tables = (database: DatabaseSync) =>
  (
    database
      .prepare(
        "SELECT name, type FROM sqlite_master WHERE name LIKE '\\_%' ESCAPE '\\' ORDER BY name",
      )
      .all() as { name: string; type: string }[]
  )
    .map(({ name, type }) => `${type} ${name}`)
    .sort();

/** A database as a framework from before the rename left it, after one migration. */
const upstreamDatabase = (first: string) => {
  const database = new DatabaseSync(":memory:");
  database.exec(
    `CREATE TABLE ${history.from} (id INTEGER PRIMARY KEY, path TEXT NOT NULL, hash TEXT NOT NULL, applied_at TEXT NOT NULL)`,
  );
  database.exec(
    `CREATE TABLE ${receipts.from} (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL) WITHOUT ROWID`,
  );
  database.exec(`INSERT INTO ${receipts.from} VALUES ('step', 'fingerprint', '"done"')`);
  database.exec(`CREATE VIEW ${legacy.from} (table_name, id, body) AS SELECT '', '', '' WHERE 0`);
  database.exec(first);
  database
    .prepare(`INSERT INTO ${history.from} VALUES (1, 'migrations/0001_notes.sql', ?, 'then')`)
    .run(sha256(first));
  return database;
};
const first = `CREATE TABLE notes (id TEXT);\nINSERT INTO notes SELECT id FROM ${legacy.from};\n`;
const second = { path: "migrations/0002_more.sql", content: "CREATE TABLE more (id TEXT);" };

test("renames the reserved tables once and keeps a rewritten migration's history", async () => {
  const database = upstreamDatabase(first);
  const rewritten = rewriteUpstreamFile("migrations/0001_notes.sql", first);
  expect(rewritten).toContain(legacy.to);
  const files = [{ path: "migrations/0001_notes.sql", content: rewritten }, second];

  const applied = await Effect.runPromise(migrate(storage(database), files));
  expect(applied).toEqual([{ id: 2, name: second.path }]);
  expect(tables(database)).toEqual(
    [`table ${history.to}`, `table ${receipts.to}`, `view ${legacy.to}`].sort(),
  );
  expect(database.prepare(`SELECT result FROM ${receipts.to}`).all()).toEqual([
    { result: '"done"' },
  ]);
  expect(database.prepare(`SELECT id, hash FROM ${history.to} ORDER BY id`).all()).toEqual([
    { id: 1, hash: sha256(rewritten) },
    { id: 2, hash: sha256(second.content) },
  ]);

  // A second deploy of the same build finds nothing to rename or apply.
  expect(await Effect.runPromise(migrate(storage(database), files))).toEqual([]);
});

test("still refuses an applied migration that changed beyond the rename", async () => {
  const database = upstreamDatabase(first);
  const changed = rewriteUpstreamFile("migrations/0001_notes.sql", first) + "-- edited\n";
  const exit = await Effect.runPromiseExit(
    migrate(storage(database), [{ path: "migrations/0001_notes.sql", content: changed }]),
  );
  expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("MigrationHistoryChanged");
  // The failed run rolled back, so the database is still as the earlier framework left it.
  expect(tables(database)).toContain(`table ${history.from}`);
});
