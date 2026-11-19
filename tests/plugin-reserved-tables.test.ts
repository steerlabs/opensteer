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
const path = "migrations/0001_notes.sql";
/** Migrate an upstream database whose first migration was `original` with `candidate` offered. */
const offer = (original: string, candidate: string, originals = [{ path, content: original }]) => {
  const database = upstreamDatabase(original);
  return {
    database,
    exit: Effect.runPromiseExit(
      migrate(storage(database), [{ path, content: candidate }], originals),
    ),
  };
};
const refused = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && JSON.stringify(exit.cause).includes("MigrationHistoryChanged");

test("renames the reserved tables once and keeps a rewritten migration's history", async () => {
  const database = upstreamDatabase(first);
  const rewritten = rewriteUpstreamFile(path, first) as string;
  expect(rewritten).toBe(first.replace(legacy.from, legacy.to));
  const files = [{ path, content: rewritten }, second];
  const originals = [{ path, content: first }];

  const applied = await Effect.runPromise(migrate(storage(database), files, originals));
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

  // The same deploy again, as after a crash before its version was recorded active, finds
  // nothing to rename or apply.
  expect(await Effect.runPromise(migrate(storage(database), files, originals))).toEqual([]);
});

test("keeps history only for the exact rename of the retained original", async () => {
  const exact = rewriteUpstreamFile(path, first) as string;
  // Without the active version's retained bytes a renamed migration is a changed one.
  const blind = offer(first, exact, []);
  expect(refused(await blind.exit)).toBe(true);
  expect(tables(blind.database)).toContain(`table ${history.from}`);

  // A real schema change is refused, and the failed run leaves the database as it was.
  const altered = offer(first, exact.replace("id TEXT", "id INTEGER"));
  expect(refused(await altered.exit)).toBe(true);
  expect(tables(altered.database)).toContain(`table ${history.from}`);

  // Data a migration writes is never renamed: a string literal changed to the new spelling is a
  // change, as is a rename the rewrite would not make.
  const literal = `CREATE TABLE notes (id TEXT);\nINSERT INTO notes VALUES ('${legacy.from}');\n`;
  expect(rewriteUpstreamFile(path, literal)).toBe(literal);
  expect(refused(await offer(literal, literal.replace(legacy.from, legacy.to)).exit)).toBe(true);
  const both = `${first}INSERT INTO notes SELECT id FROM ${legacy.from};\n`;
  expect(refused(await offer(both, both.replace(legacy.from, legacy.to)).exit)).toBe(true);
});

test("renames complete identifiers in any case, and leaves comments that already use the new name", async () => {
  const commented = `-- reads ${legacy.to} once renamed\n${first}`;
  const renamed = rewriteUpstreamFile(path, commented) as string;
  expect(renamed).toBe(
    `-- reads ${legacy.to} once renamed\n${first.replace(legacy.from, legacy.to)}`,
  );
  const kept = offer(commented, renamed);
  expect(Exit.isSuccess(await kept.exit)).toBe(true);
  expect(tables(kept.database)).toContain(`table ${history.to}`);

  // SQLite reads an identifier in any case and quoted; each becomes the current name.
  const upper = legacy.from.toUpperCase();
  const quoted = `CREATE TABLE notes (id TEXT);\nINSERT INTO notes SELECT id FROM "${upper}";\nINSERT INTO notes SELECT id FROM [${legacy.from}];\nINSERT INTO notes SELECT id FROM ${upper}_more;\n`;
  expect(rewriteUpstreamFile(path, quoted)).toBe(
    `CREATE TABLE notes (id TEXT);\nINSERT INTO notes SELECT id FROM "${legacy.to}";\nINSERT INTO notes SELECT id FROM [${legacy.to}];\nINSERT INTO notes SELECT id FROM ${upper}_more;\n`,
  );
  // A fresh database has only the current names, so the rewritten migration runs there.
  const fresh = new DatabaseSync(":memory:");
  const upperOnly = `CREATE TABLE notes (id TEXT);\nINSERT INTO notes SELECT id FROM ${upper};\n`;
  await Effect.runPromise(
    migrate(storage(fresh), [{ path, content: rewriteUpstreamFile(path, upperOnly) as string }]),
  );
  expect(tables(fresh)).toContain(`view ${legacy.to}`);
});

test("refuses a database that has a reserved table under both names", async () => {
  const database = upstreamDatabase(first);
  database.exec(
    `CREATE TABLE ${receipts.to} (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL) WITHOUT ROWID`,
  );
  const exit = await Effect.runPromiseExit(
    migrate(
      storage(database),
      [{ path, content: rewriteUpstreamFile(path, first) as string }],
      [{ path, content: first }],
    ),
  );
  expect(refused(exit)).toBe(true);
  expect(tables(database)).toContain(`table ${receipts.from}`);
});
