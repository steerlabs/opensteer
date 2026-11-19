import { OpensteerError, type EnvironmentId, type HarnessInstanceId } from "@opensteer/core";
import type { HarnessInstanceCatalog } from "@opensteer/protocol";
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
  /** Serialized account configuration across every harness account, model settings included. */
  harnessConfigBytes: 1024 * 1024,
  /** Serialized model catalogs across every account. */
  catalogBytes: 6 * 1024 * 1024,
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
 * The catalog this write may store. A ready catalog that would take the Deployment's catalogs
 * past their budget is kept as an error the account shows, with its sign-in methods, instead.
 */
export async function catalogWithinBudget(
  tx: Tx,
  environmentId: EnvironmentId,
  catalog: HarnessInstanceCatalog,
): Promise<HarnessInstanceCatalog> {
  if (catalog.status !== "ready") return catalog;
  await lockInventory(tx, "catalogs");
  const others = await sql<{ bytes: string | null }>`
    select coalesce(sum(octet_length(catalog::text)), 0)
      + octet_length(${JSON.stringify(catalog)}::jsonb::text) as bytes
    from harness_catalogs
    where (environment_id, harness_instance_id) <> (${environmentId}, ${catalog.harnessInstanceId})
  `.execute(tx);
  const bytes = Number(others.rows[0]?.bytes ?? 0);
  if (bytes <= personalInventoryLimits.catalogBytes) return catalog;
  return {
    connections: catalog.connections,
    setupMethods: catalog.setupMethods,
    driverKind: catalog.driverKind,
    harnessInstanceId: catalog.harnessInstanceId,
    models: [],
    status: "error",
    detail:
      "This account offers more models than this Opensteer can keep alongside its other accounts. Remove an account to read its models.",
  };
}
