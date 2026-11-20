import type { ControlPlaneAccountId, OrganizationId } from "@opensteer/control-plane-protocol";
import type { Kysely, Transaction } from "kysely";
import type { ControlPlaneDatabaseSchema } from "../database/schema.js";
import { ControlPlaneError } from "../server/errors.js";

type DB = Kysely<ControlPlaneDatabaseSchema>;

export function workSignInAuthority(db: DB, clientId: string) {
  return db
    .selectFrom("cloudComputers")
    .innerJoin("workAssignments", "workAssignments.id", "cloudComputers.workAssignmentId")
    .select(["workAssignments.assigneeAccountId", "workAssignments.state"])
    .where("cloudComputers.oidcClientId", "=", clientId)
    .executeTakeFirst();
}

export function otherAdmin(db: DB, org: OrganizationId, account: ControlPlaneAccountId, now: Date) {
  return db
    .selectFrom("organizationMembers")
    .innerJoin("users", "users.id", "organizationMembers.accountId")
    .select("organizationMembers.accountId")
    .where("organizationMembers.organizationId", "=", org)
    .where("organizationMembers.role", "=", "admin")
    .where("organizationMembers.accountId", "!=", account)
    .where((eb) =>
      eb.or([
        eb("users.deletionFencedUntil", "is", null),
        eb("users.deletionFencedUntil", "<=", now),
      ]),
    )
    .executeTakeFirst();
}

/** Locks organizations in a stable order so concurrent departures cannot leave one adminless. */
export async function requireOrganizationAccountDeletionAllowed(
  tx: Transaction<ControlPlaneDatabaseSchema>,
  account: ControlPlaneAccountId,
) {
  const assignment = await tx
    .selectFrom("workAssignments")
    .select("id")
    .where("assigneeAccountId", "=", account)
    .where("state", "!=", "ended")
    .executeTakeFirst();
  if (assignment) {
    throw new ControlPlaneError(
      "conflict",
      "Ask your organization admin to offboard your work Cloud Computer before deleting your Account",
    );
  }
  const memberships = tx
    .selectFrom("organizationMembers")
    .select("organizationId")
    .where("accountId", "=", account)
    .where("role", "=", "admin");
  const orgs = await tx
    .selectFrom("organizations")
    .select("id")
    .where("id", "in", memberships)
    .orderBy("id")
    .forNoKeyUpdate()
    .execute();
  for (const { id } of orgs) {
    if (!(await otherAdmin(tx, id, account, new Date()))) {
      throw new ControlPlaneError(
        "conflict",
        "Appoint another organization admin before deleting your Account",
      );
    }
  }
}
