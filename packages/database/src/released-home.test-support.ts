import { createId } from "@opensteer/core";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql, type Kysely } from "kysely";
import { Client } from "pg";
import { seedPersonalFixture } from "./personal-fixture.test-support.js";
import type { DatabaseSchema } from "./schema.js";

/**
 * An empty `public` schema in a clone of the latest template: what was there is set aside under
 * another name (dropped with the clone) rather than dropped, which would lock every table at once.
 */
export function emptyPublicSchema(): string {
  const aside = `replaced_${randomBytes(6).toString("hex")}`;
  // An extension the test template installed (the lock-order checker's) comes back to public.
  // The migrator finds its ledger, and the lock-order checker triggers, by name in any schema,
  // so those of the old schema go.
  return `alter schema public rename to ${aside}; create schema public;
    drop table if exists ${aside}.kysely_migration, ${aside}.kysely_migration_lock;
    do $aside$ declare item record; begin
      for item in select extname from pg_extension where extnamespace = '${aside}'::regnamespace
      loop execute format('alter extension %I set schema public', item.extname); end loop;
      for item in select t.tgname, c.relname from pg_trigger t join pg_class c on c.oid = t.tgrelid
        where c.relnamespace = '${aside}'::regnamespace and not t.tgisinternal
      loop execute format('drop trigger %I on %I.%I', item.tgname, '${aside}', item.relname); end loop;
    end $aside$`;
}

/**
 * Makes the database at `url` a released Home: main's schema and migration ledger at its last
 * migration (0046), as main's own code made them (`fixtures/released-home-0046.sql`, which says
 * how). Not this branch's copy of main's migrations, so a released body the branch changed shows.
 */
export async function loadReleasedHome(url: string): Promise<void> {
  const schema = await readFile(new URL("./fixtures/released-home-0046.sql", import.meta.url), {
    encoding: "utf8",
  });
  // Its own connection: the dump empties this session's search_path. One object at a time, as
  // pg_dump heads each, so no one transaction holds a lock on every table of the schema.
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(emptyPublicSchema());
    for (const part of schema.split(/\n(?=--\n-- (?:Name|Data for Name): )/u))
      await client.query(part);
  } finally {
    await client.end();
  }
}

const model = '{"providerId":"openai","modelId":"fixture","options":{}}';

/** One person's Home with a task, as rows main wrote them. */
export async function seedReleasedHomeTask(
  database: Kysely<DatabaseSchema>,
  title: string,
  path = "/tmp/released-home-fixture",
) {
  const owner = await seedPersonalFixture(database, path);
  const thread = createId("thread");
  const harness = createId("harnessInstance");
  const {
    rows: [principal],
  } = await sql<{ id: string }>`
    select id from principals where user_id = ${owner.userId}
  `.execute(database);
  await sql`insert into harness_instances
    (id, environment_id, driver_kind, name, config, runtime_revision, state_kind, enabled, is_default, source_id)
    values (${harness}, ${owner.environmentId}, 'codex', 'Codex', '{}', 1, 'ready', true, true, 'native')
  `.execute(database);
  await sql`insert into threads
    (id, lineage_root_thread_id, purpose, listed, title, icon_source, color, environment_id,
     harness_instance_id, model_selection, created_by, created_by_principal_id)
    values (${thread}, ${thread}, 'task', true, ${title}, 'default', 'blue', ${owner.environmentId},
            ${harness}, ${model}::jsonb, ${owner.userId}, ${principal!.id})
  `.execute(database);
  return { ...owner, thread, harness, principal: principal!.id };
}
