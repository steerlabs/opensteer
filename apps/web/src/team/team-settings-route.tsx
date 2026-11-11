import { useState } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import {
  createId,
  TeamGroupIdSchema,
  TeamInviteIdSchema,
  UserIdSchema,
  type TeamChannelId,
} from "@opensteer/core";
import type { TeamAuditSchema, TeamChannelSummarySchema } from "@opensteer/protocol";
import { unwrapRpcResult } from "@opensteer/client/host";
import { usePagedList } from "@opensteer/client/react";
import type { z } from "zod";
import { Dialog } from "../components/dialog.js";
import {
  SectionHeader,
  SettingsGroup,
  SettingsRow,
  SettingsSegmented,
} from "../components/settings/primitives.js";
import {
  GroupsAdmin,
  InvitesAdmin,
  PeopleAdmin,
  type TeamRole,
} from "../components/team/team-admin.js";
import { PeopleOnlyBadge } from "../components/team/team-marks.js";
import { useToast } from "../components/toast.js";
import { actionErrorMessage } from "../ui-utils.js";
import { useTeams } from "./team-attachments.js";
import { teamTile } from "./team-people.js";
import { channelPath } from "./team-paths.js";
import { useTeamRead, useTeamView, type TeamView } from "./team-view.js";
import { person } from "./team-view-models.js";

const noPreviews: ReadonlyMap<string, string> = new Map();
const adminPages = ["people", "groups", "invites", "channels", "audit"] as const;

/** Settings → a team: everyone's profile and notifications; admins' people, groups, invites, channels and audit log. */
export function TeamSettingsRoute() {
  const { teamId = "", page = "profile" } = useParams();
  const view = useTeamView(teamId, noPreviews);
  if (!view) return <p className="team-empty">You aren’t in this team on this computer.</p>;
  const can = view.snapshot.bootstrap?.can;
  const admin = !!can && (can.manageMembers || can.manageGroups || can.manageInvites || can.viewAudit);
  const name = view.snapshot.bootstrap?.teamName ?? view.team.name;
  const nav = (
    <nav aria-label={`${name} settings`} className="team-settings-nav">
      {(["profile", "notifications", ...(admin ? adminPages : [])] as const).map((key) => (
        <Link
          aria-current={key === page ? "page" : undefined}
          className={key === page ? "chip chip--active" : "chip"}
          key={key}
          to={`/settings/teams/${encodeURIComponent(teamId)}/${key}`}
        >
          {key[0]!.toUpperCase() + key.slice(1)}
        </Link>
      ))}
      <Link className="chip" to={`/teams/${encodeURIComponent(teamId)}/knowledge`}>
        Knowledge
      </Link>
    </nav>
  );
  const body =
    page === "people" && can?.manageMembers ? (
      <PeoplePage view={view} />
    ) : page === "groups" && can?.manageGroups ? (
      <GroupsPage view={view} />
    ) : page === "invites" && can?.manageInvites ? (
      <InvitesPage view={view} />
    ) : page === "channels" && admin ? (
      <ChannelsPage view={view} />
    ) : page === "audit" && can?.viewAudit ? (
      <AuditPage view={view} />
    ) : page === "notifications" ? (
      <NotificationsPage view={view} />
    ) : page === "knowledge" ? (
      <Navigate replace to={`/teams/${encodeURIComponent(teamId)}/knowledge`} />
    ) : (
      <ProfilePage view={view} />
    );
  return (
    <div className="settings-page team-settings">
      <SectionHeader title={name} />
      {nav}
      {body}
    </div>
  );
}

function useReport() {
  const toast = useToast();
  return (error: unknown) => toast.error(actionErrorMessage(error));
}

function ProfilePage({ view }: { readonly view: TeamView }) {
  const { leave } = useTeams();
  const navigate = useNavigate();
  const report = useReport();
  const me = view.me;
  if (!me) return null;
  return (
    <SettingsGroup heading="Your profile" headingId="team-profile">
      <SettingsRow
        detail={`@${me.handle} · your agent is @${me.handle}-agent`}
        icon="user"
        title={me.displayName}
      />
      <SettingsRow detail="Admins can see what agents read, searched and posted here." icon="shield" title="Agent activity is logged" />
      {view.team.link ? (
        <SettingsRow
          action={
            <button
              className="btn btn--danger btn--small"
              onClick={() =>
                void leave(view.team.teamId)
                  .then(() => void navigate("/"))
                  .catch(report)
              }
              type="button"
            >
              Leave
            </button>
          }
          detail="Tasks your agent did for this team stay on your computer."
          icon="log-out"
          title={`Leave ${view.team.name}`}
        />
      ) : null}
    </SettingsGroup>
  );
}

