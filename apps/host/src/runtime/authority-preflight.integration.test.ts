import { createDatabase, type DatabaseSchema } from "@opensteer/database";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
} from "@opensteer/database/test-support/database";
import { sql, type Kysely } from "kysely";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { freePort, machineAccessHostConfig } from "./machine-access.test-support.js";
import { createHostRuntime } from "./runtime.js";

// Real startup requires the launcher-owned PostgreSQL database.
const integration = process.env.OPENSTEER_TEST_DATABASE_URL ? describe : describe.skip;

async function fingerprint(database: Kysely<DatabaseSchema>) {
  const schema = await sql`
    select c.relname, c.relkind, a.attnum, a.attname, a.atttypid, a.attnotnull,
      pg_get_expr(d.adbin, d.adrelid) as default_value
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    left join pg_attribute a on a.attrelid = c.oid and a.attnum > 0
    left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
    where n.nspname = 'public' order by c.relname, a.attnum
  `.execute(database);
  const tables = await sql<{
    name: string;
  }>`select tablename as name from pg_tables where schemaname = 'public' order by tablename`.execute(
    database,
  );
  const content = [];
  for (const { name } of tables.rows) {
    content.push({
      name,
      rows: (
        await sql`select to_jsonb(t) as row from ${sql.id("public", name)} t order by to_jsonb(t)::text`.execute(
          database,
        )
      ).rows,
    });
  }
  return { schema: schema.rows, content };
}

integration("pre-migration authority at real Host startup", () => {
  it.for(["server-2", "personal-2", "unknown-model", "unknown-schema", "inconsistent-schema"])(
    "refuses %s without changing schema or content",
    async (state, context) => {
      const clone = await cloneTestDatabase("host");
      const { database } = await ownTestDatabaseProducer(clone.url, async () => {
        const database = createDatabase({ connectionString: clone.url });
        return { database, close: () => database.destroy() };
      });
      await sql`drop schema public cascade; create schema public; create table sentinel (value text); insert into sentinel values ('preserve')`.execute(
        database,
      );
      if (state !== "unknown-schema") {
        await sql`create table deployments (deployment_shape jsonb not null, id text, singleton_key text, active_host_instance_id text, canonical_origin text, lifecycle text, created_at timestamptz, updated_at timestamptz)`.execute(
          database,
        );
        await sql`alter table deployments add column authority_model_version integer`.execute(
          database,
        );
        if (state !== "inconsistent-schema") {
          const shape = JSON.stringify({
            kind: state === "personal-2" ? "personal" : "server",
            defaultWorkspaceBacking: "local-directory",
          });
          await sql`insert into deployments (deployment_shape, authority_model_version) values (${shape}::jsonb, ${state === "unknown-model" ? 3 : state.endsWith("-2") ? 2 : 1})`.execute(
            database,
          );
        }
      }
      if (state === "inconsistent-schema")
        await sql`alter table deployments drop column active_host_instance_id`.execute(database);
      const directory = await mkdtemp(join(tmpdir(), "opensteer-preflight-"));
      context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
      const config = machineAccessHostConfig(
        await freePort(),
        directory,
        new URL("http://127.0.0.1:9"),
        clone.url,
        "closed",
      );
      const before = await fingerprint(database);
      await expect(createHostRuntime(config)).rejects.toMatchObject({
        code: "conflict",
        message: expect.stringContaining("Unsupported Deployment authority"),
      });
      expect(await fingerprint(database)).toEqual(before);
    },
  );

  it("initializes a truly empty Personal database at model 1 and restarts", async (context) => {
    const clone = await cloneTestDatabase("host");
    const { database } = await ownTestDatabaseProducer(clone.url, async () => {
      const database = createDatabase({ connectionString: clone.url });
      return { database, close: () => database.destroy() };
    });
    await sql`drop schema public cascade; create schema public`.execute(database);
    const directory = await mkdtemp(join(tmpdir(), "opensteer-personal-preflight-"));
    context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const base = machineAccessHostConfig(
      await freePort(),
      directory,
      new URL("http://127.0.0.1:9"),
      clone.url,
      "closed",
    );
    const config = {
      ...base,
      acceptsExternalRunners: false,
      exposure: "loopback" as const,
      identity: {
        ...base.identity,
        initialOwnerEnrollment: undefined,
        localPasswordEnabled: false,
        localOwnerClaimToken: "claim-".padEnd(40, "a"),
      },
      workspace: {
        ...base.workspace,
        shape: { ...base.workspace.shape, kind: "personal" as const },
      },
    };
    for (let i = 0; i < 2; i++) {
      const runtime = await createHostRuntime(config);
      try {
        expect(
          (
            await database
              .selectFrom("deployments")
              .select("authorityModelVersion")
              .executeTakeFirstOrThrow()
          ).authorityModelVersion,
        ).toBe(1);
      } finally {
        await runtime.close();
      }
    }
  });
});
