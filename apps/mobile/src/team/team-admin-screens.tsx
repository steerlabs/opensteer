import { unwrapRpcResult } from "@opensteer/client/host";
import type { TeamSessionClient } from "@opensteer/client/team";
import type { HostedTeamId } from "@opensteer/control-plane-protocol/hosted-teams";
import { DeploymentIdSchema, TeamGroupIdSchema, UserIdSchema } from "@opensteer/core";
import type { HostApiCommandInput, TeamGroupSchema } from "@opensteer/protocol";
import type { z } from "zod";
import {
  useFocusEffect,
  useIsFocused,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RootParamList } from "../navigation.js";
import { color, controlFontScaleLimit, space, touchTarget } from "../theme.js";
import { AppText, Notice, RowGroup } from "../ui/primitives.js";
import { Screen } from "../ui/screen.js";
import {
  GroupDetailBody,
  GroupsAdminBody,
  PeopleAdminBody,
  TeamSettingsBody,
  type GroupMemberRow,
  type PersonAdminRow,
} from "./team-admin.js";
import { useTeamEntry, useTeamMembers, useTeamSession } from "./team-context.js";
import { agentWords, useAgentConnection } from "./team-entry-screens.js";
import { personView } from "./team-views.js";

type Navigation = NativeStackNavigationProp<RootParamList>;
type TeamGroup = z.infer<typeof TeamGroupSchema>;
type TeamParams = StaticScreenProps<{ readonly teamId: string }>;

async function command(session: TeamSessionClient, input: HostApiCommandInput) {
  return unwrapRpcResult(await session.rpc["commands.dispatch"](input));
}

function failed(error: unknown): void {
  Alert.alert("That didn't work", error instanceof Error ? error.message : undefined);
}

function Waiting(props: {
  readonly failure: string | null;
  readonly onRetry?: () => void;
}): ReactNode {
  return (
    <Screen>
      <View style={styles.center}>
        {props.failure === null ? (
          <ActivityIndicator color={color.muted} />
        ) : (
          <Notice
            {...(props.onRetry ? { action: { label: "Try again", onPress: props.onRetry } } : {})}
            detail={props.failure}
            title="This team didn't answer"
            tone="neutral"
          />
        )}
      </View>
    </Screen>
  );
}

/** Enough groups for any team this app serves, as the people list is bounded. */
const groupBound = 1000;

function useGroups(session: TeamSessionClient | null): {
  readonly groups: readonly TeamGroup[] | null;
  readonly failure: string | null;
  readonly reload: () => void;
} {
  const [groups, setGroups] = useState<readonly TeamGroup[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (session === null) return;
    let current = true;
    // Every page: a group just made, or one past the first 50, must be found by its id.
    const read = async (): Promise<readonly TeamGroup[]> => {
      const all: TeamGroup[] = [];
      let after: TeamGroup["id"] | undefined;
      do {
        const page = unwrapRpcResult(
          await session.rpc["team.groups.list"](after === undefined ? {} : { after }),
        );
        all.push(...page.groups);
        after = page.hasMore ? page.groups.at(-1)?.id : undefined;
      } while (current && after !== undefined && all.length < groupBound);
      return all;
    };
    void read().then(
      (next) => {
        if (!current) return;
        setGroups(next);
        setFailure(null);
      },
      (error: unknown) =>
        current && setFailure(error instanceof Error ? error.message : "The team didn't answer."),
    );
    return () => {
      current = false;
    };
  }, [generation, session]);
  const reload = useCallback(() => setGeneration((next) => next + 1), []);
  return { groups, failure, reload };
}

/**
 * Whether Account says this Account holds the hosted team: only its holder may transfer it. Read
 * again whenever the screen comes back into view, as after a transfer.
 */
function useHoldsHostedTeam(hostedTeamId: HostedTeamId | null): boolean {
  const { account } = useTeamEntry();
  const focused = useIsFocused();
  const [held, setHeld] = useState<HostedTeamId | null>(null);
  useEffect(() => {
    if (!focused) return;
    if (hostedTeamId === null) return;
    const controller = new AbortController();
    void account.hostedTeam(hostedTeamId, controller.signal).then(
      (view) => !controller.signal.aborted && setHeld(view?.creator ? hostedTeamId : null),
      () => undefined,
    );
    return () => controller.abort();
  }, [account, focused, hostedTeamId]);
  return hostedTeamId !== null && held === hostedTeamId;
}

