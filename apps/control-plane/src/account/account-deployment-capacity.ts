import {
  maximumAccountDeployments,
  type ControlPlaneAccountId,
  type PersonalHostAccountLinkChallengeId,
} from "@opensteer/control-plane-protocol";
import { sql, type Transaction } from "kysely";
import { ControlPlaneError } from "../server/errors.js";
import type { ControlPlaneDatabaseSchema } from "../database/schema.js";

/**
 * The single Deployment-slot authority. Every path that can grow an Account's
 * Deployment catalog — Personal link reservation, self-hosted adoption, and
 * shared directory membership — takes {@link lockAccountDeploymentCapacity}
 * and then {@link requireAccountDeploymentCapacity}.
 *
 * Advisory and row fences follow the single declared order in
 * ../../../../packages/database/src/lock-order.ts.
 */
export async function lockAccountDeploymentCapacity(
  transaction: Transaction<ControlPlaneDatabaseSchema>,
  accountId: ControlPlaneAccountId,
): Promise<void> {
  await sql`
    select pg_advisory_xact_lock(
      hashtextextended('opensteer:account-deployment-quota:' || ${accountId}, 0)
    )
  `.execute(transaction);
}

export async function requireAccountDeploymentCapacity(
  transaction: Transaction<ControlPlaneDatabaseSchema>,
  accountId: ControlPlaneAccountId,
  options: {
    readonly excludingPersonalChallengeId?: string;
    readonly now?: Date;
  } = {},
): Promise<void> {
  const now = options.now ?? new Date();
  const owned = await transaction
    .selectFrom("deployments")
    .select((expression) => expression.fn.countAll().as("count"))
    .where("ownerAccountId", "=", accountId)
    .executeTakeFirstOrThrow();
  const member = await transaction
    .selectFrom("deploymentDirectoryEntries")
    .innerJoin("deployments", "deployments.id", "deploymentDirectoryEntries.deploymentId")
    .select((expression) => expression.fn.countAll().as("count"))
    .where("deploymentDirectoryEntries.accountId", "=", accountId)
    .where("deploymentDirectoryEntries.present", "=", true)
    .where("deployments.ownerAccountId", "!=", accountId)
    .executeTakeFirstOrThrow();
  let reservations = transaction
    .selectFrom("personalHostAccountLinkChallenges")
    .select((expression) => expression.fn.countAll().as("count"))
    .where("ownerAccountId", "=", accountId)
    .where((expression) =>
      expression.or([
        expression.and([
          expression("state", "=", "pending"),
          expression("challengeExpiresAt", ">", now),
        ]),
        expression.and([
          expression("state", "=", "reserved"),
          expression("resultExpiresAt", ">", now),
        ]),
      ]),
    );
  if (options.excludingPersonalChallengeId) {
    reservations = reservations.where(
      "challengeId",
      "!=",
      options.excludingPersonalChallengeId as PersonalHostAccountLinkChallengeId,
    );
  }
  const reserved = await reservations.executeTakeFirstOrThrow();
  if (
    Number(owned.count) + Number(member.count) + Number(reserved.count) >=
    maximumAccountDeployments
  ) {
    throw new ControlPlaneError(
      "conflict",
      `An Account can have at most ${maximumAccountDeployments} Deployments`,
      { reason: "account-deployment-quota-exceeded" },
    );
  }
}
