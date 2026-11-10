import { createHash } from "node:crypto";
import {
  createId,
  OpensteerError,
  MarkColorSchema,
  WorkspaceBackingSchema,
  type AccessDecision,
  type AccessMutation,
  type AccessMutationInput,
  type AccessPrincipal,
  type AccessTarget,
  type AccessAction,
  type CommandId,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import { z } from "zod";
import type { AccessEntryTable, DatabaseSchema, WorkspaceMembershipTable } from "./schema.js";
import { effectiveMembershipPredicate } from "./effective-membership.js";
import { discoverRequestWorkspaces, withRequestWorkspaceLocks } from "./request-workspace-locks.js";
import { jsonValue, safeGeneration } from "./store-primitives.js";

export const accessCapacity = {
  projects: 128,
  groups: 512,
  depth: 8,
  edges: 8192,
  matchingEntries: 256,
  effectivePairs: 1024,
  affectedPairs: 2048,
  requestWorkspaces: 256,
} as const;

type Database = Kysely<DatabaseSchema>;
type AccessTransaction = Transaction<DatabaseSchema>;
type Pair = { readonly userId: UserId; readonly workspaceId: WorkspaceId };
type Entry = Selectable<AccessEntryTable>;
type Membership = Omit<Selectable<WorkspaceMembershipTable>, "generation"> & {
  readonly generation: number | string;
};
type Graph = Awaited<ReturnType<typeof readGraph>>;
type Level = "use" | "manage" | null;
type Effective = { readonly level: Level; readonly until: Date | null };

export interface MembershipTransition extends Pair {
  readonly generation: number;
  readonly previousGeneration: number | null;
  readonly state: "active" | "revoked";
  readonly role: "owner" | "collaborator";
  readonly effectiveUntil: Date | null;
}

export interface AccessMutationResult {
  readonly revision: number;
  readonly transitions: readonly MembershipTransition[];
}

const writerTransactions = new WeakSet<AccessTransaction>();
const heldMemberships = new WeakMap<AccessTransaction, ReadonlySet<string>>();
const resultSchema = z.object({
  revision: z.number().int().positive().safe(),
  transitions: z.array(
    z.object({
      userId: z.custom<UserId>((value) => typeof value === "string" && value.startsWith("usr_")),
      workspaceId: z.custom<WorkspaceId>(
        (value) => typeof value === "string" && value.startsWith("wsp_"),
      ),
      generation: z.number().int().positive().safe(),
      previousGeneration: z.number().int().positive().safe().nullable(),
      state: z.enum(["active", "revoked"]),
      role: z.enum(["owner", "collaborator"]),
      effectiveUntil: z.coerce.date().nullable(),
    }),
  ),
});
const pairKey = (pair: Pair) => `${pair.workspaceId}/${pair.userId}`;

function refuse(message: string): never {
  throw new OpensteerError({ code: "bad_request", message });
}

function conflict(message: string): never {
  throw new OpensteerError({ code: "conflict", message, retryable: true });
}

async function databaseTime(database: Database): Promise<Date> {
  const result = await sql<{ time: Date }>`select clock_timestamp() as time`.execute(database);
  return result.rows[0]!.time;
}

async function takeWriterLock(transaction: AccessTransaction): Promise<void> {
  await sql`set local lock_timeout = '1500ms'`.execute(transaction);
  await sql`select pg_advisory_xact_lock(hashtextextended('opensteer:access-writer', 0))`.execute(
    transaction,
  );
  writerTransactions.add(transaction);
}

async function requireNewAuthority(database: Database): Promise<void> {
  const deployment = await database
    .selectFrom("deployments")
    .select(["authorityModelVersion", "deploymentShape"])
    .where("singletonKey", "=", "primary")
    .executeTakeFirst();
  if (deployment?.authorityModelVersion !== 2 || deployment.deploymentShape.kind !== "server")
    throw new OpensteerError({
      code: "forbidden",
      message: "Project grant authority is not activated",
    });
}

async function readGraph(
  database: Database,
  memberIds?: readonly UserId[],
  retainedEntryIds: readonly string[] = [],
) {
  let userQuery = database
    .selectFrom("users")
    .select(["id", "memberKind", "memberState", "admittedAt"]);
  if (memberIds) userQuery = userQuery.where("id", "in", memberIds);
  const users = await userQuery.execute();
  const projects = await database
    .selectFrom("workspaces")
    .select(["id", "createdBy"])
    .where("kind", "=", "project")
    .where("deletedAt", "is", null)
    .where("status", "not in", ["deleting", "deleted"])
    .execute();
  const ancestors = memberIds
    ? (
        await sql<{ id: string }>`with recursive ancestors(id) as (
    select id from access_groups where builtin = 'everyone' and deleted_at is null
    union select group_id from access_group_members where member_kind = 'user' and member_id in (${sql.join(memberIds)})
    union select edge.group_id from access_group_members edge join ancestors on edge.member_kind = 'group' and edge.member_id = ancestors.id::text
  ) select id from ancestors`.execute(database)
      ).rows.map((row) => row.id)
    : undefined;
  let groupQuery = database.selectFrom("accessGroups").selectAll().where("deletedAt", "is", null);
  if (ancestors)
    groupQuery = ancestors.length
      ? groupQuery.where("id", "in", ancestors)
      : groupQuery.where(sql<boolean>`false`);
  const groups = await groupQuery.execute();
  let edgeQuery = database.selectFrom("accessGroupMembers").selectAll();
  if (memberIds)
    edgeQuery = edgeQuery.where((eb) =>
      eb.or([
        eb.and([eb("memberKind", "=", "user"), eb("memberId", "in", memberIds)]),
        ...(ancestors?.length
          ? [eb.and([eb("memberKind", "=", "group"), eb("memberId", "in", ancestors)])]
          : []),
      ]),
    );
  const edges = await edgeQuery.execute();
  let entryQuery = database
    .selectFrom("accessEntries")
    .selectAll()
    .where("revokedAt", "is", null)
    .where((eb) =>
      eb.or([
        ...(retainedEntryIds.length ? [eb("id", "in", retainedEntryIds)] : []),
        eb("expiresAt", "is", null),
        eb("expiresAt", ">", sql<Date>`clock_timestamp()`),
        sql<boolean>`exists (select 1 from workspace_memberships membership
        where membership.state = 'active' and membership.effective_until is not null
          and membership.workspace_id = access_entries.target_id and membership.effective_until <= access_entries.expires_at
          and (access_entries.subject_kind <> 'user' or membership.user_id = access_entries.subject_id)
          ${memberIds ? sql`and membership.user_id in (${sql.join(memberIds)})` : sql``})`,
      ]),
    );
  if (memberIds)
    entryQuery = entryQuery.where((eb) =>
      eb.or([
        eb.and([eb("subjectKind", "=", "user"), eb("subjectId", "in", memberIds)]),
        ...(ancestors?.length
          ? [eb.and([eb("subjectKind", "=", "group"), eb("subjectId", "in", ancestors)])]
          : []),
      ]),
    );
  const entries = await entryQuery.execute();
  return { users, projects, groups, edges, entries };
}

function groupPeople(graph: Graph): { people: Map<string, Set<UserId>>; depth: number } {
  const users = new Map(graph.users.map((user) => [user.id, user]));
  const groups = new Map(graph.groups.map((group) => [group.id, group]));
  const children = new Map<string, typeof graph.edges>();
  for (const edge of graph.edges) {
    if (!groups.has(edge.groupId)) continue;
    const list = children.get(edge.groupId) ?? [];
    list.push(edge);
    children.set(edge.groupId, list);
  }
  const people = new Map<string, Set<UserId>>();
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): Set<UserId> => {
    if (visiting.has(id)) refuse("Access groups cannot contain a cycle");
    const cached = people.get(id);
    if (cached) return cached;
    const group = groups.get(id);
    if (!group) refuse("Group member does not exist");
    visiting.add(id);
    const result = new Set<UserId>();
    let depth = 1;
    if (group.builtin === "everyone") {
      if (children.get(id)?.length) refuse("Everyone cannot have stored members");
      for (const user of graph.users)
        if (user.memberKind === "full" && user.memberState === "active" && user.admittedAt)
          result.add(user.id);
    } else
      for (const edge of children.get(id) ?? []) {
        if (edge.memberKind === "group") {
          for (const userId of visit(edge.memberId)) result.add(userId);
          depth = Math.max(depth, 1 + depths.get(edge.memberId)!);
        } else {
          const user = users.get(edge.memberId as UserId);
          if (!user) refuse("Group member does not exist");
          if (user.memberState === "active" && user.admittedAt) result.add(user.id);
        }
      }
    visiting.delete(id);
    people.set(id, result);
    depths.set(id, depth);
    return result;
  };
  for (const group of graph.groups) visit(group.id);
  return { people, depth: Math.max(0, ...depths.values()) };
}

