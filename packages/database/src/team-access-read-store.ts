import { isEveryoneMember } from "./everyone-membership.js";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  type AuthenticatedHuman,
  type RunnerId,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import {
  SafeChangeSummarySchema,
  AuditItemSchema,
  type Page,
  type PageResult,
  type GroupRef,
  type MemberSummary,
  type EntryView,
  type Subject,
  type Level,
} from "@opensteer/protocol";
import { sql, type Kysely } from "kysely";
import { z } from "zod";
import type { DatabaseSchema } from "./schema.js";
import { checkAccess } from "./access-store.js";
import { requireTeamHuman, teamRefusal } from "./team-administration-authority.js";
import { requireTeamAuthority } from "./team-administration-authority.js";
import { safeGeneration } from "./store-primitives.js";
import { conversationUnreadPredicate } from "./message-visibility.js";
import { resolveProjectRuntime } from "./project-runtime-settings-store.js";

const groupPeople = sql`with recursive group_people(group_id, user_id) as (
  select g.id, u.id from access_groups g join access_group_members e on e.group_id = g.id and e.member_kind = 'user'
    join users u on u.id = e.member_id where g.deleted_at is null and u.admitted_at is not null and u.member_state = 'active'
  union select g.id, u.id from access_groups g cross join users u where g.builtin = 'everyone' and g.deleted_at is null
    and u.member_kind = 'full' and u.member_state = 'active' and u.admitted_at is not null
  union select e.group_id, p.user_id from access_group_members e join group_people p on e.member_kind = 'group' and e.member_id = p.group_id::text
    join access_groups g on g.id = e.group_id where g.deleted_at is null
)`;

const cursorSchema = z.strictObject({ scope: z.string(), sort: z.string(), id: z.string() });
type Position = z.infer<typeof cursorSchema>;
type MemberRow = Omit<MemberSummary, "can">;
type EntryRow = Omit<EntryView, "can">;
type ReadContext = {
  database: Kysely<DatabaseSchema>;
  user: Awaited<ReturnType<typeof requireTeamHuman>>;
  accessRevision: number;
};

export class TeamAccessReadStore {
  readonly #cursorKey = randomBytes(32);
  readonly database: Kysely<DatabaseSchema>;
  constructor(database: Kysely<DatabaseSchema>) {
    this.database = database;
  }