/** A team's own page: the reader in it, their agent's link, and for admins the team itself. */
export function TeamSettingsScreen(props: TeamParams): ReactNode {
  const { teamId } = props.route.params;
  const navigation = useNavigation<Navigation>();
  const { coordinator } = useTeamEntry();
  const { session, snapshot, team, failure } = useTeamSession(teamId);
  const { members, directory } = useTeamMembers(teamId);
  const canManageGroups = snapshot.bootstrap?.can.manageGroups === true;
  // Only people who manage groups are shown the count, so only they ask for the list.
  const { groups } = useGroups(canManageGroups ? session : null);
  const padding = useSafeAreaInsets().bottom + space[24];
  const agent = useAgentConnection(teamId);
  const bootstrap = snapshot.bootstrap;
  const hostedTeamId = bootstrap?.member.role === "owner" ? (bootstrap.hostedTeamId ?? null) : null;
  const holds = useHoldsHostedTeam(hostedTeamId);
  if (session === null || bootstrap === null || team === null) return <Waiting failure={failure} />;
  const words = agentWords(agent.intent, agent.linked, bootstrap.member.handle);
  const connected = words.tone === "done";
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
          onPartners: () => navigation.navigate("TeamPartners", { teamId }),
          onGroups: () => navigation.navigate("TeamGroups", { teamId }),
          onInvites: () => navigation.navigate("TeamInvites", { teamId }),
          onChannels: () => navigation.navigate("TeamChannels", { teamId }),
          onKnowledge: () => navigation.navigate("TeamKnowledge", { teamId }),
          onAuditLog: () => navigation.navigate("TeamAudit", { teamId }),
          onLeave: () =>
            void coordinator
              .leaveTeam(DeploymentIdSchema.parse(teamId))
              .then(() => navigation.popToTop(), failed),
          onDisconnect: connected
            ? () => void coordinator.disconnectAgent(DeploymentIdSchema.parse(teamId)).catch(failed)
            : null,
          onTransfer: holds ? () => navigation.navigate("TransferTeam", { teamId }) : null,
          onDelete:
            hostedTeamId === null ? null : () => navigation.navigate("DeleteTeam", { teamId }),
        }}
        address={new URL(team.origin).host}
        agent={
          connected
            ? { value: agent.computerName ?? "Connected", detail: null, attention: false }
            : words.tone === "busy" || words.tone === "waiting"
              ? {
                  value: words.tone === "busy" ? "Connecting" : "Waiting",
                  detail: words.line,
                  attention: false,
                }
              : { value: "Not connected", detail: words.line, attention: true }
        }
        can={bootstrap.can}
        counts={{ people: members.length, groups: groups?.length ?? null }}
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
  const { session, snapshot, team, failure } = useTeamSession(teamId);
  const roster = useTeamMembers(teamId);
  const { members, directory, reload } = roster;
  const [query, setQuery] = useState("");
  const padding = useSafeAreaInsets().bottom + space[24];
  if (session === null || snapshot.bootstrap === null) return <Waiting failure={failure} />;
  if (members.length === 0 && roster.failure !== null)
    return (
      <Screen>
        <View style={styles.center}>
          <Notice
            action={{ label: "Try again", onPress: reload }}
            detail={roster.failure}
            title="People didn't load"
            tone="neutral"
          />
        </View>
      </Screen>
    );
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
                Alert.alert(
                  `Remove ${member.displayName}?`,
                  `They lose access to ${team?.name ?? "the team"} and its channels right away. Their messages stay.`,
                  [
                    { style: "cancel", text: "Cancel" },
                    {
                      style: "destructive",
                      text: "Remove",
                      onPress: () =>
                        void command(session, { type: "team.member.remove", userId }).then(
                          reload,
                          failed,
                        ),
                    },
                  ],
                ),
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
  const groups = useGroups(session);
  const padding = useSafeAreaInsets().bottom + space[24];
  // A group made on its own screen is listed on the way back.
  const { reload } = groups;
  const returned = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (returned.current) reload();
      returned.current = true;
    }, [reload]),
  );
  if (session === null || groups.groups === null)
    return <Waiting failure={failure ?? groups.failure} onRetry={groups.reload} />;
  return (
    <Screen edgeToEdge>
      <GroupsAdminBody
        groups={groups.groups.map((group) => ({
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
        onNew={() => navigation.navigate("TeamNewGroup", { teamId })}
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
  const { groups, reload, failure: groupsFailure } = useGroups(session);
  const padding = useSafeAreaInsets().bottom + space[24];
  const group = groups?.find((row) => row.id === groupId) ?? null;
  if (session === null || group === null)
    return (
      <Waiting
        failure={
          failure ?? groupsFailure ?? (groups === null ? null : "This group no longer exists.")
        }
        onRetry={reload}
      />
    );
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
              : {
                  type: "team.group.person.remove",
                  groupId: id,
                  userId: UserIdSchema.parse(memberId),
                },
          ).then(reload, failed);
        }}
        paddingBottom={padding}
        usedBy={[]}
      />
    </Screen>
  );
}

/** What admins did and what agents read, searched and posted. Never a private transcript. */
export function TeamAuditScreen(props: TeamParams): ReactNode {
  const { teamId } = props.route.params;
  const { session, failure } = useTeamSession(teamId);
  const { directory } = useTeamMembers(teamId);
  const [rows, setRows] = useState<readonly TeamAuditRow[] | null>(null);
  const [readFailure, setReadFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (session === null) return;
    let current = true;
    void session.rpc["team.audit.page"]({})
      .then(unwrapRpcResult)
      .then(
        (page) => current && setRows(page.audit),
        (error: unknown) =>
          current &&
          setReadFailure(error instanceof Error ? error.message : "The team didn't answer."),
      );
    return () => {
      current = false;
    };
  }, [attempt, session]);
  if (session === null || rows === null)
    return (
      <Waiting
        failure={failure ?? readFailure}
        onRetry={() => {
          setReadFailure(null);
          setAttempt((next) => next + 1);
        }}
      />
    );
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
              <View accessible key={row.id} style={styles.auditRow}>
                <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="body">
                  {`${who}: ${row.action}`}
                </AppText>
                <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="caption" tone="muted">
                  {`${new Date(row.occurredAt).toLocaleString()} · ${row.resourceKind}${row.outcome === "denied" ? " · refused" : ""}`}
                </AppText>
              </View>
            );
          })}
        </RowGroup>
      </ScrollView>
    </Screen>
  );
}

type TeamAuditRow = import("zod").infer<typeof import("@opensteer/protocol").TeamAuditSchema>;

const styles = StyleSheet.create({
  auditRow: {
    gap: 1,
    justifyContent: "center",
    minHeight: touchTarget + 6,
    paddingHorizontal: space[14],
    paddingVertical: space[8],
  },
  page: { gap: space[16], padding: space[16] },
  center: { alignItems: "center", flex: 1, justifyContent: "center", padding: space[16] },
});