function entriesByPair(
  graph: Graph,
  input: {
    readonly asOf: Date;
    readonly includeExpiredFor?: ReadonlySet<string>;
    readonly onlyPairs?: ReadonlySet<string>;
  },
): Map<string, { pair: Pair; entries: Entry[] }> {
  const { people } = groupPeople(graph);
  const users = new Map(graph.users.map((user) => [user.id, user]));
  const projects = new Set(graph.projects.map((project) => project.id));
  const pairs = new Map<string, { pair: Pair; entries: Entry[] }>();
  for (const entry of graph.entries) {
    if (entry.targetKind !== "project" || !projects.has(entry.targetId as WorkspaceId)) continue;
    const live =
      entry.grantedAt <= input.asOf && (!entry.expiresAt || entry.expiresAt > input.asOf);
    if (!live && !input.includeExpiredFor?.size) continue;
    const ids =
      entry.subjectKind === "group"
        ? (people.get(entry.subjectId) ?? [])
        : entry.subjectKind === "user"
          ? [entry.subjectId as UserId]
          : [];
    for (const userId of ids) {
      const user = users.get(userId);
      if (!user || !user.admittedAt || user.memberState !== "active") continue;
      const pair = { userId, workspaceId: entry.targetId as WorkspaceId };
      const key = pairKey(pair);
      if (input.onlyPairs && !input.onlyPairs.has(key)) continue;
      if (!live && !input.includeExpiredFor?.has(key)) continue;
      let value = pairs.get(key);
      if (!value) {
        value = { pair, entries: [] };
        pairs.set(key, value);
      }
      value.entries.push(entry);
    }
  }
  return pairs;
}

function effective(entries: readonly Entry[], asOf: Date): Effective {
  const live = entries.filter(
    (entry) => entry.grantedAt <= asOf && (!entry.expiresAt || entry.expiresAt > asOf),
  );
  const level = live.some((entry) => entry.level === "manage")
    ? "manage"
    : live.length
      ? "use"
      : null;
  const top = live.filter((entry) => entry.level === level);
  return {
    level,
    until:
      !top.length || top.some((entry) => !entry.expiresAt)
        ? null
        : new Date(Math.max(...top.map((entry) => entry.expiresAt!.getTime()))),
  };
}

function capacityError(limit: keyof typeof accessCapacity, count: number): never {
  throw new OpensteerError({
    code: "resource_exhausted",
    reason: "access-capacity",
    message: "Access change exceeds the safety limit",
    details: { limit, maximum: accessCapacity[limit], count },
  });
}

function checkCapacity(old: Graph, next: Graph, asOf: Date): void {
  const measure = (graph: Graph) => {
    const pairs = entriesByPair(graph, { asOf });
    let effectivePairs = 0;
    for (const { entries } of pairs.values()) {
      const count = entries.filter(
        (entry) => entry.grantedAt <= asOf && (!entry.expiresAt || entry.expiresAt > asOf),
      ).length;
      if (count) effectivePairs++;
    }
    return {
      projects: graph.projects.length,
      groups: graph.groups.filter((group) => !group.builtin).length,
      depth: groupPeople(graph).depth,
      edges: graph.edges.length,
      effectivePairs,
    };
  };
  const before = measure(old);
  const after = measure(next);
  for (const key of Object.keys(after) as (keyof typeof after)[])
    if (after[key] > accessCapacity[key] && after[key] > before[key])
      capacityError(key, after[key]);
  const oldPairs = entriesByPair(old, { asOf });
  for (const [key, value] of entriesByPair(next, { asOf }))
    if (
      value.entries.length > accessCapacity.matchingEntries &&
      value.entries.length > (oldPairs.get(key)?.entries.length ?? 0)
    )
      capacityError("matchingEntries", value.entries.length);
}

