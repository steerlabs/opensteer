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

describe("execution admission single SQL predicate (rule 1)", () => {
  it("exports threadExecutionAdmitted checking owner, agent home environment, and runner", () => {
    const userId = createId("user");
    const sqlText = dummyDatabase()
      .selectFrom("threads")
      .select("threads.environmentId")
      .where(threadExecutionAdmitted(userId))
      .compile().sql;

    expect(sqlText).toContain('"personal_settings"');
    expect(sqlText).toContain('"users"');
    expect(sqlText).toContain('"execution_environments"');
    expect(sqlText).toContain('"runners"');
  });

  it("keeps execution-admission SQL clauses inside execution-authority.ts instead of request-agent-response.ts", () => {
    const source = readFileSync(new URL("./request-agent-response.ts", import.meta.url), "utf8");
    expect(source).toContain("threadExecutionAdmitted");
    expect(source).not.toContain("personalSettings");
    expect(source).not.toContain("agentHomeComputerId");
    expect(source).not.toContain("executionEnvironments");
  });
});
