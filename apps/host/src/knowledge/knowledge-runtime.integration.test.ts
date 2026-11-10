import { createId } from "@opensteer/core";
import { createDatabase, knowledgeExecutorRole } from "@opensteer/database";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
} from "@opensteer/database/test-support/database";
import { sql } from "kysely";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  freePort,
  personalMachineAccessHostConfig,
} from "../runtime/machine-access.test-support.js";
import { createHostRuntime } from "../runtime/runtime.js";

async function personalHost(knowledge: boolean) {
  const clone = await cloneTestDatabase("host");
  return ownTestDatabaseProducer(clone.url, async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-knowledge-host-"));
    const port = await freePort();
    const runtime = await createHostRuntime({
      ...personalMachineAccessHostConfig(port, dataDirectory, clone.url, createId("environment")),
      knowledge,
    });
    await runtime.listen();
    const database = createDatabase({ connectionString: clone.url, maxConnections: 1 });
    const role = await knowledgeExecutorRole(database);
    return {
      async capabilities() {
        const response = await fetch(`http://127.0.0.1:${port}/.well-known/opensteer`);
        return ((await response.json()) as { capabilities: string[] }).capabilities;
      },
      async executor() {
        const { rows } = await sql<{ password: boolean; connections: string }>`
          select rolpassword is not null as password,
            (select count(*)::text from pg_catalog.pg_stat_activity
             where usename = ${role}) as connections
          from pg_catalog.pg_authid where rolname = ${role}
        `.execute(database);
        return rows[0] ?? null;
      },
      async close() {
        await runtime.close();
        if (knowledge)
          await sql`drop owned by ${sql.id(role)}; drop role ${sql.id(role)}`.execute(database);
        await database.destroy();
        await rm(dataDirectory, { recursive: true, force: true });
      },
    };
  });
}

// Skip outside the integration launcher, which supplies an isolated PostgreSQL clone.
const integration = process.env.OPENSTEER_TEST_DATABASE_URL ? describe : describe.skip;
integration("the knowledge trial on a Personal Host", () => {
  it("is off by default: no capability, no restricted login and no connection", async () => {
    const host = await personalHost(false);
    expect(await host.capabilities()).not.toContain("knowledge-sql-v1");
    expect(await host.executor()).toBeNull();
  });

  it("when enabled, advertises the capability and gives the restricted login a password", async () => {
    const host = await personalHost(true);
    expect(await host.capabilities()).toContain("knowledge-sql-v1");
    expect(await host.executor()).toEqual({ password: true, connections: "0" });
  });
});