function propose(graph: Graph, change: AccessMutation, actorId: UserId, now: Date): Graph {
  const next = structuredClone(graph);
  const group = (id: string) => {
    const value = next.groups.find((candidate) => candidate.id === id);
    if (!value) refuse("Group does not exist");
    return value;
  };
  switch (change.kind) {
    case "create-project":
      z.uuid().parse(change.entryId);
      WorkspaceBackingSchema.parse(change.backing);
      MarkColorSchema.parse(change.color);
      if (!change.name.trim()) refuse("Project name is required");
      if (next.projects.some((project) => project.id === change.workspaceId))
        refuse("Project already exists");
      next.projects.push({ id: change.workspaceId, createdBy: actorId });
      next.entries.push({
        id: change.entryId,
        subjectKind: "user",
        subjectId: actorId,
        targetKind: "project",
        targetId: change.workspaceId,
        level: "manage",
        grantedBy: actorId,
        grantedAt: now,
        expiresAt: null,
        revokedAt: null,
        revokedBy: null,
      });
      break;
    case "create-group":
      z.uuid().parse(change.id);
      if (!change.name.trim() || change.name.trim().length > 120) refuse("Invalid group name");
      if (
        next.groups.some(
          (value) =>
            value.id === change.id ||
            value.name.trim().toLowerCase() === change.name.trim().toLowerCase() ||
            (change.builtin && value.builtin === change.builtin),
        )
      )
        refuse("Group already exists");
      next.groups.push({
        id: change.id,
        name: change.name.trim(),
        builtin: change.builtin ?? null,
        createdBy: actorId,
        createdAt: now,
        deletedAt: null,
      });
      break;
    case "delete-group":
      if (group(change.groupId).builtin) refuse("Everyone cannot be deleted");
      next.groups = next.groups.filter((value) => value.id !== change.groupId);
      next.edges = next.edges.filter(
        (value) =>
          value.groupId !== change.groupId &&
          !(value.memberKind === "group" && value.memberId === change.groupId),
      );
      next.entries = next.entries.filter(
        (value) => !(value.subjectKind === "group" && value.subjectId === change.groupId),
      );
      break;
    case "add-group-member":
    case "remove-group-member": {
      if (group(change.groupId).builtin) refuse("Everyone cannot be edited");
      const memberKind = change.member.kind === "person" ? "user" : "group";
      const memberId =
        change.member.kind === "person" ? change.member.userId : change.member.groupId;
      if (memberKind === "group") group(memberId);
      else if (!next.users.some((user) => user.id === memberId)) refuse("Person does not exist");
      const matches = (edge: Graph["edges"][number]) =>
        edge.groupId === change.groupId &&
        edge.memberKind === memberKind &&
        edge.memberId === memberId;
      if (change.kind === "remove-group-member")
        next.edges = next.edges.filter((edge) => !matches(edge));
      else if (!next.edges.some(matches))
        next.edges.push({
          groupId: change.groupId,
          memberKind,
          memberId,
          addedBy: actorId,
          addedAt: now,
        });
      break;
    }
    case "grant": {
      z.uuid().parse(change.id);
      if (change.target.kind !== "project") refuse("This access target is not implemented");
      if (change.subject.kind === "project") refuse("Project-to-Project grants are unavailable");
      if (change.level !== "use" && change.level !== "manage")
        refuse("Invalid Project access level");
      const workspaceId = change.target.workspaceId;
      if (!next.projects.some((project) => project.id === workspaceId))
        refuse("Live Project is required");
      if (
        change.expiresAt &&
        (!Number.isFinite(change.expiresAt.getTime()) || change.expiresAt <= now)
      )
        refuse("Grant expiry must be in the future");
      const subjectKind = change.subject.kind === "person" ? "user" : "group";
      const subjectId =
        change.subject.kind === "person" ? change.subject.userId : change.subject.groupId;
      if (subjectKind === "group") group(subjectId);
      else if (
        !next.users.some(
          (user) => user.id === subjectId && user.admittedAt && user.memberState === "active",
        )
      )
        refuse("Active admitted person is required");
      next.entries.push({
        id: change.id,
        subjectKind,
        subjectId,
        targetKind: "project",
        targetId: change.target.workspaceId,
        level: change.level,
        grantedBy: actorId,
        grantedAt: now,
        expiresAt: change.expiresAt ?? null,
        revokedAt: null,
        revokedBy: null,
      });
      break;
    }
    case "revoke":
      if (!next.entries.some((entry) => entry.id === change.entryId))
        refuse("Live access entry is required");
      next.entries = next.entries.filter((entry) => entry.id !== change.entryId);
      break;
    case "member": {
      const user = next.users.find((value) => value.id === change.userId);
      if (!user) refuse("Person does not exist");
      if (change.memberKind) user.memberKind = change.memberKind;
      if (change.memberState) user.memberState = change.memberState;
      if (change.admit) user.admittedAt ??= now;
      break;
    }
    case "delete-project":
      if (!Number.isFinite(change.purgeAfter.getTime()) || change.purgeAfter < now)
        refuse("Project deletion requires a future retention deadline");
      if (!next.projects.some((project) => project.id === change.workspaceId))
        refuse("Live Project is required");
      next.projects = next.projects.filter((project) => project.id !== change.workspaceId);
      break;
  }
  groupPeople(next);
  return next;
}

