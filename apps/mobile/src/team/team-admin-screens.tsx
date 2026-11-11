import { PersonalTeamLinks, unwrapRpcResult } from "@opensteer/client/host";
import type { TeamSessionClient } from "@opensteer/client/team";
import { createId, TeamGroupIdSchema, TeamInviteIdSchema, UserIdSchema } from "@opensteer/core";
import type {
  HostApiCommandInput,
  TeamGroupSchema,
  TeamInviteSchema,
} from "@opensteer/protocol";
import type { z } from "zod";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Clipboard from "expo-clipboard";
import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, ScrollView, Share, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RootParamList } from "../navigation.js";
import { color, space } from "../theme.js";
import { useSelectedHostClient } from "../ui/mobile-client-context.js";
import { Notice, RowGroup } from "../ui/primitives.js";
import { LinkRow } from "./settings-rows.js";
import { Screen } from "../ui/screen.js";
import {
  GroupDetailBody,
  GroupsAdminBody,
  InvitesAdminBody,
  PeopleAdminBody,
  TeamSettingsBody,
  type GroupMemberRow,
  type PersonAdminRow,
} from "./team-admin.js";
import { useMobileTeams, useTeamMembers, useTeamSession } from "./team-context.js";
import { personView } from "./team-views.js";

type Navigation = NativeStackNavigationProp<RootParamList>;
type TeamGroup = z.infer<typeof TeamGroupSchema>;
type TeamInvite = z.infer<typeof TeamInviteSchema>;
type TeamParams = StaticScreenProps<{ readonly teamId: string }>;

async function command(session: TeamSessionClient, input: HostApiCommandInput) {
  return unwrapRpcResult(await session.rpc["commands.dispatch"](input));
}

function failed(error: unknown): void {
  Alert.alert("That didn't work", error instanceof Error ? error.message : undefined);
}

function Waiting(props: { readonly failure: string | null }): ReactNode {
  return (
    <Screen>
      <View style={styles.center}>
        {props.failure === null ? (
          <ActivityIndicator color={color.muted} />
        ) : (
          <Notice detail={props.failure} title="This team didn't answer" tone="neutral" />
        )}
      </View>
    </Screen>
  );
}

function useGroups(session: TeamSessionClient | null): {
  readonly groups: readonly TeamGroup[] | null;
  readonly reload: () => void;
} {
  const [groups, setGroups] = useState<readonly TeamGroup[] | null>(null);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (session === null) return;
    let current = true;
    void session.rpc["team.groups.list"]({})
      .then(unwrapRpcResult)
      .then((page) => current && setGroups(page.groups), () => undefined);
    return () => {
      current = false;
    };
  }, [generation, session]);
  return { groups, reload: () => setGeneration((next) => next + 1) };
}

