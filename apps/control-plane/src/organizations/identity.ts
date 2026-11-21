import type { ControlPlaneAccountId, OrganizationId } from "@opensteer/control-plane-protocol";
import type { Kysely, Transaction } from "kysely";
import type { ControlPlaneDatabaseSchema } from "../database/schema.js";
import { ControlPlaneError } from "../server/errors.js";

type DB = Kysely<ControlPlaneDatabaseSchema>;

export function workSignInAuthority(db: DB, clientId: string, lock = false) {
  const authority = db
    .selectFrom("cloudComputers")
    .innerJoin("workAssignments", "workAssignments.id", "cloudComputers.workAssignmentId")
    .select(["workAssignments.assigneeAccountId", "workAssignments.state"])
    .where("cloudComputers.oidcClientId", "=", clientId);
  return (lock ? authority.forShare("workAssignments") : authority).executeTakeFirst();
}

export function otherAdmin(db: DB, org: OrganizationId, account: ControlPlaneAccountId, now: Date) {
  return (
    db
      .selectFrom("organizationMembers")
      .innerJoin("users", "users.id", "organizationMembers.accountId")
      .select("organizationMembers.accountId")
      .where("organizationMembers.organizationId", "=", org)
      .where("organizationMembers.role", "=", "admin")
      .where("organizationMembers.accountId", "!=", account)
      // An admin whose Account is closing is no other admin.
      .where("users.deletionRequestedAt", "is", null)
      .where((eb) =>
        eb.or([
          eb("users.deletionFencedUntil", "is", null),
          eb("users.deletionFencedUntil", "<=", now),
        ]),
      )
      .executeTakeFirst()
  );
}

/** Locks organizations in a stable order so concurrent departures cannot leave one adminless. */
export async function requireOrganizationAccountDeletionAllowed(
  tx: Transaction<ControlPlaneDatabaseSchema>,
  account: ControlPlaneAccountId,
) {
  const memberships = tx
    .selectFrom("organizationMembers")
    .select("organizationId")
    .where("accountId", "=", account);
  const orgs = await tx
    .selectFrom("organizations")
    .select(["id", "closedAt"])
    .where("id", "in", memberships)
    .orderBy("id")
    .forNoKeyUpdate()
    .execute();
  const rows = await tx
    .selectFrom("organizationMembers")
    .select(["organizationId", "role"])
    .where("accountId", "=", account)
    .orderBy("organizationId")
    .forNoKeyUpdate()
    .execute();
  await tx
    .selectFrom("organizationCheckouts")
    .select("organizationId")
    .where("founderAccountId", "=", account)
    .orderBy("organizationId")
    .orderBy("requestId")
    .forNoKeyUpdate()
    .execute();
  const assignments = await tx
    .selectFrom("workAssignments")
    .select(["id", "state"])
    .where("assigneeAccountId", "=", account)
    .orderBy("id")
    .forNoKeyUpdate()
    .execute();
  if (assignments.some(({ state }) => state !== "ended"))
    throw new ControlPlaneError(
      "conflict",
      "Ask your organization admin to offboard your work Cloud Computer before deleting your Account",
    );
  const adminIds = new Set(
    rows.filter(({ role }) => role === "admin").map(({ organizationId }) => organizationId),
  );
  for (const { id, closedAt } of orgs) {
    if (!closedAt && adminIds.has(id) && !(await otherAdmin(tx, id, account, new Date()))) {
      throw new ControlPlaneError(
        "conflict",
        "Appoint another organization admin before deleting your Account",
      );
    }
  }
}