function affectedPairs(
  old: Graph,
  next: Graph,
  memberships: readonly Membership[],
  change: AccessMutation,
  asOf: Date,
): Pair[] {
  const activePairs = new Set(memberships.filter((row) => row.state === "active").map(pairKey));
  const before = entriesByPair(old, { asOf, includeExpiredFor: activePairs });
  const after = entriesByPair(next, { asOf, includeExpiredFor: activePairs });
  const result = new Map<string, Pair>();
  const signature = (entries: readonly Entry[] | undefined) =>
    entries
      ?.map((entry) => entry.id)
      .sort()
      .join(",") ?? "";
  for (const [key, value] of new Map([...before, ...after]))
    if (!change || signature(before.get(key)?.entries) !== signature(after.get(key)?.entries))
      result.set(key, value.pair);
  for (const row of memberships)
    if (
      row.state === "active" &&
      ((!change && row.effectiveUntil) ||
        (change?.kind === "member" && change.userId === row.userId) ||
        (change?.kind === "delete-project" && change.workspaceId === row.workspaceId))
    )
      result.set(pairKey(row), { userId: row.userId, workspaceId: row.workspaceId });
  if (
    change.kind === "delete-group" ||
    change.kind === "add-group-member" ||
    change.kind === "remove-group-member"
  ) {
    const people = new Set<UserId>();
    const targets = new Set<WorkspaceId>();
    for (const graph of [old, next]) {
      const ancestors = new Set([change.groupId]);
      const queue = [change.groupId];
      for (const child of queue)
        for (const edge of graph.edges)
          if (
            edge.memberKind === "group" &&
            edge.memberId === child &&
            !ancestors.has(edge.groupId)
          ) {
            ancestors.add(edge.groupId);
            queue.push(edge.groupId);
          }
      const child =
        change.kind === "delete-group"
          ? { kind: "group" as const, groupId: change.groupId }
          : change.member;
      if (child.kind === "person") people.add(child.userId);
      else
        for (const userId of groupPeople(graph).people.get(child.groupId) ?? []) people.add(userId);
      for (const entry of graph.entries)
        if (
          entry.subjectKind === "group" &&
          ancestors.has(entry.subjectId) &&
          entry.targetKind === "project"
        )
          targets.add(entry.targetId as WorkspaceId);
    }
    for (const userId of people)
      for (const workspaceId of targets) {
        const pair = { userId, workspaceId };
        const key = pairKey(pair);
        if (before.has(key) || after.has(key)) result.set(key, pair);
      }
  }
  const live = new Set([...old.projects, ...next.projects].map((project) => project.id));
  const stored = new Set(memberships.filter((row) => row.state === "active").map(pairKey));
  return [...result.values()]
    .filter(
      (pair) =>
        live.has(pair.workspaceId) &&
        (stored.has(pairKey(pair)) ||
          effective(before.get(pairKey(pair))?.entries ?? [], asOf).level ||
          effective(after.get(pairKey(pair))?.entries ?? [], asOf).level),
    )
    .sort((first, second) => pairKey(first).localeCompare(pairKey(second)));
}

async function lockMemberships(
  transaction: AccessTransaction,
  pairs: readonly Pair[],
): Promise<void> {
  const scopes = new Map<WorkspaceId, UserId[]>();
  for (const pair of pairs) {
    const users = scopes.get(pair.workspaceId) ?? [];
    users.push(pair.userId);
    scopes.set(pair.workspaceId, users);
  }
  if (pairs.length)
    await transaction
      .selectFrom("workspaceMemberships")
      .select("id")
      .where((eb) =>
        eb.or(
          [...scopes].map(([workspaceId, userIds]) =>
            eb.and([eb("workspaceId", "=", workspaceId), eb("userId", "in", userIds)]),
          ),
        ),
      )
      .orderBy("id", "asc")
      .forNoKeyUpdate()
      .execute();
  heldMemberships.set(transaction, new Set(pairs.map(pairKey)));
}