const notifyOptions = [
  { value: "all", label: "Everything" },
  { value: "mentions", label: "Mentions" },
  { value: "muted", label: "Nothing" },
] as const;

function NotificationsPage({ view }: { readonly view: TeamView }) {
  const report = useReport();
  return (
    <SettingsGroup heading="Notify me about" headingId="team-notify">
      {(view.snapshot.sidebar?.channels ?? []).map((row) => (
        <SettingsRow
          action={
            <SettingsSegmented
              label={`Notifications for ${row.channel.name}`}
              onChange={(notificationLevel) =>
                void view.client.rpc["commands.dispatch"]({
                  type: "team.channel.preferences.set",
                  channelId: row.channel.id,
                  notificationLevel,
                })
                  .then(unwrapRpcResult)
                  .catch(report)
              }
              options={notifyOptions}
              value={row.notificationLevel}
            />
          }
          icon={row.channel.kind === "dm" || row.channel.kind === "group_dm" ? "message" : "hash"}
          key={row.channel.id}
          title={row.channel.name}
        />
      ))}
    </SettingsGroup>
  );
}

function PeoplePage({ view }: { readonly view: TeamView }) {
  const navigate = useNavigate();
  const report = useReport();
  const dispatch = (command: Parameters<(typeof view.client.rpc)["commands.dispatch"]>[0]) =>
    void view.client.rpc["commands.dispatch"](command).then(unwrapRpcResult).catch(report);
  return (
    <PeopleAdmin
      actions={{
        onInvite: () => void navigate(`/settings/teams/${view.team.teamId}/invites`),
        onSetRole: (personId, role: TeamRole) => {
          if (role !== "owner")
            dispatch({ type: "team.member.role.set", userId: UserIdSchema.parse(personId), role });
        },
        onAddToGroup: () => void navigate(`/settings/teams/${view.team.teamId}/groups`),
        onDeactivate: (personId) =>
          dispatch({ type: "team.member.remove", userId: UserIdSchema.parse(personId) }),
        onReactivate: () => void navigate(`/settings/teams/${view.team.teamId}/invites`),
      }}
      people={[...view.members.values()].map((member) => ({
        person: person(view.words, member.userId),
        email: null,
        role: member.role,
        groups: [],
        lastActiveAt: null,
        deactivated: member.state === "removed",
      }))}
      team={teamTile(view.team.teamId, view.team.name)}
    />
  );
}

function GroupsPage({ view }: { readonly view: TeamView }) {
  const [params, setParams] = useSearchParams();
  const report = useReport();
  const groups = useTeamRead(
    () => view.client.rpc["team.groups.list"]({}).then(unwrapRpcResult),
    `groups:${view.team.teamId}`,
  );
  const [adding, setAdding] = useState<string | null>(null);
  const all = groups.value?.groups ?? [];
  const selected = all.find((group) => group.id === params.get("group")) ?? null;
  const run = (command: Parameters<(typeof view.client.rpc)["commands.dispatch"]>[0]) =>
    void view.client.rpc["commands.dispatch"](command)
      .then(unwrapRpcResult)
      .then(groups.reload)
      .catch(report);
  const name = (current = "") => window.prompt("Group name", current)?.trim() ?? "";
  return (
    <>
      <GroupsAdmin
        actions={{
          onSelect: (groupId) => setParams({ group: groupId }),
          onCreate: () => {
            const value = name();
            if (value)
              run({ type: "team.group.create", id: TeamGroupIdSchema.parse(createId("teamGroup")), name: value });
          },
          onRename: (groupId) => {
            const value = name(all.find((group) => group.id === groupId)?.name);
            if (value) run({ type: "team.group.rename", groupId: TeamGroupIdSchema.parse(groupId), name: value });
          },
          onDelete: (groupId) => run({ type: "team.group.delete", groupId: TeamGroupIdSchema.parse(groupId) }),
          onAddMembers: (groupId) => setAdding(groupId),
          onRemoveMember: (groupId, memberId) =>
            run(
              all.some((group) => group.id === memberId)
                ? {
                    type: "team.group.child.remove",
                    groupId: TeamGroupIdSchema.parse(groupId),
                    childGroupId: TeamGroupIdSchema.parse(memberId),
                  }
                : {
                    type: "team.group.person.remove",
                    groupId: TeamGroupIdSchema.parse(groupId),
                    userId: UserIdSchema.parse(memberId),
                  },
            ),
        }}
        groups={all.map((group) => ({ id: group.id, name: group.name, peopleCount: group.people.length }))}
        selected={
          selected
            ? {
                id: selected.id,
                name: selected.name,
                peopleCount: selected.people.length,
                parents: all.filter((group) => group.children.includes(selected.id)).map((group) => group.name),
                members: [
                  ...selected.people.map((userId) => ({ kind: "person" as const, person: person(view.words, userId) })),
                  ...selected.children.flatMap((childId) => {
                    const child = all.find((group) => group.id === childId);
                    return child
                      ? [{ kind: "group" as const, group: { id: child.id, name: child.name, peopleCount: child.people.length } }]
                      : [];
                  }),
                ],
                usedBy: [],
              }
            : null
        }
      />
      {adding ? (
        <Dialog labelledBy="group-add-title" onClose={() => setAdding(null)} title="Add to group">
          <ul className="team-browse__list">
            {[...view.members.values()].map((member) => (
              <li className="team-browse__row" key={member.userId}>
                <span className="team-browse__name">{member.displayName}</span>
                <button
                  className="btn btn--small"
                  onClick={() =>
                    run({
                      type: "team.group.person.add",
                      groupId: TeamGroupIdSchema.parse(adding),
                      userId: member.userId,
                    })
                  }
                  type="button"
                >
                  Add
                </button>
              </li>
            ))}
          </ul>
        </Dialog>
      ) : null}
    </>
  );
}

