import { useState } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import {
  createId,
  DeploymentIdSchema,
  TeamGroupIdSchema,
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
  PeopleAdmin,
  type TeamRole,
} from "../components/team/team-admin.js";
import { PeopleOnlyBadge } from "../components/team/team-marks.js";
import { useToast } from "../components/toast.js";
import { actionErrorMessage } from "../ui-utils.js";
import { useTeams } from "./team-attachments.js";
import { InvitePanel, useAgentLine, useConnectAgent, useTeamDialogs } from "./hosted-teams.js";
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
  const admin =
    !!can && (can.manageMembers || can.manageGroups || can.manageInvites || can.viewAudit);
  const name = view.snapshot.bootstrap?.teamName ?? view.team.name;
  const nav = (
    <nav aria-label={`${name} settings`} className="team-settings-nav">
      {(["profile", "notifications", ...(admin ? adminPages : [])] as const).map((key) => (
        <Link
          aria-current={key === page ? "page" : undefined}
          className="team-settings-nav__link"
          key={key}
          to={`/settings/teams/${encodeURIComponent(teamId)}/${key}`}
        >
          {key[0]!.toUpperCase() + key.slice(1)}
        </Link>
      ))}
      <Link
        className="team-settings-nav__link"
        to={`/teams/${encodeURIComponent(teamId)}/knowledge`}
      >
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
    <>
      <SectionHeader title={name} />
      {nav}
      {body}
    </>
  );
}

function useReport() {
  const toast = useToast();
  return (error: unknown) => toast.error(actionErrorMessage(error));
}

function ProfilePage({ view }: { readonly view: TeamView }) {
  const { coordination, leave } = useTeams();
  const { openDelete } = useTeamDialogs();
  const navigate = useNavigate();
  const report = useReport();
  const line = useAgentLine(view.team);
  const connect = useConnectAgent(view.team);
  const me = view.me;
  if (!me) return null;
  const name = view.snapshot.bootstrap?.teamName ?? view.team.name;
  const owner = view.snapshot.bootstrap?.member.role === "owner";
  const disconnect =
    coordination && line !== "none"
      ? () =>
          void coordination.coordinator
            .disconnectAgent(DeploymentIdSchema.parse(view.team.teamId))
            .catch(report)
      : null;
  return (
    <>
      <SettingsGroup heading="Your profile" headingId="team-profile">
        <SettingsRow
          detail={`@${me.handle} · your agent is @${me.handle}-agent`}
          title={me.displayName}
        />
        <SettingsRow
          action={
            line === "none" || line === "failed" ? (
              connect ? (
                <button className="btn btn--small" onClick={connect} type="button">
                  Connect
                </button>
              ) : null
            ) : disconnect ? (
              <button className="btn btn--small" onClick={disconnect} type="button">
                Disconnect
              </button>
            ) : null
          }
          detail={
            line === "connected"
              ? "Runs on your computer and only acts when you ask. Admins can see what agents read, searched and posted here."
              : line === "pending-offline"
                ? "It will connect when your computer is online."
                : line === "connecting"
                  ? "Connecting…"
                  : "Connect it to ask it in threads. Your messages post either way."
          }
          title={line === "connected" ? "Your agent is connected" : "Your agent isn’t connected"}
        />
      </SettingsGroup>
      <SettingsGroup heading="Leave or delete" headingId="team-leave">
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
          detail={
            owner
              ? "A team keeps at least one owner. Tasks your agent did for it stay on your computer."
              : "Tasks your agent did for this team stay on your computer."
          }
          title={`Leave ${name}`}
        />
        {owner && coordination ? (
          <SettingsRow
            action={
              <button
                className="btn btn--danger btn--small"
                onClick={() => openDelete(view.team.teamId)}
                type="button"
              >
                Delete
              </button>
            }
            detail="Deletes its channels, files and knowledge for everyone."
            title={`Delete ${name}`}
          />
        ) : null}
      </SettingsGroup>
    </>
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
              run({
                type: "team.group.create",
                id: TeamGroupIdSchema.parse(createId("teamGroup")),
                name: value,
              });
          },
          onRename: (groupId) => {
            const value = name(all.find((group) => group.id === groupId)?.name);
            if (value)
              run({
                type: "team.group.rename",
                groupId: TeamGroupIdSchema.parse(groupId),
                name: value,
              });
          },
          onDelete: (groupId) =>
            run({ type: "team.group.delete", groupId: TeamGroupIdSchema.parse(groupId) }),
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
        groups={all.map((group) => ({
          id: group.id,
          name: group.name,
          peopleCount: group.people.length,
        }))}
        selected={
          selected
            ? {
                id: selected.id,
                name: selected.name,
                peopleCount: selected.people.length,
                parents: all
                  .filter((group) => group.children.includes(selected.id))
                  .map((group) => group.name),
                members: [
                  ...selected.people.map((userId) => ({
                    kind: "person" as const,
                    person: person(view.words, userId),
                  })),
                  ...selected.children.flatMap((childId) => {
                    const child = all.find((group) => group.id === childId);
                    return child
                      ? [
                          {
                            kind: "group" as const,
                            group: {
                              id: child.id,
                              name: child.name,
                              peopleCount: child.people.length,
                            },
                          },
                        ]
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
  return (
    <SettingsGroup heading="Invite link" headingId="team-invites">
      <div className="card__row">
        <InvitePanel client={view.client} />
      </div>
    </SettingsGroup>
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
            detail={
              channel.archivedAt ? "Archived" : channel.kind === "private" ? "Private" : "Public"
            }
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
          You can manage its members without joining. To read it, you have to be a member. This goes
          in the team’s audit log, and #{gate.name}’s managers are told.
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
    only === "all"
      ? true
      : only === "agents"
        ? entry.actor?.kind === "agent"
        : entry.actor?.kind === "human",
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