export async function recomputeProjectMemberships(
  transaction: AccessTransaction,
  input: {
    readonly pairs: readonly Pair[];
    readonly asOf: Date;
    readonly causeId: CommandId;
    readonly graph?: Graph;
  },
): Promise<readonly MembershipTransition[]> {
  if (!writerTransactions.has(transaction))
    throw new Error("Access writer transaction is required");
  const held = heldMemberships.get(transaction);
  if (input.pairs.some((pair) => !held?.has(pairKey(pair))))
    throw new Error("Membership scope was not reserved");
  if (!input.pairs.length) return [];
  const graph =
    input.graph ??
    (await readGraph(transaction, [...new Set(input.pairs.map((pair) => pair.userId))]));
  const pairs = new Set(input.pairs.map(pairKey));
  const entries = entriesByPair(graph, {
    asOf: input.asOf,
    includeExpiredFor: pairs,
    onlyPairs: pairs,
  });
  const memberships = new Map(
    (
      await transaction
        .selectFrom("workspaceMemberships")
        .selectAll()
        .where("workspaceId", "in", [...new Set(input.pairs.map((pair) => pair.workspaceId))])
        .where("userId", "in", [...new Set(input.pairs.map((pair) => pair.userId))])
        .execute()
    ).map((row) => [pairKey(row), row]),
  );
  const transitions: MembershipTransition[] = [];
  const changedRows = new Map<string, Membership>();
  for (const pair of input.pairs) {
    const grants = entries.get(pairKey(pair))?.entries ?? [];
    let row = memberships.get(pairKey(pair));
    const times =
      row?.state === "active" && row.effectiveUntil && row.effectiveUntil <= input.asOf
        ? [
            ...new Set([
              row.effectiveUntil.getTime(),
              ...grants.flatMap((entry) =>
                entry.expiresAt &&
                entry.expiresAt >= row!.effectiveUntil! &&
                entry.expiresAt <= input.asOf
                  ? [entry.expiresAt.getTime()]
                  : [],
              ),
            ]),
          ].sort((first, second) => first - second)
        : [];
    times.push(input.asOf.getTime());
    for (const milliseconds of new Set(times)) {
      const now = new Date(milliseconds);
      const next = effective(grants, now);
      const state = next.level ? "active" : "revoked";
      const role =
        next.level === "manage"
          ? "owner"
          : next.level === "use"
            ? "collaborator"
            : (row?.role ?? "collaborator");
      if (!row && state === "revoked") continue;
      const changed = !row || row.state !== state || (state === "active" && row.role !== role);
      if (!changed && row && row.effectiveUntil?.getTime() === next.until?.getTime()) continue;
      const previousGeneration = row ? safeGeneration(row.generation) : null;
      const generation =
        previousGeneration === null ? 1 : changed ? previousGeneration + 1 : previousGeneration;
      if (!Number.isSafeInteger(generation)) throw new Error("Membership generation exhausted");
      const values = {
        state,
        role,
        generation,
        effectiveUntil: next.until,
        updatedAt: now,
        joinedAt: row?.state === "active" ? row.joinedAt : now,
        revokedAt: state === "revoked" ? (row?.revokedAt ?? now) : null,
        revokedBy: null,
      } as const;
      row = {
        ...row,
        ...values,
        ...pair,
        id: row?.id ?? createId("workspaceMembership"),
        invitedBy: row?.invitedBy ?? null,
      };
      changedRows.set(pairKey(pair), row);
      if (changed) {
        transitions.push({
          ...pair,
          generation,
          previousGeneration,
          state,
          role,
          effectiveUntil: next.until,
        });
      }
    }
  }
  const rows = [...changedRows.values()];
  const inserts = rows.filter((row) => !memberships.has(pairKey(row)));
  for (let offset = 0; offset < inserts.length; offset += 1000)
    await transaction
      .insertInto("workspaceMemberships")
      .values(inserts.slice(offset, offset + 1000))
      .execute();
  const updates = rows
    .filter((row) => memberships.has(pairKey(row)))
    .map((row) => ({
      id: row.id,
      state: row.state,
      role: row.role,
      generation: row.generation,
      effective_until: row.effectiveUntil,
      updated_at: row.updatedAt,
      joined_at: row.joinedAt,
      revoked_at: row.revokedAt,
      revoked_by: row.revokedBy,
    }));
  if (updates.length)
    await sql`update workspace_memberships membership set
    state = change.state, role = change.role, generation = change.generation,
    effective_until = change.effective_until, updated_at = change.updated_at,
    joined_at = change.joined_at, revoked_at = change.revoked_at, revoked_by = change.revoked_by
    from jsonb_to_recordset(${JSON.stringify(updates)}::jsonb) as change (
      id text, state text, role text, generation bigint, effective_until timestamptz,
      updated_at timestamptz, joined_at timestamptz, revoked_at timestamptz, revoked_by text
    ) where membership.id = change.id`.execute(transaction);
  const effects = transitions
    .filter((change) => change.previousGeneration !== null)
    .flatMap((change) =>
      [
        "close-realtime",
        "stop-runs",
        "revoke-mounts",
        "revoke-browser",
        "revoke-credentials",
        "revoke-triggers",
      ].map((kind) => ({
        id: createId("securityEffect"),
        kind,
        workspace_id: change.workspaceId,
        user_id: change.userId,
        membership_generation: change.generation,
        membership_generation_cutoff: change.previousGeneration,
      })),
    );
  if (effects.length)
    await sql`insert into security_effects (
    id, kind, workspace_id, user_id, membership_generation, membership_generation_cutoff,
    cause_id, next_attempt_at, status, last_error
  ) select id, kind, workspace_id, user_id, membership_generation, membership_generation_cutoff,
    ${input.causeId}, ${input.asOf}, 'pending', null
    from jsonb_to_recordset(${JSON.stringify(effects)}::jsonb) as effect (
      id text, kind text, workspace_id text, user_id text,
      membership_generation bigint, membership_generation_cutoff bigint
    )`.execute(transaction);
  return transitions;
}

