import { OpensteerError, type EnvironmentId, type HarnessInstanceId } from "@opensteer/core";
import type { HarnessInstanceCatalog } from "@opensteer/protocol";
import { personalInventoryBound } from "@opensteer/protocol/resources";
import { sql, type Kysely, type Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";

/**
 * What one Personal Deployment holds of each inventory a client reads whole. Each is set so the
 * complete inventory fits the client's bound for its kind (machines 4 MiB; environments and
 * harnesses 2 MiB; model catalogs 8 MiB) with room to spare, and each is enforced where the rows
 * are written, so an install can never produce an inventory a client refuses.
 */
export const personalInventoryLimits = {
  /**
   * Computers and devices, enrolled or waiting to enroll. Every Runner, and so every environment,
   * comes from one of these, so this also bounds environments.
   */
  machines: 64,
  /** Harness accounts across every environment (each environment also allows at most 100). */
  harnessInstances: 256,
  /**
   * Serialized account configuration, model settings included. The `harness` resource carries an
   * account's configuration twice (as `config` and as `modelSettings`), so one account stays well
   * inside a 64 KiB page, and every account together (twice, plus names and ids) well inside the
   * client's 2 MiB bound.
   */
  harnessConfigBytesPerAccount: 24 * 1024,
  harnessConfigBytes: 512 * 1024,
  /**
   * Model catalogs as the client receives them, every page added up: half the client's 8 MiB
   * bound, so over-budget errors (a few hundred bytes per account) still fit beside them.
   */
  catalogBytes: personalInventoryBound("harness-catalog") / 2,
} as const;

type Tx = Transaction<DatabaseSchema> | Kysely<DatabaseSchema>;

/** Serializes inventory checks with the writes they guard. */
async function lockInventory(tx: Tx, name: string) {
  await sql`select pg_advisory_xact_lock(hashtext(${`personal-inventory:${name}`}))`.execute(tx);
}

/** One more computer or device would fit: enrolled devices plus enrollments still open. */
export async function requireMachineRoom(tx: Tx, now: Date) {
  await lockInventory(tx, "machines");
  const result = await sql<{ count: string }>`
    select (select count(*) from devices where removed_at is null)
      + (select count(*) from runner_enrollments where consumed_at is null and expires_at > ${now})
      as count
  `.execute(tx);
  if (Number(result.rows[0]?.count ?? 0) >= personalInventoryLimits.machines)
    throw new OpensteerError({
      code: "conflict",
      message: `This Opensteer already has the maximum of ${personalInventoryLimits.machines} computers and devices; remove one before adding another`,
    });
}

/**
 * One harness account with this configuration would fit. `replacing` names an account whose
 * configuration this write replaces, so an edit is measured without its old value.
 */
export async function requireHarnessRoom(tx: Tx, config: unknown, replacing?: HarnessInstanceId) {
  await lockInventory(tx, "harness");
  // Measured as PostgreSQL stores it, the same way for the new value and the kept ones.
  const others = await sql<{ count: string; bytes: string | null }>`
    select count(*) as count,
      coalesce(sum(octet_length(config::text)), 0)
        + octet_length(${JSON.stringify(config)}::jsonb::text) as bytes
    from harness_instances
    where removed_at is null ${replacing ? sql`and id <> ${replacing}` : sql``}
  `.execute(tx);
  const count = Number(others.rows[0]?.count ?? 0);
  const bytes = Number(others.rows[0]?.bytes ?? 0);
  if (Buffer.byteLength(JSON.stringify(config)) > personalInventoryLimits.harnessConfigBytesPerAccount)
    throw new OpensteerError({
      code: "conflict",
      message:
        "This AI account's settings are larger than Opensteer can keep for one account; remove some saved model settings",
    });
  if (!replacing && count >= personalInventoryLimits.harnessInstances)
    throw new OpensteerError({
      code: "conflict",
      message: `This Opensteer already has the maximum of ${personalInventoryLimits.harnessInstances} AI accounts; remove one before adding another`,
    });
  if (bytes > personalInventoryLimits.harnessConfigBytes)
    throw new OpensteerError({
      code: "conflict",
      message:
        "These AI account settings are larger than this Opensteer can keep; remove saved model settings or an account first",
    });
}

/**
 * What a resource page of catalogs costs beyond the catalog itself: the page's `data` envelope,
 * the environment it names and the catalog's `capturedAt`, with room to spare.
 */
const catalogPageOverhead = 512;
/** The `data` one catalog page may carry: a 64 KiB response less its envelope and cursor. */
const catalogPageData = 60 * 1024;

/**
 * The bytes a catalog adds to the `harness-catalog` inventory as `resources.detail.get` serves
 * it: its models once, and its header (everything but the models) again on every page they span.
 * `null` when no page could hold the header and one model.
 */
export function projectedCatalogBytes(headerBytes: number, modelsBytes: number, largestModel = 0) {
  const room = catalogPageData - headerBytes - catalogPageOverhead;
  if (room < largestModel || room <= 0) return null;
  const pages = Math.max(1, Math.ceil(modelsBytes / room));
  return modelsBytes + pages * (headerBytes + catalogPageOverhead);
}

/** Just enough for the account to say why it has no models; always admitted. */
function overBudgetCatalog(catalog: HarnessInstanceCatalog): HarnessInstanceCatalog {
  return {
    connections: [],
    setupMethods: [],
    driverKind: catalog.driverKind,
    harnessInstanceId: catalog.harnessInstanceId,
    models: [],
    status: "error",
    detail:
      "This account offers more models than this Opensteer can keep alongside its other accounts. Remove an AI account you do not use, then refresh this one.",
  };
}

/**
 * The catalog this write may store. A catalog, of any status, that would take the Deployment's
 * catalogs past `catalogBytes` as the client receives them is kept as a short error that names
 * the remedy instead. Every catalog already stored is priced the same way, from PostgreSQL's
 * text of it, which is never shorter than the JSON a page carries.
 */
export async function catalogWithinBudget(
  tx: Tx,
  environmentId: EnvironmentId,
  catalog: HarnessInstanceCatalog,
): Promise<HarnessInstanceCatalog> {
  await lockInventory(tx, "catalogs");
  const { models, ...header } = catalog;
  const own = projectedCatalogBytes(
    Buffer.byteLength(JSON.stringify(header)),
    Buffer.byteLength(JSON.stringify(models)),
    Math.max(0, ...models.map((model) => Buffer.byteLength(JSON.stringify(model)))),
  );
  if (own === null) return overBudgetCatalog(catalog);
  const rows = await sql<{ header: number; models: number }>`
    select octet_length((catalog - 'models')::text) as header,
      octet_length(coalesce(catalog->'models', '[]'::jsonb)::text) as models
    from harness_catalogs
    where (environment_id, harness_instance_id) <> (${environmentId}, ${catalog.harnessInstanceId})
  `.execute(tx);
  let total = own;
  for (const row of rows.rows)
    total += projectedCatalogBytes(Number(row.header), Number(row.models)) ?? catalogPageData;
  return total <= personalInventoryLimits.catalogBytes ? catalog : overBudgetCatalog(catalog);
}
