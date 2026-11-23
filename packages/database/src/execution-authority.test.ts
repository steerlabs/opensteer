import { createId } from "@opensteer/core";
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
import { threadExecutionAdmitted } from "./execution-authority.js";
import type { DatabaseSchema } from "./schema.js";
import { markWorkHomeDatabase } from "./work-home-context.js";

function dummyDatabase(workHome = false): Kysely<DatabaseSchema> {
  const db = new Kysely<DatabaseSchema>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (database) => new PostgresIntrospector(database),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    plugins: [new CamelCasePlugin()],
  });
  if (workHome) markWorkHomeDatabase(db);
  return db;
}

describe("execution admission single SQL predicate (rule 1)", () => {
  it("exports threadExecutionAdmitted and adds the work-home policy clause only on work homes", () => {
    const userId = createId("user");
    const personalDb = dummyDatabase(false);
    const workHomeDb = dummyDatabase(true);
    const personalSql = personalDb
      .selectFrom("threads")
      .select("threads.environmentId")
      .where(threadExecutionAdmitted(personalDb, userId))
      .compile().sql;
    const workHomeSql = workHomeDb
      .selectFrom("threads")
      .select("threads.environmentId")
      .where(threadExecutionAdmitted(workHomeDb, userId))
      .compile().sql;

    expect(personalSql).toContain('"personal_settings"');
    expect(personalSql).toContain('"execution_environments"');
    expect(personalSql).toContain('"runners"');
    expect(personalSql).not.toContain('"work_home_policy"');

    expect(workHomeSql).toContain('"work_home_policy"');
    expect(workHomeSql).toContain('"personal_settings"');
    expect(workHomeSql).toContain('"execution_environments"');
    expect(workHomeSql).toContain('"runners"');
  });

  it("keeps execution-admission SQL clauses inside execution-authority.ts instead of request-agent-response.ts", () => {
    const source = readFileSync(new URL("./request-agent-response.ts", import.meta.url), "utf8");
    expect(source).toContain("threadExecutionAdmitted");
    expect(source).not.toContain("workHomePolicy");
    expect(source).not.toContain("personalSettings");
    expect(source).not.toContain("agentHomeComputerId");
    expect(source).not.toContain("executionEnvironments");
  });
});