async function applySource(
  transaction: AccessTransaction,
  old: Graph,
  next: Graph,
  input: AccessMutationInput,
  now: Date,
): Promise<void> {
  for (const change of input.changes)
    if (change.kind === "create-project")
      await transaction
        .insertInto("workspaces")
        .values({
          id: change.workspaceId,
          kind: "project",
          createdBy: input.actor.userId,
          name: change.name.trim(),
          color: change.color,
          backing: jsonValue(change.backing),
          status: "provisioning",
        })
        .execute();
  const oldGroups = new Set(old.groups.map((group) => group.id));
  const nextGroups = new Set(next.groups.map((group) => group.id));
  const deletedGroups = old.groups
    .filter((group) => !nextGroups.has(group.id))
    .map((group) => group.id);
  if (deletedGroups.length) {
    await transaction
      .selectFrom("accessGroups")
      .select("id")
      .where("id", "in", deletedGroups)
      .orderBy("id")
      .forNoKeyUpdate()
      .execute();
    await transaction
      .updateTable("accessGroups")
      .set({ deletedAt: now })
      .where("id", "in", deletedGroups)
      .execute();
  }
  const addedGroups = next.groups.filter((group) => !oldGroups.has(group.id));
  for (const change of input.changes)
    if (change.kind === "create-group" && !nextGroups.has(change.id))
      addedGroups.push({
        id: change.id,
        name: change.name.trim(),
        builtin: change.builtin ?? null,
        createdBy: input.actor.userId,
        createdAt: now,
        deletedAt: now,
      });
  if (addedGroups.length)
    await transaction.insertInto("accessGroups").values(addedGroups).execute();
  const edgeKey = (edge: Graph["edges"][number]) =>
    JSON.stringify([edge.groupId, edge.memberKind, edge.memberId]);
  const oldEdges = new Set(old.edges.map(edgeKey));
  const nextEdges = new Set(next.edges.map(edgeKey));
  const removedEdges = old.edges.filter((edge) => !nextEdges.has(edgeKey(edge)));
  if (removedEdges.length) {
    const matches = sql<boolean>`(group_id, member_kind, member_id) in (
      select group_id, member_kind, member_id from jsonb_to_recordset(${JSON.stringify(removedEdges.map((edge) => ({ group_id: edge.groupId, member_kind: edge.memberKind, member_id: edge.memberId })))}::jsonb)
        as edge(group_id uuid, member_kind text, member_id text)
    )`;
    await transaction
      .selectFrom("accessGroupMembers")
      .select("groupId")
      .where(matches)
      .orderBy("groupId")
      .orderBy("memberKind")
      .orderBy("memberId")
      .forNoKeyUpdate()
      .execute();
    await transaction.deleteFrom("accessGroupMembers").where(matches).execute();
  }
  const addedEdges = next.edges.filter((edge) => !oldEdges.has(edgeKey(edge)));
  if (addedEdges.length)
    await transaction.insertInto("accessGroupMembers").values(addedEdges).execute();
  const oldEntries = new Set(old.entries.map((entry) => entry.id));
  const nextEntries = new Set(next.entries.map((entry) => entry.id));
  const removedEntries = old.entries
    .filter((entry) => !nextEntries.has(entry.id))
    .map((entry) => entry.id);
  if (removedEntries.length || deletedGroups.length) {
    const removed = (query: typeof transaction) =>
      query
        .selectFrom("accessEntries")
        .select("id")
        .where("revokedAt", "is", null)
        .where((eb) =>
          eb.or([
            ...(removedEntries.length ? [eb("id", "in", removedEntries)] : []),
            ...(deletedGroups.length
              ? [eb.and([eb("subjectKind", "=", "group"), eb("subjectId", "in", deletedGroups)])]
              : []),
          ]),
        );
    const ids = (await removed(transaction).orderBy("id").forNoKeyUpdate().execute()).map(
      (entry) => entry.id,
    );
    if (ids.length)
      await transaction
        .updateTable("accessEntries")
        .set({ revokedAt: now, revokedBy: input.actor.userId })
        .where("id", "in", ids)
        .execute();
  }
  const addedEntries = next.entries.filter((entry) => !oldEntries.has(entry.id));
  const transientIds = input.changes.flatMap((change) =>
    change.kind === "grant" && !nextEntries.has(change.id) ? [change.id] : [],
  );
  if (transientIds.length) {
    let graph = old;
    for (const change of input.changes) {
      graph = propose(graph, change, input.actor.userId, now);
      if (change.kind === "grant" && transientIds.includes(change.id))
        addedEntries.push({
          ...graph.entries.find((entry) => entry.id === change.id)!,
          revokedAt: now,
          revokedBy: input.actor.userId,
        });
    }
  }
  if (addedEntries.length)
    await transaction.insertInto("accessEntries").values(addedEntries).execute();
  for (const change of input.changes)
    if (change.kind === "delete-project")
      await transaction
        .updateTable("workspaces")
        .set({
          status: "deleting",
          deletedAt: null,
          deletionRequestedAt: now,
          deletionRequestedBy: input.actor.userId,
          purgeAfter: change.purgeAfter,
          updatedAt: now,
        })
        .where("id", "=", change.workspaceId)
        .execute();
  const changedUsers = next.users
    .filter((after) => {
      const before = old.users.find((user) => user.id === after.id)!;
      return (
        before.memberKind !== after.memberKind ||
        before.memberState !== after.memberState ||
        before.admittedAt?.getTime() !== after.admittedAt?.getTime()
      );
    })
    .sort((first, second) => first.id.localeCompare(second.id));
  if (changedUsers.some((after) => after.memberState !== "active")) {
    const admins = await transaction
      .selectFrom("users")
      .select("id")
      .where("instanceRole", "=", "administrator")
      .where("memberState", "=", "active")
      .where("admittedAt", "is not", null)
      .execute();
    if (
      admins.length &&
      !admins.some(
        (admin) =>
          !changedUsers.some((user) => user.id === admin.id && user.memberState !== "active"),
      )
    )
      refuse("The last active administrator cannot be removed");
  }
  for (const after of changedUsers) {
    const before = old.users.find((user) => user.id === after.id)!;
    await transaction
      .updateTable("users")
      .set({
        memberKind: after.memberKind,
        memberState: after.memberState,
        admittedAt: after.admittedAt,
        ...(before.memberState !== after.memberState
          ? {
              authorityGeneration: sql`authority_generation + 1`,
              memberStateChangedAt: now,
              memberStateChangedBy: input.actor.userId,
            }
          : {}),
      })
      .where("id", "=", after.id)
      .execute();
  }
}

async function authorizeMutation(
  transaction: AccessTransaction,
  input: AccessMutationInput,
  change: AccessMutation,
): Promise<void> {
  const actor = await transaction
    .selectFrom("users")
    .selectAll()
    .where("id", "=", input.actor.userId)
    .executeTakeFirst();
  if (
    !actor ||
    actor.memberState !== "active" ||
    !actor.admittedAt ||
    (input.actor.authorityGeneration !== undefined &&
      safeGeneration(actor.authorityGeneration) !== input.actor.authorityGeneration)
  )
    throw new OpensteerError({ code: "forbidden", message: "Active admitted human is required" });
  if (actor.instanceRole === "administrator") return;
  let workspaceId: WorkspaceId | undefined;
  if (change.kind === "grant" && change.target.kind === "project")
    workspaceId = change.target.workspaceId;
  if (change.kind === "revoke") {
    const entry = await transaction
      .selectFrom("accessEntries")
      .select(["targetId", "targetKind"])
      .where("id", "=", change.entryId)
      .executeTakeFirst();
    if (entry?.targetKind === "project") workspaceId = entry.targetId as WorkspaceId;
  }
  if (
    workspaceId &&
    (
      await checkAccess(transaction, {
        principal: { kind: "person", userId: actor.id },
        callerKind: "person",
        target: { kind: "project", workspaceId },
        action: "manage",
      })
    ).allowed
  )
    return;
  throw new OpensteerError({
    code: "forbidden",
    message: "Human access administration is required",
  });
}

