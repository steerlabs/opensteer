import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Effect } from "effect";
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

const path = "migrations/0001_notes.sql";
const first = `CREATE TABLE notes (id TEXT);\nINSERT INTO notes SELECT id FROM ${legacy.from};\n`;

test("renames complete identifiers in any case, never data or comments", async () => {
  expect(rewriteUpstreamFile(path, first)).toBe(first.replace(legacy.from, legacy.to));
  const commented = `-- reads ${legacy.to} once renamed\n${first}`;
  expect(rewriteUpstreamFile(path, commented)).toBe(
    `-- reads ${legacy.to} once renamed\n${first.replace(legacy.from, legacy.to)}`,
  );
  // Data a migration writes is never renamed.
  const literal = `CREATE TABLE notes (id TEXT);\nINSERT INTO notes VALUES ('${legacy.from}');\n`;
  expect(rewriteUpstreamFile(path, literal)).toBe(literal);

  // SQLite reads an identifier in any case and quoted; each becomes the current name.
  const upper = legacy.from.toUpperCase();
  const quoted = `CREATE TABLE notes (id TEXT);\nINSERT INTO notes SELECT id FROM "${upper}";\nINSERT INTO notes SELECT id FROM [${legacy.from}];\nINSERT INTO notes SELECT id FROM ${upper}_more;\n`;
  expect(rewriteUpstreamFile(path, quoted)).toBe(
    `CREATE TABLE notes (id TEXT);\nINSERT INTO notes SELECT id FROM "${legacy.to}";\nINSERT INTO notes SELECT id FROM [${legacy.to}];\nINSERT INTO notes SELECT id FROM ${upper}_more;\n`,
  );
  // A database has only the current names, so the rewritten migration runs there.
  const fresh = new DatabaseSync(":memory:");
  const upperOnly = `CREATE TABLE notes (id TEXT);\nINSERT INTO notes SELECT id FROM ${upper};\n`;
  await Effect.runPromise(
    migrate(storage(fresh), [{ path, content: rewriteUpstreamFile(path, upperOnly) as string }]),
  );
  expect(tables(fresh)).toEqual([`table ${history.to}`, `view ${legacy.to}`].sort());
});
