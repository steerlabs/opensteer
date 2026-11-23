import {
  CamelCasePlugin,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from "kysely";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { DatabaseSchema } from "./schema.js";
import { keptMessageSql } from "./thread-row-mappers.js";

function dummyDatabase(): Kysely<DatabaseSchema> {
  return new Kysely<DatabaseSchema>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (database) => new PostgresIntrospector(database),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    plugins: [new CamelCasePlugin()],
  });
}

describe("keptMessageSql alias parameter (P5)", () => {
  it("defaults to 'messages' and accepts a custom table alias", () => {
    const db = dummyDatabase();
    const defaultSql = db.selectFrom("messages").select("id").where(keptMessageSql()).compile().sql;
    const aliasedSql = db
      .selectFrom("messages as message")
      .select("message.id")
      .where(keptMessageSql("message"))
      .compile().sql;

    expect(defaultSql).toContain("\"messages\".\"author\"->>'kind' is distinct from 'team-member'");
    expect(aliasedSql).toContain("\"message\".\"author\"->>'kind' is distinct from 'team-member'");
  });

  it("uses keptMessageSql in agent-thread-history.ts instead of inline team-member SQL", () => {
    const source = readFileSync(new URL("./agent-thread-history.ts", import.meta.url), "utf8");
    expect(source).toContain('keptMessageSql("message")');
    expect(source).not.toContain("team-member");
  });
});