export async function mutateAccess(
  database: Database,
  input: AccessMutationInput,
): Promise<AccessMutationResult> {
  if (!input.changes.length) refuse("At least one access change is required");
  const introducedIds = input.changes.flatMap((change) =>
    change.kind === "grant"
      ? [change.id]
      : change.kind === "create-project"
        ? [change.entryId]
        : [],
  );
  if (new Set(introducedIds).size !== introducedIds.length) refuse("Access entries are immutable");
  const memberIds = input.changes.every((change) => change.kind === "member")
    ? [
        ...new Set(
          input.changes.map(
            (change) => (change as Extract<AccessMutation, { kind: "member" }>).userId,
          ),
        ),
      ]
    : undefined;
  const requestScope = new Set<WorkspaceId>();
  const plans = new WeakMap<
    AccessTransaction,
    {
      old: Graph;
      next: Graph;
      pairs: Pair[];
      revision: number;
      growing: boolean;
    }
  >();
  const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  try {
    return await withRequestWorkspaceLocks(
      database,
      async (transaction) => {
        const plan = plans.get(transaction)!;
        const ids = new Set(plan.pairs.map((pair) => pair.workspaceId));
        for (const id of await discoverRequestWorkspaces(transaction, {
          membershipPairs: plan.pairs,
          pending: true,
        }))
          ids.add(id);
        for (const id of ids) requestScope.add(id);
        if (plan.growing && requestScope.size > accessCapacity.requestWorkspaces)
          capacityError("requestWorkspaces", requestScope.size);
        return [...ids];
      },
      async (transaction) => {
        await lockMemberships(transaction, plans.get(transaction)!.pairs);
        for (const change of input.changes) await authorizeMutation(transaction, input, change);
        const receipt = await transaction
          .selectFrom("securityAudit")
          .select("metadata")
          .where("action", "=", "access.mutated")
          .where("requestId", "=", input.commandIdentity)
          .executeTakeFirst();
        if (receipt) {
          if (receipt.metadata.fingerprint !== fingerprint)
            conflict("Access command identity was reused");
          return resultSchema.parse(receipt.metadata.result);
        }
        const plan = plans.get(transaction)!;
        if (plan.revision !== input.expectedRevision) conflict("Access preview is stale");
        const now = await databaseTime(transaction);
        const transitions = [
          ...(await recomputeProjectMemberships(transaction, {
            pairs: plan.pairs,
            asOf: now,
            causeId: input.commandIdentity,
            graph: plan.old,
          })),
        ];
        const next = input.changes.reduce(
          (graph, change) => propose(graph, change, input.actor.userId, now),
          plan.old,
        );
        await applySource(transaction, plan.old, next, input, now);
        transitions.push(
          ...(await recomputeProjectMemberships(transaction, {
            pairs: plan.pairs,
            asOf: now,
            causeId: input.commandIdentity,
            graph: next,
          })),
        );
        const revision = plan.revision + 1;
        if (!Number.isSafeInteger(revision)) throw new Error("Access revision exhausted");
        await transaction
          .updateTable("accessState")
          .set({ revision })
          .where("singletonKey", "=", "primary")
          .execute();
        const result = { revision, transitions };
        await transaction
          .insertInto("securityAudit")
          .values({
            id: createId("securityAudit"),
            action: "access.mutated",
            actorUserId: input.actor.userId,
            actorSessionId: null,
            workspaceId: null,
            requestId: input.commandIdentity,
            targetId: null,
            targetType: "access",
            metadata: jsonValue({ fingerprint, result }),
          })
          .execute();
        return result;
      },
      async (transaction) => {
        await takeWriterLock(transaction);
        await requireNewAuthority(transaction);
        const state = await transaction
          .selectFrom("accessState")
          .select("revision")
          .where("singletonKey", "=", "primary")
          .forNoKeyUpdate()
          .executeTakeFirstOrThrow();
        const old = await readGraph(
          transaction,
          memberIds,
          input.changes.flatMap((change) => (change.kind === "revoke" ? [change.entryId] : [])),
        );
        const now = await databaseTime(transaction);
        const receipt = await transaction
          .selectFrom("securityAudit")
          .select("id")
          .where("action", "=", "access.mutated")
          .where("requestId", "=", input.commandIdentity)
          .executeTakeFirst();
        if (receipt) {
          plans.set(transaction, {
            old,
            next: old,
            pairs: [],
            revision: safeGeneration(state.revision),
            growing: false,
          });
          return;
        }
        if (
          introducedIds.length &&
          (await transaction
            .selectFrom("accessEntries")
            .select("id")
            .where("id", "in", introducedIds)
            .executeTakeFirst())
        )
          refuse("Access entries are immutable");
        const next = input.changes.reduce(
          (graph, change) => propose(graph, change, input.actor.userId, now),
          old,
        );
        checkCapacity(old, next, now);
        let membershipQuery = transaction
          .selectFrom("workspaceMemberships")
          .selectAll()
          .where("state", "=", "active");
        if (memberIds) membershipQuery = membershipQuery.where("userId", "in", memberIds);
        const memberships = await membershipQuery.execute();
        if (memberIds) {
          const projected = entriesByPair(next, { asOf: now }).size;
          const delta = projected - memberships.length;
          if (delta > 0) {
            const total = await transaction
              .selectFrom("workspaceMemberships")
              .select(sql<string>`count(*)`.as("count"))
              .where("state", "=", "active")
              .executeTakeFirstOrThrow();
            if (Number(total.count) + delta > accessCapacity.effectivePairs)
              capacityError("effectivePairs", Number(total.count) + delta);
          }
        }
        const pairs = new Map<string, Pair>();
        let intermediate = old;
        for (const change of input.changes) {
          const proposed = propose(intermediate, change, input.actor.userId, now);
          for (const pair of affectedPairs(intermediate, proposed, memberships, change, now))
            pairs.set(pairKey(pair), pair);
          intermediate = proposed;
        }
        const beforePairs = entriesByPair(old, { asOf: now });
        const afterPairs = entriesByPair(next, { asOf: now });
        const growing = [...afterPairs].some(([key, value]) => {
          const before = beforePairs.get(key)?.entries ?? [];
          return (
            value.entries.length > before.length ||
            (effective(value.entries, now).level === "manage" &&
              effective(before, now).level !== "manage")
          );
        });
        if (growing && pairs.size > accessCapacity.affectedPairs)
          capacityError("affectedPairs", pairs.size);
        plans.set(transaction, {
          old,
          next,
          pairs: [...pairs.values()],
          revision: safeGeneration(state.revision),
          growing,
        });
      },
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "55P03")
      conflict("Access writer is busy");
    throw error;
  }
}

