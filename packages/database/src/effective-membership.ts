import {
  sql,
  type Kysely,
  type RawBuilder,
  type AliasedRawBuilder,
  type SelectQueryBuilder,
} from "kysely";
import type { DatabaseSchema } from "./schema.js";

type MembershipState = "active" | "revoked";
export interface MembershipAuthority {
  readonly version: 1 | 2;
  readonly lockedSelection: readonly ("role" | "state" | "generation" | "effectiveUntil")[];
  filterLocked<Output>(
    query: SelectQueryBuilder<DatabaseSchema, "workspaceMemberships", Output>,
  ): SelectQueryBuilder<DatabaseSchema, "workspaceMemberships", Output>;
  predicate(column: string, raw: boolean): RawBuilder<boolean>;
  state(column: string): "state" | AliasedRawBuilder<MembershipState, "state">;
}

const legacyAuthority: MembershipAuthority = {
  version: 1,
  lockedSelection: ["role", "state", "generation"],
  filterLocked: (query) => query,
  predicate: (column, raw) =>
    raw
      ? sql<boolean>`${sql.raw(column)} = 'active'`
      : sql<boolean>`${sql.ref(column)} = ${"active"}`,
  state: () => "state",
};

export const projectMembershipAuthority: MembershipAuthority = {
  version: 2,
  lockedSelection: ["role", "state", "generation", "effectiveUntil"],
  filterLocked(query) {
    return query.where(this.predicate("workspaceMemberships.state", false));
  },
  predicate(column) {
    const prefix = column.includes(".") ? column.slice(0, column.lastIndexOf(".") + 1) : "";
    return sql<boolean>`(${sql.ref(column)} = 'active'
      and (${sql.ref(`${prefix}effectiveUntil`)} is null or ${sql.ref(`${prefix}effectiveUntil`)} > clock_timestamp())
      and exists (select 1 from public.users access_person where access_person.id = ${sql.ref(`${prefix}userId`)}
        and access_person.member_state = 'active' and access_person.admitted_at is not null))`;
  },
  state(column) {
    return sql<MembershipState>`case when ${this.predicate(column, false)} then 'active' else 'revoked' end`.as(
      "state",
    );
  },
};

const authorities = new WeakMap<object, MembershipAuthority>();

export function membershipAuthority(database: Kysely<DatabaseSchema>): MembershipAuthority {
  return authorities.get(database.getExecutor().adapter) ?? legacyAuthority;
}

export async function loadMembershipAuthority(
  database: Kysely<DatabaseSchema>,
): Promise<MembershipAuthority> {
  const deployment = await database
    .selectFrom("deployments")
    .select(["authorityModelVersion", "deploymentShape"])
    .executeTakeFirst();
  const authority =
    deployment?.authorityModelVersion === 2 && deployment.deploymentShape.kind === "server"
      ? projectMembershipAuthority
      : legacyAuthority;
  authorities.set(database.getExecutor().adapter, authority);
  return authority;
}

export function effectiveMembershipPredicate(
  database: Kysely<DatabaseSchema>,
  column = "workspaceMemberships.state",
  raw = false,
) {
  return membershipAuthority(database).predicate(column, raw);
}

export function effectiveMembershipState(database: Kysely<DatabaseSchema>, column = "state") {
  return membershipAuthority(database).state(column);
}
