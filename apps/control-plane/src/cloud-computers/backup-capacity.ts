import type { OrganizationId } from "@opensteer/control-plane-protocol";
import type { ExpressionBuilder, Kysely, Transaction } from "kysely";
import type { ControlPlaneDatabaseSchema } from "../database/schema.js";
import { ControlPlaneError } from "../server/errors.js";

type DB = Kysely<ControlPlaneDatabaseSchema>;
type Tx = Transaction<ControlPlaneDatabaseSchema>;

function isFreeTarget(
  eb: ExpressionBuilder<ControlPlaneDatabaseSchema, "cloudComputerBackupTargets">,
) {
  return eb.and([
    eb("computerId", "is", null),
    eb("checkoutKey", "is", null),
    eb("purgeComputerId", "is", null),
    eb("needsRotation", "=", false),
  ]);
}

export function freeBackupTargets(db: DB) {
  return db.selectFrom("cloudComputerBackupTargets").where(isFreeTarget);
}

export async function reserveSeatBackups(
  tx: Transaction<ControlPlaneDatabaseSchema>,
  organizationId: OrganizationId,
  requestId: string,
  count: number,
) {
  if (count <= 0) return;
  const available = await freeBackupTargets(tx)
    .where("reservedOrganizationId", "is", null)
    .select("id")
    .orderBy("id")
    .limit(count)
    .forNoKeyUpdate()
    .skipLocked()
    .execute();
  if (available.length !== count)
    throw new ControlPlaneError("unavailable", "Organization seats are not available right now");
  await tx
    .updateTable("cloudComputerBackupTargets")
    .where(
      "id",
      "in",
      available.map(({ id }) => id),
    )
    .set({ reservedOrganizationId: organizationId, organizationReservationRequestId: requestId })
    .executeTakeFirstOrThrow();
}

export async function settleSeatBackups(
  tx: Transaction<ControlPlaneDatabaseSchema>,
  organizationId: OrganizationId,
  requestId: string,
  keep: boolean,
) {
  const rows = await tx
    .selectFrom("cloudComputerBackupTargets")
    .select("id")
    .where("reservedOrganizationId", "=", organizationId)
    .where("organizationReservationRequestId", "=", requestId)
    .orderBy("id")
    .forNoKeyUpdate()
    .execute();
  if (!rows.length) return;
  await tx
    .updateTable("cloudComputerBackupTargets")
    .where(
      "id",
      "in",
      rows.map(({ id }) => id),
    )
    .set({
      organizationReservationRequestId: null,
      ...(keep ? {} : { reservedOrganizationId: null }),
    })
    .executeTakeFirstOrThrow();
}

function unusedOrgBackups(tx: Tx, organizationId: OrganizationId) {
  return freeBackupTargets(tx)
    .where("reservedOrganizationId", "=", organizationId)
    .where("organizationReservationRequestId", "is", null);
}

async function missingSeatBackups(tx: Tx, organizationId: OrganizationId, unused: number) {
  const owned = await unusedOrgBackups(tx, organizationId)
    .select((eb) => eb.fn.countAll<string>().as("count"))
    .executeTakeFirstOrThrow();
  return Math.max(0, unused - Number(owned.count));
}

function sharedPool(tx: Tx) {
  return freeBackupTargets(tx).where("reservedOrganizationId", "is", null);
}

export async function replenishSeatBackups(
  tx: Tx,
  organizationId: OrganizationId,
  unused: number,
  locked?: readonly string[],
) {
  const needed = await missingSeatBackups(tx, organizationId, unused);
  if (needed === 0 || locked?.length === 0) return;
  let pool = sharedPool(tx);
  if (locked) pool = pool.where("id", "in", locked);
  const free = await pool
    .select("id")
    .orderBy("id")
    .limit(needed)
    .forNoKeyUpdate()
    .skipLocked()
    .execute();
  if (!free.length) return;
  await tx
    .updateTable("cloudComputerBackupTargets")
    .where(
      "id",
      "in",
      free.map(({ id }) => id),
    )
    .set({ reservedOrganizationId: organizationId })
    .executeTakeFirstOrThrow();
}

async function trimSeatBackups(
  tx: Tx,
  organizationId: OrganizationId,
  unused: number,
  locked?: readonly string[],
) {
  if (locked?.length === 0) return;
  let owned = unusedOrgBackups(tx, organizationId);
  if (locked) owned = owned.where("id", "in", locked);
  const reserved = await owned
    .select("id")
    .orderBy("id")
    .offset(Math.max(unused, 0))
    .forNoKeyUpdate()
    .execute();
  if (reserved.length) {
    await tx
      .updateTable("cloudComputerBackupTargets")
      .where(
        "id",
        "in",
        reserved.map(({ id }) => id),
      )
      .set({ reservedOrganizationId: null })
      .executeTakeFirstOrThrow();
  }
}

type SeatBackupSettlement = { readonly requestId: string; readonly keep: boolean };
type SeatBackupAdjustment = { readonly kind: "trim" | "replenish"; readonly unused: number };

export async function reconcileSeatBackups(
  tx: Tx,
  organizationId: OrganizationId,
  settlement: SeatBackupSettlement | undefined,
  adjustment: SeatBackupAdjustment | undefined,
) {
  let locked: string[] | undefined;
  if (settlement && adjustment) {
    const needed =
      adjustment.kind === "replenish"
        ? await missingSeatBackups(tx, organizationId, adjustment.unused)
        : 0;
    const candidates = sharedPool(tx).select("id").orderBy("id").limit(needed);
    // Settlement and the capacity adjustment can touch interleaved target IDs.
    const targets = await tx
      .selectFrom("cloudComputerBackupTargets")
      .select("id")
      .where((eb) =>
        eb.or([
          eb.and([
            eb("reservedOrganizationId", "=", organizationId),
            eb("organizationReservationRequestId", "=", settlement.requestId),
          ]),
          ...(adjustment.kind === "trim"
            ? [eb("id", "in", unusedOrgBackups(tx, organizationId).select("id"))]
            : []),
          ...(needed
            ? [
                eb.and([
                  isFreeTarget(eb),
                  eb("reservedOrganizationId", "is", null),
                  eb("id", "in", candidates),
                ]),
              ]
            : []),
        ]),
      )
      .orderBy("id")
      .forNoKeyUpdate()
      .execute();
    locked = targets.map(({ id }) => id);
  }
  if (settlement)
    await settleSeatBackups(tx, organizationId, settlement.requestId, settlement.keep);
  if (adjustment?.kind === "trim")
    await trimSeatBackups(tx, organizationId, adjustment.unused, locked);
  if (adjustment?.kind === "replenish")
    await replenishSeatBackups(tx, organizationId, adjustment.unused, locked);
}