export async function checkAccess(
  database: Database,
  input: {
    readonly principal: AccessPrincipal;
    readonly callerKind: "person" | "agent";
    readonly target: AccessTarget | { readonly kind: "deployment" };
    readonly action: AccessAction;
    readonly expectedMemberGeneration?: number;
    readonly expectedMembershipGeneration?: number;
  },
): Promise<AccessDecision> {
  if (input.target.kind === "topic" || input.target.kind === "team-account")
    return { allowed: false };
  if (input.principal.kind === "project") {
    if (
      input.target.kind !== "project" ||
      input.target.workspaceId !== input.principal.workspaceId ||
      input.action !== "use"
    )
      return { allowed: false };
    const row = await database
      .selectFrom("workspaces")
      .select("id")
      .where("id", "=", input.principal.workspaceId)
      .where("kind", "=", "project")
      .where("deletedAt", "is", null)
      .where("status", "not in", ["deleting", "deleted"])
      .executeTakeFirst();
    return { allowed: !!row };
  }
  const user = await database
    .selectFrom("users")
    .select([
      "id",
      "disabledAt",
      "memberState",
      "admittedAt",
      "authorityGeneration",
      "instanceRole",
    ])
    .where("id", "=", input.principal.userId)
    .executeTakeFirst();
  const deployment = await database
    .selectFrom("deployments")
    .select(["authorityModelVersion", "deploymentShape"])
    .where("singletonKey", "=", "primary")
    .executeTakeFirst();
  const isNew =
    deployment?.authorityModelVersion === 2 && deployment.deploymentShape.kind === "server";
  if (
    !user ||
    user.disabledAt ||
    (isNew && (user.memberState !== "active" || !user.admittedAt)) ||
    (input.expectedMemberGeneration !== undefined &&
      safeGeneration(user.authorityGeneration) !== input.expectedMemberGeneration)
  )
    return { allowed: false };
  if (input.action === "administer" || input.action === "inspect")
    return { allowed: input.callerKind === "person" && user.instanceRole === "administrator" };
  if (input.target.kind !== "project" || (input.action !== "use" && input.action !== "manage"))
    return { allowed: false };
  const membership = await database
    .selectFrom("workspaceMemberships")
    .innerJoin("workspaces", "workspaces.id", "workspaceMemberships.workspaceId")
    .innerJoin("users", "users.id", "workspaceMemberships.userId")
    .select([
      "workspaceMemberships.generation",
      "workspaceMemberships.role",
      "workspaceMemberships.effectiveUntil",
      "users.authorityGeneration as currentMemberGeneration",
    ])
    .where("workspaceMemberships.userId", "=", user.id)
    .where("workspaceMemberships.workspaceId", "=", input.target.workspaceId)
    .where("workspaces.deletedAt", "is", null)
    .where("workspaces.status", "not in", ["deleting", "deleted"])
    .where("users.disabledAt", "is", null)
    .$if(input.expectedMemberGeneration !== undefined, (query) =>
      query.where("users.authorityGeneration", "=", String(input.expectedMemberGeneration!)),
    )
    .where(effectiveMembershipPredicate())
    .executeTakeFirst();
  if (
    !membership ||
    (input.action === "manage" && membership.role !== "owner") ||
    (input.expectedMembershipGeneration !== undefined &&
      safeGeneration(membership.generation) !== input.expectedMembershipGeneration)
  )
    return { allowed: false };
  return {
    allowed: true,
    memberGeneration: safeGeneration(membership.currentMemberGeneration),
    membershipGeneration: safeGeneration(membership.generation),
    effectiveUntil: membership.effectiveUntil,
  };
}

export async function expireAccessMemberships(
  database: Database,
): Promise<readonly MembershipTransition[]> {
  const scopes = new WeakMap<AccessTransaction, Pair[]>();
  const revisions = new WeakMap<AccessTransaction, number>();
  return withRequestWorkspaceLocks(
    database,
    async (transaction) => {
      const pairs = scopes.get(transaction)!;
      const ids = new Set(pairs.map((pair) => pair.workspaceId));
      for (const id of await discoverRequestWorkspaces(transaction, {
        membershipPairs: pairs,
        pending: true,
      }))
        ids.add(id);
      return [...ids];
    },
    async (transaction) => {
      const pairs = scopes.get(transaction)!;
      await lockMemberships(transaction, pairs);
      const causeId = createId("command");
      const transitions = await recomputeProjectMemberships(transaction, {
        pairs,
        asOf: await databaseTime(transaction),
        causeId,
      });
      if (transitions.length) {
        const revision = revisions.get(transaction)! + 1;
        if (!Number.isSafeInteger(revision)) throw new Error("Access revision exhausted");
        await transaction
          .updateTable("accessState")
          .set({ revision })
          .where("singletonKey", "=", "primary")
          .execute();
        await transaction
          .insertInto("securityAudit")
          .values({
            id: createId("securityAudit"),
            action: "access.expired",
            actorUserId: null,
            actorSessionId: null,
            workspaceId: null,
            requestId: causeId,
            targetId: null,
            targetType: "access",
            metadata: jsonValue({ revision, transitionCount: transitions.length }),
          })
          .execute();
      }
      return transitions;
    },
    async (transaction) => {
      await takeWriterLock(transaction);
      await requireNewAuthority(transaction);
      const state = await transaction
        .selectFrom("accessState")
        .select("revision")
        .where("singletonKey", "=", "primary")
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      revisions.set(transaction, safeGeneration(state.revision));
      const due = await transaction
        .selectFrom("workspaceMemberships")
        .select(["userId", "workspaceId"])
        .where("state", "=", "active")
        .where("effectiveUntil", "<=", sql<Date>`clock_timestamp()`)
        .execute();
      scopes.set(transaction, due);
    },
  );
}

export async function nextAccessDeadline(database: Database): Promise<Date | null> {
  const row = await database
    .selectFrom("workspaceMemberships")
    .select("effectiveUntil")
    .where("state", "=", "active")
    .where("effectiveUntil", "is not", null)
    .orderBy("effectiveUntil", "asc")
    .limit(1)
    .executeTakeFirst();
  return row?.effectiveUntil ?? null;
}