  async #snapshot<Result>(
    actor: AuthenticatedHuman,
    administrator: boolean,
    read: (context: ReadContext) => Promise<Result>,
  ): Promise<Result> {
    return this.database
      .transaction()
      .setIsolationLevel("repeatable read")
      .setAccessMode("read only")
      .execute(async (database) => {
        const user = await requireTeamHuman(database, actor, administrator);
        const state = await database
          .selectFrom("accessState")
          .select("revision")
          .where("singletonKey", "=", "primary")
          .executeTakeFirstOrThrow();
        return read({ database, user, accessRevision: safeGeneration(state.revision) });
      });
  }

  #scope(actor: AuthenticatedHuman, query: unknown): string {
    return createHmac("sha256", this.#cursorKey)
      .update(JSON.stringify([actor.userId, actor.authorityGeneration, query]))
      .digest("base64url");
  }

  #position(cursor: string | undefined, scope: string): Position {
    if (!cursor) return { scope, sort: "", id: "" };
    try {
      const [body, signature] = cursor.split(".");
      if (!body || !signature) throw new Error("Invalid cursor");
      const expected = createHmac("sha256", this.#cursorKey).update(body).digest("base64url");
      if (
        signature.length !== expected.length ||
        !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
      )
        throw new Error("Invalid cursor");
      const position = cursorSchema.parse(
        JSON.parse(Buffer.from(body, "base64url").toString("utf8")),
      );
      if (position.scope !== scope) throw new Error("Invalid cursor scope");
      return position;
    } catch {
      teamRefusal("invalid-selection", "bad_request");
    }
  }

  #page<Item>(
    rows: readonly Item[],
    limit: number,
    scope: string,
    position: (item: Item) => { sort: string; id: string },
  ): PageResult<Item> {
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    if (rows.length <= limit || !last) return { items, nextCursor: null };
    const body = Buffer.from(JSON.stringify({ scope, ...position(last) })).toString("base64url");
    return {
      items,
      nextCursor: `${body}.${createHmac("sha256", this.#cursorKey).update(body).digest("base64url")}`,
    };
  }

  #namePage<Item extends { id: string; sortKey: string }>(
    rows: readonly Item[],
    limit: number,
    scope: string,
  ) {
    const page = this.#page(rows, limit, scope, (row) => ({ sort: row.sortKey, id: row.id }));
    return { ...page, items: page.items.map(({ sortKey: _sortKey, ...row }) => row) };
  }

  async #project(
    context: ReadContext,
    workspaceId: WorkspaceId,
    action: "use" | "manage",
    adminMetadata = false,
  ) {
    const decision = await checkAccess(context.database, {
      principal: { kind: "person", userId: context.user.id },
      callerKind: "person",
      target: { kind: "project", workspaceId },
      action,
    });
    const admin = context.user.instanceRole === "administrator";
    if (!decision.allowed && !(adminMetadata && admin))
      teamRefusal("team-object-unavailable", "not_found");
    const project = await context.database
      .selectFrom("workspaces")
      .select(["id", "name", "color"])
      .where("id", "=", workspaceId)
      .where("kind", "=", "project")
      .where("deletedAt", "is", null)
      .where("status", "not in", ["deleting", "deleted"])
      .executeTakeFirst();
    if (!project) teamRefusal("team-object-unavailable", "not_found");
    return project;
  }

  async #members(
    database: Kysely<DatabaseSchema>,
    condition: ReturnType<typeof sql>,
    limit: number,
  ): Promise<(MemberRow & { sortKey: string })[]> {
    const rows = await sql<Omit<MemberRow, "joinedAt"> & { joinedAt: Date; sortKey: string }>`
      ${groupPeople}
      select u.id, u.display_name as name, lower(u.display_name collate "C") collate "C" as sort_key, u.email, u.member_kind as kind, u.member_state as state,
        (u.instance_role = 'administrator') as administrator, u.admitted_at as joined_at,
        coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'builtin', g.builtin) order by lower(g.name), g.id)
          from (select g.* from access_groups g join group_people gp on gp.group_id = g.id where gp.user_id = u.id order by lower(g.name), g.id limit 5) g), '[]'::jsonb) as groups_preview,
        (select count(*)::int from group_people gp where gp.user_id = u.id) as group_count,
        (select jsonb_build_object('id', inviter.id, 'name', inviter.display_name) from team_invitations i join users inviter on inviter.id = i.created_by
          where i.accepted_by = u.id order by i.accepted_at desc, i.id desc limit 1) as invited_by
      from users u where u.admitted_at is not null and ${condition} order by sort_key, u.id collate "C" limit ${limit}`.execute(
      database,
    );
    return rows.rows.map((row) => ({ ...row, joinedAt: row.joinedAt.toISOString() }));
  }

  people(
    actor: AuthenticatedHuman,
    input: Page & {
      query?: string | undefined;
      state?: "active" | "suspended" | "removed" | undefined;
    },
  ) {
    return this.#snapshot(actor, true, async ({ database, accessRevision }) => {
      const limit = input.limit ?? 30;
      const scope = this.#scope(actor, ["people", input.query, input.state]);
      const position = this.#position(input.cursor, scope);
      const condition = sql`(lower(u.display_name collate "C") collate "C", u.id collate "C") > (${position.sort}, ${position.id})
        and (${input.query ?? ""} = '' or position(lower(${input.query ?? ""}) in lower(u.display_name)) > 0 or position(lower(${input.query ?? ""}) in u.email) > 0)
        and (${input.state ?? null}::text is null or u.member_state = ${input.state ?? null})`;
      return {
        ...this.#namePage(await this.#members(database, condition, limit + 1), limit, scope),
        accessRevision,
      };
    });
  }

  invitations(actor: AuthenticatedHuman, input: Page) {
    return this.#snapshot(actor, true, async ({ database, accessRevision }) => {
      const scope = this.#scope(actor, ["invitations"]);
      const position = this.#position(input.cursor, scope);
      const rows = await database
        .selectFrom("teamInvitations")
        .innerJoin("users", "users.id", "teamInvitations.createdBy")
        .select([
          "teamInvitations.id",
          "teamInvitations.intendedEmail",
          "teamInvitations.memberKind",
          "teamInvitations.createdBy",
          "users.displayName",
          "teamInvitations.createdAt",
          "teamInvitations.expiresAt",
          "teamInvitations.acceptedAt",
          "teamInvitations.revokedAt",
          sql<boolean>`team_invitations.expires_at > transaction_timestamp()`.as("valid"),
        ])
        .where(
          sql<boolean>`((team_invitations.revoked_at is null and team_invitations.accepted_at is null and team_invitations.expires_at > transaction_timestamp())
          or greatest(team_invitations.created_at, team_invitations.accepted_at, team_invitations.revoked_at) >= transaction_timestamp() - interval '30 days')`,
        )
        .where(
          sql<boolean>`(team_invitations.created_at, team_invitations.id::text) > (coalesce(nullif(${position.sort}, '')::timestamptz, '-infinity'::timestamptz), ${position.id})`,
        )
        .orderBy("teamInvitations.createdAt")
        .orderBy("teamInvitations.id")
        .limit((input.limit ?? 30) + 1)
        .execute();
      return {
        ...this.#page(
          rows.map((row) => ({
            id: row.id,
            emailMasked: `${row.intendedEmail.slice(0, 1)}***${row.intendedEmail.slice(row.intendedEmail.indexOf("@"))}`,
            memberKind: row.memberKind,
            createdBy: { id: row.createdBy, name: row.displayName },
            createdAt: row.createdAt.toISOString(),
            expiresAt: row.expiresAt.toISOString(),
            state: row.revokedAt
              ? ("revoked" as const)
              : row.acceptedAt
                ? ("used" as const)
                : row.valid
                  ? ("open" as const)
                  : ("expired" as const),
            can: {
              revoke:
                !row.revokedAt && !row.acceptedAt && row.valid
                  ? { allowed: true }
                  : { allowed: false, reason: "invite-unavailable" as const },
            },
          })),
          input.limit ?? 30,
          scope,
          (row) => ({ sort: row.createdAt, id: row.id }),
        ),
        accessRevision,
      };
    });
  }

  member(
    actor: AuthenticatedHuman,
    input: {
      userId: UserId;
      entryPage?: Page | undefined;
      connectionPage?: Page | undefined;
      groupPage?: Page | undefined;
    },
  ) {
    return this.#snapshot(actor, false, async (context) => {
      const { database, accessRevision } = context;
      if (context.user.instanceRole !== "administrator" && input.userId !== actor.userId)
        teamRefusal("team-admin-required");
      const memberRow = (await this.#members(database, sql`u.id = ${input.userId}`, 1))[0];
      if (!memberRow) teamRefusal("team-object-unavailable", "not_found");
      const { sortKey: _sortKey, ...member } = memberRow;
      const effective = await database
        .selectFrom("workspaceMemberships")
        .innerJoin("workspaces", "workspaces.id", "workspaceMemberships.workspaceId")
        .select(["workspaces.id", "workspaces.name", "workspaceMemberships.role"])
        .where("workspaceMemberships.userId", "=", input.userId)
        .where("workspaceMemberships.state", "=", "active")
        .where("workspaces.kind", "=", "project")
        .where("workspaces.deletedAt", "is", null)
        .where("workspaces.status", "not in", ["deleting", "deleted"])
        .orderBy("workspaces.id")
        .limit(128)
        .execute();
      const groupPage = input.groupPage ?? {};
      const groupScope = this.#scope(actor, ["member-groups", input.userId]);
      const groupPosition = this.#position(groupPage.cursor, groupScope);
      const groups = (
        await sql<
          GroupRef & { sortKey: string }
        >`${groupPeople} select g.id, g.name, g.builtin, lower(g.name collate "C") collate "C" as sort_key from access_groups g join group_people gp on gp.group_id = g.id
        where gp.user_id = ${input.userId} and (lower(g.name collate "C") collate "C", g.id::text collate "C") > (${groupPosition.sort}, ${groupPosition.id}) order by sort_key, g.id::text collate "C" limit ${(groupPage.limit ?? 30) + 1}`.execute(
          database,
        )
      ).rows;
      const connectionPage = input.connectionPage ?? {};
      const connectionScope = this.#scope(actor, ["member-connections", input.userId]);
      const connectionPosition = this.#position(connectionPage.cursor, connectionScope);
      const connections = await database
        .selectFrom("agentConnections")
        .select([
          "id",
          "label",
          "createdAt",
          "lastUsedAt",
          "revokedAt",
          sql<string>`lower(label collate "C") collate "C"`.as("sortKey"),
        ])
        .where("userId", "=", input.userId)
        .where(
          sql<boolean>`(lower(label collate "C") collate "C", id collate "C") > (${connectionPosition.sort}, ${connectionPosition.id})`,
        )
        .orderBy("sortKey")
        .orderBy(sql`id collate "C"`)
        .limit((connectionPage.limit ?? 30) + 1)
        .execute();
      return {
        ...member,
        accessRevision,
        effectiveProjects: effective.map((row) => ({
          id: row.id,
          name: row.name,
          level: row.role === "owner" ? ("manage" as const) : ("use" as const),
        })),
        directEntries: await this.#entries(
          context,
          actor,
          input.entryPage ?? {},
          sql`e.subject_kind = 'user' and e.subject_id = ${input.userId}`,
          ["member", input.userId],
        ),
        groups: this.#namePage(groups, groupPage.limit ?? 30, groupScope),
        connections: this.#namePage(connections, connectionPage.limit ?? 30, connectionScope),
      };
    });
  }

  directory(
    actor: AuthenticatedHuman,
    input: { workspaceId: WorkspaceId; query: string; limit?: number | undefined },
  ) {
    return this.#snapshot(actor, false, async (context) => {
      await this.#project(context, input.workspaceId, "manage", true);
      const limit = input.limit ?? 30;
      const people = await context.database
        .selectFrom("users")
        .select(["id", "displayName as name"])
        .where("admittedAt", "is not", null)
        .where("memberState", "=", "active")
        .where(sql<boolean>`position(lower(${input.query}) in lower(display_name)) > 0`)
        .orderBy(sql`lower(display_name)`)
        .orderBy("id")
        .limit(limit)
        .execute();
      const groups = await context.database
        .selectFrom("accessGroups")
        .select(["id", "name", "builtin"])
        .where("deletedAt", "is", null)
        .where(sql<boolean>`position(lower(${input.query}) in lower(name)) > 0`)
        .orderBy(sql`lower(name)`)
        .orderBy("id")
        .limit(limit)
        .execute();
      return { people, groups, accessRevision: context.accessRevision };
    });
  }

  groups(
    actor: AuthenticatedHuman,
    input: Page & { query?: string | undefined; groupId?: string | undefined },
  ) {
    return this.#snapshot(actor, true, async (context) => {
      const scope = this.#scope(actor, ["groups", input.query, input.groupId]);
      const position = this.#position(input.groupId ? undefined : input.cursor, scope);
      const limit = input.groupId ? 1 : (input.limit ?? 30);
      const rows = (
        await sql<
          GroupRef & {
            directCount: number;
            effectivePeopleCount: number;
            parentCount: number;
            sortKey: string;
          }
        >`
        ${groupPeople} select g.id, g.name, g.builtin, lower(g.name collate "C") collate "C" as sort_key,
          (case when g.builtin = 'everyone' then (select count(*) from group_people gp where gp.group_id = g.id) else (select count(*) from access_group_members e where e.group_id = g.id) end)::int as direct_count,
          (select count(*)::int from group_people gp where gp.group_id = g.id) as effective_people_count,
          (select count(*)::int from access_group_members e where e.member_kind = 'group' and e.member_id = g.id::text) as parent_count
        from access_groups g where g.deleted_at is null and (${input.groupId ?? null}::uuid is null or g.id = ${input.groupId ?? null}::uuid)
          and (lower(g.name collate "C") collate "C", g.id::text collate "C") > (${position.sort}, ${position.id}) and position(lower(${input.query ?? ""}) in lower(g.name)) > 0
        order by sort_key, g.id::text collate "C" limit ${limit + 1}`.execute(context.database)
      ).rows;
      if (!input.groupId)
        return {
          ...this.#namePage(rows, limit, scope),
          accessRevision: context.accessRevision,
        };
      const groupRow = rows[0];
      if (!groupRow) teamRefusal("team-object-unavailable", "not_found");
      const { sortKey: _sortKey, ...group } = groupRow;
      const memberScope = this.#scope(actor, ["group-members", group.id]);
      const memberPosition = this.#position(input.cursor, memberScope);
      const members = (
        await sql<{
          kind: "person" | "group";
          userId?: UserId;
          groupId?: string;
          name: string;
          memberKind: "full" | "guest";
          id: string;
          sortKey: string;
        }>`
        select *, lower(name collate "C") collate "C" as sort_key from (
          select 'person' as kind, u.id as user_id, null::text as group_id, u.id, u.display_name as name, u.member_kind from users u where
            (${group.builtin === "everyone"} and u.admitted_at is not null and u.member_state = 'active' and u.member_kind = 'full')
            or exists(select 1 from access_group_members e where e.group_id = ${group.id}::uuid and e.member_kind = 'user' and e.member_id = u.id)
          union all select 'group', null, g.id::text, g.id::text, g.name, null::text from access_group_members e join access_groups g on e.member_kind = 'group' and e.member_id = g.id::text
            where e.group_id = ${group.id}::uuid and g.deleted_at is null
        ) member where (lower(name collate "C") collate "C", id collate "C") > (${memberPosition.sort}, ${memberPosition.id}) order by sort_key, id collate "C" limit ${(input.limit ?? 30) + 1}`.execute(
          context.database,
        )
      ).rows;
      const parents = await context.database
        .selectFrom("accessGroupMembers")
        .innerJoin("accessGroups", "accessGroups.id", "accessGroupMembers.groupId")
        .select(["accessGroups.id", "accessGroups.name", "accessGroups.builtin"])
        .where("memberKind", "=", "group")
        .where("memberId", "=", group.id)
        .where("accessGroups.deletedAt", "is", null)
        .orderBy("accessGroups.id")
        .limit(512)
        .execute();
      return {
        ...group,
        directMembers: this.#namePage(members, input.limit ?? 30, memberScope),
        parents,
        accessRevision: context.accessRevision,
      };
    });
  }

  async #entries(
    context: ReadContext,
    actor: AuthenticatedHuman,
    page: Page,
    condition: ReturnType<typeof sql>,
    query: unknown,
  ): Promise<PageResult<EntryRow>> {
    const scope = this.#scope(actor, ["entries", query]);
    const position = this.#position(page.cursor, scope);
    const rows = (
      await sql<EntryRow & { grantedAt: Date; revokedAt: Date | null }>`select e.id,
      case when e.subject_kind = 'user' then jsonb_build_object('kind', 'person', 'userId', subject.id, 'name', subject.display_name, 'memberKind', subject.member_kind)
        else jsonb_build_object('kind', 'group', 'groupId', g.id, 'name', g.name) end as subject,
      jsonb_build_object('kind', 'project', 'workspaceId', e.target_id, 'name', w.name) as target, e.level,
      jsonb_build_object('id', granter.id, 'name', granter.display_name) as granted_by, e.granted_at, e.revoked_at
      from access_entries e left join users subject on e.subject_kind = 'user' and subject.id = e.subject_id
      left join access_groups g on e.subject_kind = 'group' and g.id::text = e.subject_id join users granter on granter.id = e.granted_by
      join workspaces w on e.target_kind = 'project' and w.id = e.target_id and w.deleted_at is null and w.status not in ('deleting', 'deleted')
      where ${condition} and e.id::text > ${position.id} order by e.id limit ${(page.limit ?? 30) + 1}`.execute(
        context.database,
      )
    ).rows;
    return this.#page(
      rows.map((row) => ({
        ...row,
        grantedAt: row.grantedAt.toISOString(),
        revokedAt: row.revokedAt?.toISOString() ?? null,
      })),
      page.limit ?? 30,
      scope,
      (entry) => ({ sort: "", id: entry.id }),
    );
  }

  project(
    actor: AuthenticatedHuman,
    input: Page & { workspaceId: WorkspaceId },
    runnerIsConnected: (runnerId: RunnerId) => boolean,
  ) {
    return this.#snapshot(actor, false, async (context) => {
      const project = await this.#project(context, input.workspaceId, "use", true);
      const members = await context.database
        .selectFrom("workspaceMemberships")
        .innerJoin("users", "users.id", "workspaceMemberships.userId")
        .select([
          "users.id",
          "users.displayName as name",
          "users.memberKind as kind",
          "workspaceMemberships.role",
        ])
        .where("workspaceMemberships.workspaceId", "=", project.id)
        .where("workspaceMemberships.state", "=", "active")
        .where("users.memberState", "=", "active")
        .where("users.admittedAt", "is not", null)
        .orderBy(sql`lower(users.display_name)`)
        .orderBy("users.id")
        .limit(1024)
        .execute();
      const mine = members.find((member) => member.id === context.user.id);
      const canEdit = mine?.role === "owner" || context.user.instanceRole === "administrator";
      const groups = (
        await sql<{ id: string; name: string; count: number }>`
        ${groupPeople} select g.id, g.name, count(distinct gp.user_id)::int as count from access_entries e join access_groups g on e.subject_kind = 'group' and e.subject_id = g.id::text
        left join group_people gp on gp.group_id = g.id where e.target_kind = 'project' and e.target_id = ${project.id} and e.revoked_at is null and g.deleted_at is null group by g.id order by g.id limit 512`.execute(
          context.database,
        )
      ).rows;
      const runtime = await resolveProjectRuntime(context.database, project.id, runnerIsConnected);
      return {
        project,
        runtime: runtime.state === "ready" ? { state: "ready" as const } : runtime,
        accessRevision: context.accessRevision,
        audience: {
          people: members.length,
          preview: members.slice(0, 5).map(({ id, name, kind }) => ({ id, name, kind })),
          groups,
          myLevel: mine ? (mine.role === "owner" ? ("manage" as const) : ("use" as const)) : null,
          managerCount: members.filter((member) => member.role === "owner").length,
        },
        managerNames: members
          .filter((member) => member.role === "owner")
          .map(({ id, name, kind }) => ({ id, name, kind })),
        iAmAdminNotMember: context.user.instanceRole === "administrator" && !mine,
        entries: canEdit
          ? await this.#entries(
              context,
              actor,
              input,
              sql`e.target_id = ${project.id} and e.revoked_at is null`,
              ["project", project.id],
            )
          : null,
      };
    });
  }

  summary(actor: AuthenticatedHuman, teamName: string, knownRevision?: string) {
    return this.#snapshot(actor, false, async (context) => {
      const deployment = await context.database
        .selectFrom("deployments")
        .select("id")
        .where("singletonKey", "=", "primary")
        .executeTakeFirstOrThrow();
      const projects = (
        await sql<{
          id: WorkspaceId;
          name: string;
          color: import("@opensteer/core").MarkColor;
          level: Level;
          unread: boolean;
          needsYou: number;
          lastActivity: Date | null;
        }>`
        select w.id, w.name, w.color, case when m.role = 'owner' then 'manage' else 'use' end as level,
          exists(select 1 from threads t left join thread_read_markers marker on marker.thread_id = t.id and marker.user_id = ${actor.userId}
            join messages message on message.thread_id = t.id and message.sequence > coalesce(marker.sequence, 0)
            where t.workspace_id = w.id and t.listed and ${conversationUnreadPredicate("message")}) as unread,
          (select count(*)::int from requests r where r.target_workspace_id = w.id and r.requested_by = ${actor.userId} and r.status = 'pending') as needs_you,
          (select max(t.updated_at) from threads t where t.workspace_id = w.id and t.listed) as last_activity
        from workspace_memberships m join workspaces w on w.id = m.workspace_id where m.user_id = ${actor.userId} and m.state = 'active'
          and w.kind = 'project' and w.deleted_at is null and w.status not in ('deleting', 'deleted') order by lower(w.name), w.id limit 128`.execute(
          context.database,
        )
      ).rows;
      const data = {
        accessRevision: context.accessRevision,
        team: { id: deployment.id, name: teamName },
        me: {
          id: context.user.id,
          kind: context.user.memberKind,
          state: context.user.memberState,
          administrator: context.user.instanceRole === "administrator",
        },
        projects: projects.map((project) => ({
          ...project,
          lastActivity: project.lastActivity?.toISOString() ?? null,
        })),
        needsYou: projects.reduce((total, project) => total + project.needsYou, 0),
      };
      const revision = this.#scope(actor, data);
      return knownRevision === revision
        ? { notModified: true as const, revision }
        : { ...data, revision };
    });
  }

  audit(
    actor: AuthenticatedHuman,
    input: Page & {
      actorId?: UserId | undefined;
      target?: { workspaceId: WorkspaceId } | undefined;
      action?: string | undefined;
    },
  ) {
    return this.#snapshot(actor, true, async ({ database }) => {
      const scope = this.#scope(actor, ["audit", input.actorId, input.target, input.action]);
      const position = this.#position(input.cursor, scope);
      let query = database
        .selectFrom("securityAudit")
        .leftJoin("users", "users.id", "securityAudit.actorUserId")
        .select([
          "securityAudit.id",
          "securityAudit.createdAt",
          "securityAudit.action",
          "securityAudit.actorUserId",
          "users.displayName",
          "securityAudit.targetId",
          "securityAudit.targetType",
          "securityAudit.metadata",
          sql<unknown>`coalesce(security_audit.metadata -> 'target', case security_audit.target_type
            when 'project' then (select jsonb_build_object('kind', 'project', 'id', w.id, 'name', left(w.name, 120)) from workspaces w where w.id = security_audit.target_id)
            when 'member' then (select jsonb_build_object('kind', 'member', 'id', u.id, 'name', left(u.display_name, 120)) from users u where u.id = security_audit.target_id)
            when 'group' then (select jsonb_build_object('kind', 'group', 'id', g.id, 'name', g.name) from access_groups g where g.id::text = security_audit.target_id)
            when 'connection' then (select jsonb_build_object('kind', 'connection', 'id', c.id, 'name', c.label) from agent_connections c where c.id = security_audit.target_id)
            when 'invitation' then jsonb_build_object('kind', 'invitation', 'id', security_audit.target_id, 'name', 'Invitation')
          end)`.as("target"),
        ])
        .where((expression) =>
          expression.or([
            expression("action", "=", "access.mutated"),
            expression("action", "like", "team.%"),
            expression("action", "=", "project-runtime-settings.updated"),
          ]),
        )
        .where(
          sql<boolean>`(security_audit.created_at, security_audit.id) > (coalesce(nullif(${position.sort}, '')::timestamptz, '-infinity'::timestamptz), ${position.id})`,
        );
      if (input.actorId) query = query.where("securityAudit.actorUserId", "=", input.actorId);
      if (input.action) query = query.where("action", "=", input.action);
      if (input.target)
        query = query.where(
          sql<boolean>`(security_audit.workspace_id = ${input.target.workspaceId} or coalesce(security_audit.metadata -> 'projectIds', '[]'::jsonb) @> ${JSON.stringify([input.target.workspaceId])}::jsonb)`,
        );
      const rows = await query
        .orderBy("securityAudit.createdAt")
        .orderBy("securityAudit.id")
        .limit((input.limit ?? 30) + 1)
        .execute();
      return this.#page(
        rows.map((row) => {
          const parsed = z.array(SafeChangeSummarySchema).max(100).safeParse(row.metadata.changes);
          const target = AuditItemSchema.shape.target.safeParse(row.target);
          return {
            id: row.id,
            at: row.createdAt.toISOString(),
            action: row.action,
            actor:
              row.actorUserId && row.displayName
                ? { id: row.actorUserId, name: row.displayName }
                : null,
            target: target.success ? target.data : null,
            changes: parsed.success ? parsed.data : [],
          };
        }),
        input.limit ?? 30,
        scope,
        (row) => ({ sort: row.at, id: row.id }),
      );
    });
  }

  async authority(actor: AuthenticatedHuman) {
    return this.#snapshot(actor, false, async ({ user, accessRevision, database }) => ({
      user,
      accessRevision,
      activeAdmins: Number(
        (
          await database
            .selectFrom("users")
            .select(sql<string>`count(*)`.as("count"))
            .where("instanceRole", "=", "administrator")
            .where("memberState", "=", "active")
            .where("admittedAt", "is not", null)
            .executeTakeFirstOrThrow()
        ).count,
      ),
    }));
  }

  async memberMetadata(userId: UserId) {
    await requireTeamAuthority(this.database);
    const memberRow = (await this.#members(this.database, sql`u.id = ${userId}`, 1))[0];
    if (!memberRow) teamRefusal("team-object-unavailable", "not_found");
    const { sortKey: _sortKey, ...member } = memberRow;
    return member;
  }

  explain(
    actor: AuthenticatedHuman,
    input: { workspaceId: WorkspaceId; subject: Subject; cursor?: string | undefined },
  ) {
    return this.#snapshot(actor, false, async (context) => {
      await this.#project(context, input.workspaceId, "use", true);
      const manager = (
        await checkAccess(context.database, {
          principal: { kind: "person", userId: actor.userId },
          callerKind: "person",
          target: { kind: "project", workspaceId: input.workspaceId },
          action: "manage",
        })
      ).allowed;
      if (
        !manager &&
        context.user.instanceRole !== "administrator" &&
        !(input.subject.kind === "person" && input.subject.userId === actor.userId)
      )
        teamRefusal("team-object-unavailable", "not_found");
      const scope = this.#scope(actor, [
        "explain",
        input.workspaceId,
        input.subject,
        context.accessRevision,
      ]);
      const position = this.#position(input.cursor, scope);
      const relevant = sql`${groupPeople}, subject_groups(id) as (
        select g.id from access_groups g where g.deleted_at is null and (
          ${input.subject.kind === "group"} and g.id::text = ${input.subject.kind === "group" ? input.subject.groupId : ""}
          or ${input.subject.kind === "person"} and exists(select 1 from group_people gp where gp.group_id = g.id and gp.user_id = ${input.subject.kind === "person" ? input.subject.userId : ""})
        ) union select e.group_id from access_group_members e join subject_groups child on e.member_kind = 'group' and e.member_id = child.id::text
      ), grant_groups(id) as (
        select g.id from subject_groups g join access_entries e on e.subject_kind = 'group' and e.subject_id = g.id::text
          where e.target_kind = 'project' and e.target_id = ${input.workspaceId} and e.revoked_at is null
        union select child.id from grant_groups parent join access_group_members e on e.group_id = parent.id and e.member_kind = 'group'
          join subject_groups child on child.id::text = e.member_id
      )`;
      const groups = (
        await sql<GroupRef>`${relevant} select g.id, g.name, g.builtin from access_groups g join grant_groups r on r.id = g.id order by g.id limit 512`.execute(
          context.database,
        )
      ).rows;
      const entries = await this.#entries(
        context,
        actor,
        { limit: 201 },
        sql`e.target_id = ${input.workspaceId} and e.revoked_at is null and e.id::text > ${position.id.startsWith("entry:") ? position.id.slice(6) : ""} and (
        e.subject_kind = 'user' and ${input.subject.kind === "person"} and e.subject_id = ${input.subject.kind === "person" ? input.subject.userId : ""}
        or e.subject_kind = 'group' and e.subject_id in (${groups.length ? sql.join(groups.map((group) => group.id)) : sql`null`})
      )`,
        ["explain-entries", input.workspaceId, input.subject],
      );
      const person =
        input.subject.kind === "person"
          ? await context.database
              .selectFrom("users")
              .select(["memberKind", "memberState", "admittedAt"])
              .where("id", "=", input.subject.userId)
              .executeTakeFirst()
          : undefined;
      const computedEdges =
        input.subject.kind === "person" && person && isEveryoneMember(person)
          ? groups
              .filter((group) => group.builtin === "everyone")
              .map((group) => ({
                groupId: group.id,
                member: input.subject,
                key: `edge:${group.id}:user:${input.subject.kind === "person" ? input.subject.userId : ""}`,
              }))
              .filter((edge) => edge.key > position.id)
          : [];
      const edges = (
        await sql<{ groupId: string; member: Subject; key: string }>`
        ${relevant} select e.group_id, case when e.member_kind = 'user' then jsonb_build_object('kind', 'person', 'userId', e.member_id)
          else jsonb_build_object('kind', 'group', 'groupId', e.member_id) end as member,
          'edge:' || e.group_id::text || ':' || e.member_kind || ':' || e.member_id as key
        from access_group_members e join grant_groups parent on parent.id = e.group_id
        where ((e.member_kind = 'group' and e.member_id in (select id::text from grant_groups))
          or (e.member_kind = 'user' and ${input.subject.kind === "person"} and e.member_id = ${input.subject.kind === "person" ? input.subject.userId : ""}))
          and 'edge:' || e.group_id::text || ':' || e.member_kind || ':' || e.member_id > ${position.id}
        order by key limit 201`.execute(context.database)
      ).rows;
      const entryRows = entries.items
        .map((entry) => ({ key: `entry:${entry.id}`, entry }))
        .filter((row) => row.key > position.id);
      const all = [
        ...computedEdges.map((edge) => ({ key: edge.key, edge })),
        ...edges.map((edge) => ({ key: edge.key, edge })),
        ...entryRows,
      ].sort((first, second) => first.key.localeCompare(second.key));
      const page = this.#page(all, 200, scope, (row) => ({ sort: "", id: row.key }));
      let effectiveLevel: Level | null = null;
      if (input.subject.kind === "person") {
        const membership = await context.database
          .selectFrom("workspaceMemberships")
          .select("role")
          .where("workspaceId", "=", input.workspaceId)
          .where("userId", "=", input.subject.userId)
          .where("state", "=", "active")
          .executeTakeFirst();
        effectiveLevel = membership ? (membership.role === "owner" ? "manage" : "use") : null;
      } else {
        const levels = (
          await sql<{
            manage: boolean | null;
            present: boolean;
          }>`select bool_or(level = 'manage') as manage, count(*) > 0 as present from access_entries
          where target_kind = 'project' and target_id = ${input.workspaceId} and revoked_at is null and subject_kind = 'group'
          and subject_id in (${groups.length ? sql.join(groups.map((group) => group.id)) : sql`null`})`.execute(
            context.database,
          )
        ).rows[0]!;
        effectiveLevel = levels.manage ? "manage" : levels.present ? "use" : null;
      }
      return {
        accessRevision: context.accessRevision,
        subject: input.subject,
        target: { kind: "project" as const, workspaceId: input.workspaceId },
        effectiveLevel,
        entries: page.items.flatMap((row) => ("entry" in row ? [row.entry] : [])),
        groups,
        edges: page.items.flatMap((row) =>
          "edge" in row ? [{ groupId: row.edge.groupId, member: row.edge.member }] : [],
        ),
        truncated: page.nextCursor !== null,
        nextCursor: page.nextCursor,
      };
    });
  }

  memberImpact(actor: AuthenticatedHuman, userId: UserId) {
    return this.#snapshot(actor, true, async ({ database, accessRevision }) => {
      const user = await database
        .selectFrom("users")
        .select(["instanceRole", "memberState", "admittedAt"])
        .where("id", "=", userId)
        .where("admittedAt", "is not", null)
        .executeTakeFirst();
      if (!user) teamRefusal("team-object-unavailable", "not_found");
      const counts = (
        await sql<{
          sessions: number;
          connections: number;
          pendingInputs: number;
          activeRuns: number;
          pendingRequests: number;
          activeAdmins: number;
        }>`select
        (select count(*)::int from auth_sessions where user_id = ${userId} and expires_at > now() and absolute_expires_at > now()) as sessions,
        (select count(*)::int from agent_connections where user_id = ${userId} and revoked_at is null and expires_at > now()) as connections,
        (select count(*)::int from thread_inputs where requested_by = ${userId} and state = 'pending') as pending_inputs,
        (select count(*)::int from runs where requested_by = ${userId} and status in ('queued', 'starting', 'running', 'waiting')) as active_runs,
        (select count(*)::int from requests where requested_by = ${userId} and status = 'pending') as pending_requests,
        (select count(*)::int from users where instance_role = 'administrator' and member_state = 'active' and admitted_at is not null) as active_admins`.execute(
          database,
        )
      ).rows[0]!;
      const { activeAdmins, ...impact } = counts;
      return {
        accessRevision,
        counts: impact,
        isLastAdmin:
          activeAdmins === 1 &&
          user.instanceRole === "administrator" &&
          user.memberState === "active",
      };
    });
  }
}