function InvitesPage({ view }: { readonly view: TeamView }) {
  const report = useReport();
  const toast = useToast();
  const invites = useTeamRead(
    () => view.client.rpc["team.invites.list"]({}).then(unwrapRpcResult),
    `invites:${view.team.teamId}`,
  );
  const [made, setMade] = useState<{ readonly url: string; readonly expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const active = (invites.value?.invites ?? []).filter(
    (invite) => invite.revokedAt === null && Date.parse(invite.expiresAt) > Date.now(),
  );
  const newLink = async () => {
    for (const invite of active)
      await view.client.rpc["commands.dispatch"]({ type: "team.invite.revoke", inviteId: invite.id }).then(unwrapRpcResult);
    const result = unwrapRpcResult(
      await view.client.rpc["commands.dispatch"]({
        type: "team.invite.create",
        id: TeamInviteIdSchema.parse(createId("teamInvite")),
        maxUses: 100,
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      }),
    );
    if (result.type === "team.invite.create") setMade({ url: result.url, expiresAt: result.invite.expiresAt });
    invites.reload();
  };
  return (
    <InvitesAdmin
      channels={(view.snapshot.sidebar?.channels ?? []).map((row) => ({ id: row.channel.id, name: row.channel.name }))}
      copied={copied}
      invite={{
        enabled: active.length > 0,
        url: made?.url ?? "",
        expiresAt: made?.expiresAt ?? active[0]?.expiresAt ?? new Date().toISOString(),
        uses: active[0]?.usedCount ?? 0,
        landingChannel: "",
      }}
      onCopy={() => {
        if (!made) {
          toast.error("Make a new link to copy it. Links are shown once.");
          return;
        }
        void navigator.clipboard.writeText(made.url).then(() => setCopied(true));
      }}
      onLanding={() => undefined}
      onNewLink={() => void newLink().catch(report)}
      onToggle={(enabled) => {
        if (enabled) void newLink().catch(report);
        else
          void Promise.all(
            active.map((invite) =>
              view.client.rpc["commands.dispatch"]({ type: "team.invite.revoke", inviteId: invite.id }),
            ),
          )
            .then(() => {
              setMade(null);
              invites.reload();
            })
            .catch(report);
      }}
    />
  );
}

type ChannelSummary = z.infer<typeof TeamChannelSummarySchema>;

/**
 * Every channel's name and access, for admins, without reading any of them.
 * Opening a restricted one asks first: adding yourself is logged and its
 * managers are told. Direct messages are never listed here.
 */
function ChannelsPage({ view }: { readonly view: TeamView }) {
  const navigate = useNavigate();
  const report = useReport();
  const list = useTeamRead(
    () => view.client.rpc["team.channels.list"]({}).then(unwrapRpcResult),
    `admin-channels:${view.team.teamId}:${view.snapshot.sidebar?.accessRevision ?? ""}`,
  );
  const [gate, setGate] = useState<ChannelSummary | null>(null);
  const addMe = async (channelId: TeamChannelId) => {
    const me = view.me;
    if (!me) return;
    const access = unwrapRpcResult(await view.client.rpc["team.channel.access.get"]({ channelId }));
    unwrapRpcResult(
      await view.client.rpc["commands.dispatch"]({
        type: "team.channel.access.set",
        channelId,
        expectedRevision: access.revision,
        access: [
          ...access.entries,
          { subject: { kind: "person", userId: me.userId }, level: "post", manage: false },
        ],
      }),
    );
    void navigate(channelPath(view.team.teamId, channelId));
  };
  const channels = (list.value?.channels ?? []).filter(
    (channel) => channel.kind === "public" || channel.kind === "private",
  );
  return (
    <>
      <SettingsGroup heading="Channels" headingId="team-channels">
        {channels.map((channel) => (
          <SettingsRow
            action={
              <span className="team-admin__actions">
                {channel.peopleOnly ? <PeopleOnlyBadge compact /> : null}
                <button
                  className="btn btn--small btn--ghost"
                  onClick={() =>
                    void navigate(`${channelPath(view.team.teamId, channel.id)}?members=1`)
                  }
                  type="button"
                >
                  Manage members
                </button>
                {channel.can.read ? (
                  <button
                    className="btn btn--small"
                    onClick={() => void navigate(channelPath(view.team.teamId, channel.id))}
                    type="button"
                  >
                    Open
                  </button>
                ) : (
                  <button className="btn btn--small" onClick={() => setGate(channel)} type="button">
                    Add me and open
                  </button>
                )}
              </span>
            }
            detail={channel.archivedAt ? "Archived" : channel.kind === "private" ? "Private" : "Public"}
            icon={channel.kind === "private" ? "lock" : "hash"}
            key={channel.id}
            title={channel.name}
          />
        ))}
      </SettingsGroup>
      {gate ? (
        <Dialog
          footer={
            <>
              <button className="btn btn--ghost" onClick={() => setGate(null)} type="button">
                Manage members only
              </button>
              <button
                className="btn btn--primary"
                onClick={() => {
                  const channel = gate;
                  setGate(null);
                  void addMe(channel.id).catch(report);
                }}
                type="button"
              >
                Add me and open
              </button>
            </>
          }
          labelledBy="add-yourself-title"
          onClose={() => setGate(null)}
          title={`Add yourself to #${gate.name}?`}
        >
          You can manage its members without joining. To read it, you have to be a member. This
          goes in the team’s audit log, and #{gate.name}’s managers are told.
        </Dialog>
      ) : null}
    </>
  );
}

type Audit = z.infer<typeof TeamAuditSchema>;

/** What admins and agents did, newest first. Never anyone's private transcript. */
function AuditPage({ view }: { readonly view: TeamView }) {
  const [only, setOnly] = useState<"all" | "admin" | "agents">("all");
  const list = usePagedList(
    (cursor) =>
      view.client.rpc["team.audit.page"](cursor ? { before: cursor as Audit["id"] } : {})
        .then(unwrapRpcResult)
        .then((page) => ({
          items: page.audit,
          nextCursor: page.hasMore ? (page.audit.at(-1)?.id ?? null) : null,
        })),
    `audit:${view.team.teamId}`,
  );
  const rows = list.items.filter((entry) =>
    only === "all" ? true : only === "agents" ? entry.actor?.kind === "agent" : entry.actor?.kind === "human",
  );
  return (
    <SettingsGroup
      heading="Audit log"
      headingId="team-audit"
      note={
        <SettingsSegmented
          label="Show"
          onChange={setOnly}
          options={[
            { value: "all", label: "Everything" },
            { value: "admin", label: "People" },
            { value: "agents", label: "Agents" },
          ]}
          value={only}
        />
      }
    >
      {rows.map((entry) => {
        const who = entry.actor
          ? entry.actor.kind === "agent"
            ? `${person(view.words, entry.actor.userId).name}’s agent`
            : person(view.words, entry.actor.userId).name
          : "Opensteer";
        return (
          <SettingsRow
            detail={`${new Date(entry.occurredAt).toLocaleString()} · ${entry.resourceKind}${entry.outcome === "denied" ? " · refused" : ""}`}
            icon={entry.actor?.kind === "agent" ? "sparkles" : "user"}
            key={entry.id}
            title={`${who} · ${entry.action}`}
          />
        );
      })}
      {list.nextCursor ? (
        <button className="sidebar__more" onClick={list.more} type="button">
          {list.loadingMore ? "Loading…" : "Show more"}
        </button>
      ) : null}
    </SettingsGroup>
  );
}
