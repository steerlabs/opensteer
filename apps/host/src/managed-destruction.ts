import { migrateToLatest,type DatabaseSchema } from "@opensteer/database";
import { sql,type Kysely } from "kysely";

/** Teardown uses the current Host image even when the stopped Host never upgraded. */
export async function prepareManagedDestructionDatabase(
  database: Kysely<DatabaseSchema>,
): Promise<"pristine" | "ready"> {
  if (await isPristineUnmigratedDatabase(database)) return "pristine";
  await migrateToLatest(database);
  return "ready";
}

export async function isPristineUnmigratedDatabase(
  database: Kysely<DatabaseSchema>,
): Promise<boolean> {
  const schemas = await sql<{ readonly schemaName: string }>`
    select nspname as "schemaName"
    from pg_catalog.pg_namespace
    where nspname <> 'information_schema'
      and nspname !~ '^pg_'
    order by nspname
  `.execute(database);
  if (schemas.rows.some(({ schemaName }) => schemaName !== "public")) return false;
  const tables = await sql<{ readonly schemaName: string; readonly tableName: string }>`
    select n.nspname as "schemaName", c.relname as "tableName"
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p')
      and n.nspname <> 'information_schema'
      and n.nspname !~ '^pg_'
    order by n.nspname, c.relname
  `.execute(database);
  const bookkeeping = tables.rows.filter(
    ({ schemaName, tableName }) =>
      schemaName === "public" &&
      (tableName === "kysely_migration" || tableName === "kysely_migration_lock"),
  );
  if (tables.rows.length !== bookkeeping.length) return false;
  const migrationTable = bookkeeping.find(({ tableName }) => tableName === "kysely_migration");
  if (!migrationTable) return true;
  const recorded = await sql<{ readonly count: string }>`
    select count(*)::text as count from public.kysely_migration
  `.execute(database);
  return recorded.rows.length === 1 && recorded.rows[0]?.count === "0";
}

