import { sql } from "kysely";

export function effectiveMembershipPredicate(table = "workspaceMemberships") {
  return sql<boolean>`(${sql.ref(`${table}.state`)} = 'active' and (
    (${sql.ref(`${table}.effectiveUntil`)} is null and not (select exists (
      select 1 from public.deployments where authority_model_version = 2 and deployment_shape->>'kind' = 'server'
    ))) or opensteer_membership_is_effective(${sql.ref(`${table}.state`)}, ${sql.ref(`${table}.effectiveUntil`)}, ${sql.ref(`${table}.userId`)})
  ))`;
}

export function effectiveMembershipState(table = "workspaceMemberships") {
  return sql<
    "active" | "revoked"
  >`case when ${effectiveMembershipPredicate(table)} then 'active' else 'revoked' end`.as("state");
}