/** A team's own page: the reader in it, their agent's link, and for admins the team itself. */
export function TeamSettingsScreen(props: TeamParams): ReactNode {
  const { teamId } = props.route.params;
  const navigation = useNavigation<Navigation>();
  const teams = useMobileTeams();
  const personal = useSelectedHostClient();
  const { session, snapshot, team, failure } = useTeamSession(teamId);
  const { members, directory } = useTeamMembers(teamId);
  const { groups } = useGroups(session);
  const padding = useSafeAreaInsets().bottom + space[24];
  const [agentLink, setAgentLink] = useState<string | null>(null);
  useEffect(() => {
    if (personal === null) return;
    let current = true;
    void new PersonalTeamLinks(personal.rpc).list().then(
      (links) => {
        const link = links.find((row) => row.teamId === teamId && row.state === "active");
        if (current) setAgentLink(link === undefined ? null : (personal.getSnapshot().ownerName ?? "your computer"));
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [personal, teamId]);
  const bootstrap = snapshot.bootstrap;
  if (session === null || bootstrap === null || team === null) return <Waiting failure={failure} />;
  return (
    <Screen edgeToEdge>
      <TeamSettingsBody
        actions={{
          onProfile: () =>
            Alert.alert(
              bootstrap.member.displayName,
              `Your handle is @${bootstrap.member.handle}; your agent's is @${bootstrap.member.handle}-agent. Your name comes from your Opensteer Account.`,
            ),
          onNotifications: () =>
            Alert.alert(
              "Notifications",
              "Each channel's Details has Notify me: everything, mentions (the default) or nothing. Direct messages always notify.",
            ),
          onConnect: () => navigation.navigate("ConnectOpensteer", { teamId }),
          onPeople: () => navigation.navigate("TeamPeople", { teamId }),
          onGroups: () => navigation.navigate("TeamGroups", { teamId }),
          onInvites: () => navigation.navigate("TeamInvites", { teamId }),
          onChannels: () => navigation.navigate("TeamChannels", { teamId }),
          onKnowledge: () => navigation.navigate("TeamKnowledge", { teamId }),
          onAuditLog: () => navigation.navigate("TeamAudit", { teamId }),
          onLeave: () =>
            Alert.alert(
              `Leave ${team.name}?`,
              `You'll lose access to its channels. Tasks your agent did for ${team.name} stay on your computer.`,
              [
                { style: "cancel", text: "Cancel" },
                {
                  style: "destructive",
                  text: "Leave",
                  onPress: () =>
                    void teams.leave(teamId).then(() => navigation.popToTop(), failed),
                },
              ],
            ),
        }}
        address={new URL(team.origin).host}
        agentLink={agentLink}
        counts={{ people: members.length, groups: groups?.length ?? 0 }}
        me={personView(bootstrap.member.userId, directory)}
        paddingBottom={padding}
        role={bootstrap.member.role}
        team={{ id: teamId, name: team.name, imageUri: null }}
      />
    </Screen>
  );
}

/** Everyone in the team. A row opens Change role and Remove. */
export function TeamPeopleScreen(props: TeamParams): ReactNode {
  const { teamId } = props.route.params;
  const navigation = useNavigation<Navigation>();
  const teams = useMobileTeams();
  const { session, snapshot, failure } = useTeamSession(teamId);
  const { members, directory } = useTeamMembers(teamId);
  const [query, setQuery] = useState("");
  const padding = useSafeAreaInsets().bottom + space[24];
  if (session === null || snapshot.bootstrap === null) return <Waiting failure={failure} />;
  const lower = query.trim().toLowerCase();
  const people: PersonAdminRow[] = members
    .filter((member) => lower === "" || member.displayName.toLowerCase().includes(lower))
    .map((member) => ({
      person: personView(member.userId, directory),
      email: null,
      role: member.role,
      lastActive: "",
      deactivated: member.state === "removed",
    }));
  const reload = (): void => teams.forgetMembers(teamId);
  return (
    <Screen edgeToEdge>
      <PeopleAdminBody
        onInvite={() => navigation.navigate("TeamInvites", { teamId })}
        onPerson={(personId) => {
          const member = members.find((row) => row.userId === personId);
          if (member === undefined || member.role === "owner") return;
          const userId = UserIdSchema.parse(personId);
          Alert.alert(member.displayName, undefined, [
            {
              text: member.role === "admin" ? "Make member" : "Make admin",
              onPress: () =>
                void command(session, {
                  type: "team.member.role.set",
                  userId,
                  role: member.role === "admin" ? "member" : "admin",
                }).then(reload, failed),
            },
            {
              style: "destructive",
              text: "Remove from team",
              onPress: () =>
                void command(session, { type: "team.member.remove", userId }).then(reload, failed),
            },
            { style: "cancel", text: "Cancel" },
          ]);
        }}
        onQuery={setQuery}
        paddingBottom={padding}
        people={people}
        query={query}
      />
    </Screen>
  );
}

/** Groups of people and other groups. */
export function TeamGroupsScreen(props: TeamParams): ReactNode {
  const { teamId } = props.route.params;
  const navigation = useNavigation<Navigation>();
  const { session, failure } = useTeamSession(teamId);
  const { groups, reload } = useGroups(session);
  const padding = useSafeAreaInsets().bottom + space[24];
  if (session === null || groups === null) return <Waiting failure={failure} />;
  return (
    <Screen edgeToEdge>
      <GroupsAdminBody
        groups={groups.map((group) => ({
          id: group.id,
          name: group.name,
          members: [
            `${group.people.length} ${group.people.length === 1 ? "person" : "people"}`,
            group.children.length === 0
              ? null
              : `${group.children.length} ${group.children.length === 1 ? "group" : "groups"}`,
          ]
            .filter(Boolean)
            .join(" · "),
          usedBy: null,
        }))}
        onGroup={(groupId) => navigation.navigate("TeamGroup", { teamId, groupId })}
        onNew={() =>
          Alert.prompt?.("New group", undefined, (name) => {
            if (name.trim() === "") return;
            void command(session, {
              type: "team.group.create",
              id: createId("teamGroup"),
              name: name.trim(),
            }).then(reload, failed);
          })
        }
        paddingBottom={padding}
      />
    </Screen>
  );
}

/** One group: who is in it. */
export function TeamGroupScreen(
  props: StaticScreenProps<{ readonly teamId: string; readonly groupId: string }>,
): ReactNode {
  const { teamId, groupId } = props.route.params;
  const { session, failure } = useTeamSession(teamId);
  const { members, directory } = useTeamMembers(teamId);
  const { groups, reload } = useGroups(session);
  const padding = useSafeAreaInsets().bottom + space[24];
  const group = groups?.find((row) => row.id === groupId) ?? null;
  if (session === null || group === null) return <Waiting failure={failure} />;
  const id = TeamGroupIdSchema.parse(groupId);
  const rows: GroupMemberRow[] = [
    ...group.people.map((userId) => {
      const person = personView(userId, directory);
      return { id: userId, kind: "person" as const, name: person.name, person };
    }),
    ...group.children.map((child) => ({
      id: child,
      kind: "group" as const,
      name: groups?.find((row) => row.id === child)?.name ?? "Group",
      person: null,
    })),
  ];
  return (
    <Screen edgeToEdge>
      <GroupDetailBody
        members={rows}
        onAdd={() => {
          const outside = members.filter(
            (member) => member.state === "active" && !group.people.includes(member.userId),
          );
          Alert.alert("Add to group", undefined, [
            ...outside.slice(0, 6).map((member) => ({
              text: member.displayName,
              onPress: () =>
                void command(session, {
                  type: "team.group.person.add",
                  groupId: id,
                  userId: member.userId,
                }).then(reload, failed),
            })),
            { style: "cancel" as const, text: "Cancel" },
          ]);
        }}
        onRemove={(memberId) => {
          const row = rows.find((candidate) => candidate.id === memberId);
          void command(
            session,
            row?.kind === "group"
              ? {
                  type: "team.group.child.remove",
                  groupId: id,
                  childGroupId: TeamGroupIdSchema.parse(memberId),
                }
              : { type: "team.group.person.remove", groupId: id, userId: UserIdSchema.parse(memberId) },
          ).then(reload, failed);
        }}
        paddingBottom={padding}
        usedBy={[]}
      />
    </Screen>
  );
}

/**
 * The team's invite link. Its secret half exists only when it is made, so a
 * link made elsewhere can be replaced here but not shown again.
 */
export function TeamInvitesScreen(props: TeamParams): ReactNode {
  const { teamId } = props.route.params;
  const { session, failure } = useTeamSession(teamId);
  const padding = useSafeAreaInsets().bottom + space[24];
  const [invites, setInvites] = useState<readonly TeamInvite[] | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (session === null) return;
    let current = true;
    void session.rpc["team.invites.list"]({})
      .then(unwrapRpcResult)
      .then((page) => current && setInvites(page.invites), () => undefined);
    return () => {
      current = false;
    };
  }, [generation, session]);
  if (session === null || invites === null) return <Waiting failure={failure} />;
  const live = invites.find(
    (invite) => invite.revokedAt === null && Date.parse(invite.expiresAt) > Date.now(),
  );
  const revokeLive = async (): Promise<void> => {
    if (live !== undefined)
      await command(session, { type: "team.invite.revoke", inviteId: TeamInviteIdSchema.parse(live.id) });
  };
  const makeLink = async (): Promise<void> => {
    await revokeLive();
    const made = await command(session, {
      type: "team.invite.create",
      id: createId("teamInvite"),
      maxUses: 100,
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    if (made.type === "team.invite.create") setLink(made.url);
    setGeneration((next) => next + 1);
  };
  return (
    <Screen edgeToEdge>
      <InvitesAdminBody
        copied={copied}
        enabled={live !== undefined}
        landing="#general"
        link={link ?? (live === undefined ? "No link is on" : "Make a new link to share it here")}
        onCopy={() => {
          if (link === null) return;
          void Clipboard.setStringAsync(link).then(() => setCopied(true));
        }}
        onEnabled={(on) => void (on ? makeLink() : revokeLive().then(() => setGeneration((n) => n + 1))).catch(failed)}
        onLanding={() => undefined}
        onNewLink={() => void makeLink().catch(failed)}
        onShare={() => {
          if (link !== null) void Share.share({ message: link });
        }}
        paddingBottom={padding}
        status={
          live === undefined
            ? "Off"
            : `Expires ${new Date(live.expiresAt).toLocaleDateString()} · used ${live.usedCount} ${live.usedCount === 1 ? "time" : "times"}`
        }
      />
    </Screen>
  );
}

/** Every channel the reader can see in the team, to open or join. */
export function TeamChannelsScreen(props: TeamParams): ReactNode {
  const { teamId } = props.route.params;
  const navigation = useNavigation<Navigation>();
  const { session, failure } = useTeamSession(teamId);
  const [channels, setChannels] = useState<readonly TeamChannelSummary[] | null>(null);
  useEffect(() => {
    if (session === null) return;
    let current = true;
    void session.rpc["team.channels.list"]({})
      .then(unwrapRpcResult)
      .then((page) => current && setChannels(page.channels), () => undefined);
    return () => {
      current = false;
    };
  }, [session]);
  if (session === null || channels === null) return <Waiting failure={failure} />;
  return (
    <Screen edgeToEdge>
      <ScrollView contentContainerStyle={styles.page}>
        <RowGroup>
          {channels
            .filter((channel) => channel.kind === "public" || channel.kind === "private")
            .map((channel) => (
              <LinkRow
                detail={channel.archivedAt === null ? (channel.peopleOnly ? "People only" : null) : "Archived"}
                icon={channel.kind === "private" ? "lock" : "number"}
                key={channel.id}
                label={channel.name}
                onPress={() => {
                  const open = () =>
                    navigation.navigate("TeamChannel", { teamId, channelId: channel.id });
                  if (channel.can.read) open();
                  else if (channel.can.join)
                    void command(session, { type: "team.channel.join", channelId: channel.id }).then(open, failed);
                }}
              />
            ))}
        </RowGroup>
      </ScrollView>
    </Screen>
  );
}

/** What admins did and what agents read, searched and posted. Never a private transcript. */
export function TeamAuditScreen(props: TeamParams): ReactNode {
  const { teamId } = props.route.params;
  const { session, failure } = useTeamSession(teamId);
  const { directory } = useTeamMembers(teamId);
  const [rows, setRows] = useState<readonly TeamAuditRow[] | null>(null);
  useEffect(() => {
    if (session === null) return;
    let current = true;
    void session.rpc["team.audit.page"]({})
      .then(unwrapRpcResult)
      .then((page) => current && setRows(page.audit), () => undefined);
    return () => {
      current = false;
    };
  }, [session]);
  if (session === null || rows === null) return <Waiting failure={failure} />;
  return (
    <Screen edgeToEdge>
      <ScrollView contentContainerStyle={styles.page}>
        <RowGroup>
          {rows.map((row) => {
            const who =
              row.actor === null
                ? "The team"
                : row.actor.kind === "agent"
                  ? `${personView(row.actor.userId, directory).name}'s agent`
                  : personView(row.actor.userId, directory).name;
            return (
              <LinkRow
                detail={`${new Date(row.occurredAt).toLocaleString()} · ${row.resourceKind}${row.outcome === "denied" ? " · refused" : ""}`}
                key={row.id}
                label={`${who}: ${row.action}`}
                onPress={() => undefined}
              />
            );
          })}
        </RowGroup>
      </ScrollView>
    </Screen>
  );
}

type TeamChannelSummary = import("zod").infer<
  typeof import("@opensteer/protocol").TeamChannelSummarySchema
>;
type TeamAuditRow = import("zod").infer<typeof import("@opensteer/protocol").TeamAuditSchema>;

const styles = StyleSheet.create({
  page: { gap: space[16], padding: space[16] },
  center: { alignItems: "center", flex: 1, justifyContent: "center", padding: space[16] },
});
