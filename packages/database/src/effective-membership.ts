import { sql } from "kysely";

export function effectiveMembershipPredicate(table = "workspaceMemberships") {
  return sql<boolean>`opensteer_membership_is_effective(${sql.ref(`${table}.state`)}, ${sql.ref(`${table}.effectiveUntil`)}, ${sql.ref(`${table}.userId`)})`;
}

export function effectiveMembershipState(table = "workspaceMemberships") {
  return sql<
    "active" | "revoked"
  >`case when ${effectiveMembershipPredicate(table)} then 'active' else 'revoked' end`.as("state");
}
