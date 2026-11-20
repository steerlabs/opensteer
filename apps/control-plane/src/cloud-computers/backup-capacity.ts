import type { OrganizationId } from "@opensteer/control-plane-protocol";
import type { Kysely, Transaction } from "kysely";
import type { ControlPlaneDatabaseSchema } from "../database/schema.js";
import { ControlPlaneError } from "../server/errors.js";

type DB = Kysely<ControlPlaneDatabaseSchema>;

export function freeBackupTargets(db: DB) {
  return db
    .selectFrom("cloudComputerBackupTargets")
    .where("computerId", "is", null)
    .where("checkoutKey", "is", null)
    .where("purgeComputerId", "is", null)
    .where("needsRotation", "=", false);
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
    .forUpdate()
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

export async function replenishSeatBackups(
  tx: Transaction<ControlPlaneDatabaseSchema>,
  organizationId: OrganizationId,
  unused: number,
) {
  const owned = await freeBackupTargets(tx)
    .where("reservedOrganizationId", "=", organizationId)
    .where("organizationReservationRequestId", "is", null)
    .select((eb) => eb.fn.countAll<string>().as("count"))
    .executeTakeFirstOrThrow();
  const needed = unused - Number(owned.count);
  if (needed <= 0) return;
  const free = await freeBackupTargets(tx)
    .where("reservedOrganizationId", "is", null)
    .select("id")
    .orderBy("id")
    .limit(needed)
    .forUpdate()
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

export async function trimSeatBackups(
  tx: Transaction<ControlPlaneDatabaseSchema>,
  organizationId: OrganizationId,
  unused: number,
) {
  const reserved = await freeBackupTargets(tx)
    .where("reservedOrganizationId", "=", organizationId)
    .where("organizationReservationRequestId", "is", null)
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
