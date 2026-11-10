import {
  accessModeOptions,
  createTeamInvitationDraft,
  grantChanges,
  levelLabel,
  memberKindLabel,
  memberPreviewCopy,
  memberStateLabel,
  peopleCount,
  runtimeStateText,
  subjectKey,
  teamInvitationUrl,
  teamReasonText,
  type HostClient,
  type TeamAccess,
} from "@opensteer/client/host";
import { useHostRead, useHostSnapshot, useTeam } from "@opensteer/client/react";
import { HarnessInstanceIdSchema, type ThreadAccessMode } from "@opensteer/core";
import type {
  AccessChange,
  Level,
  MemberChange,
  MemberKind,
  MemberSummary,
  Subject,
} from "@opensteer/protocol";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { Alert, Pressable, ScrollView, Share, View } from "react-native";
import { color, space } from "../theme.js";
import { ChoiceMenu } from "../ui/choice-menu.js";
import {
  AppText,
  CodeBlock,
  Field,
  PrimaryButton,
  RowGroup,
  SecondaryButton,
} from "../ui/primitives.js";
import { Screen, useListContentInsets, useReadingColumn } from "../ui/screen.js";
import { Symbol } from "../ui/symbol.js";
import { DeploymentGate, useAttachedHost } from "../screens/deployment-gate.js";
import {
  Avatar,
  CanLine,
  Pill,
  ReadState,
  TeamSection,
  confirmAccessChange,
  showError,
  styles,
} from "./team-parts.js";

type DeploymentProps<Extra = object> = StaticScreenProps<{ readonly deploymentId: string } & Extra>;

/** A team screen's frame: attached Host, scrolling reading column, title. */
function TeamScreen(props: {
  readonly deploymentId: string;
  readonly title: string;
  readonly children: (hostClient: HostClient) => ReactNode;
}): ReactNode {
  const hostClient = useAttachedHost(props.deploymentId);
  const navigation = useNavigation();
  useLayoutEffect(() => navigation.setOptions({ title: props.title }), [navigation, props.title]);
  if (hostClient === null) return <DeploymentGate deploymentId={props.deploymentId} />;
  return <TeamScroll>{props.children(hostClient)}</TeamScroll>;
}

function TeamScroll(props: { readonly children: ReactNode }): ReactNode {
  const column = useReadingColumn();
  const insets = useListContentInsets(space[32]);
  return (
    <Screen edgeToEdge>
      <ScrollView
        contentContainerStyle={[styles.content, column, insets]}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        {props.children}
      </ScrollView>
    </Screen>
  );
}

function useDebounced(value: string): string {
  const [debounced, setDebounced] = useState(value.trim());
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value.trim()), 300);
    return () => clearTimeout(timer);
  }, [value]);
  return debounced;
}

function NavRow(props: {
  readonly title: string;
  readonly detail?: string;
  readonly group?: boolean;
  readonly avatar?: string;
  readonly chips?: ReactNode;
  readonly onPress: () => void;
}): ReactNode {
  return (
    <Pressable accessibilityRole="button" onPress={props.onPress} style={styles.row}>
      {props.avatar === undefined ? null : <Avatar group={props.group} name={props.avatar} />}
      <View style={styles.grow}>
        <View style={styles.titleLine}>
          <AppText numberOfLines={1} role="body">
            {props.title}
          </AppText>
          {props.chips ?? null}
        </View>
        {props.detail ? (
          <AppText numberOfLines={1} role="caption" tone="muted">
            {props.detail}
          </AppText>
        ) : null}
      </View>
      <Symbol name="chevron.right" size={13} tint={color.muted} />
    </Pressable>
  );
}

function MemberPills(props: {
  readonly member: Pick<MemberSummary, "administrator" | "kind" | "state">;
}): ReactNode {
  return (
    <>
      {props.member.administrator ? <Pill label="Admin" tone="accent" /> : null}
      {props.member.kind === "guest" ? <Pill label="Guest" /> : null}
      {props.member.state !== "active" ? (
        <Pill
          label={memberStateLabel(props.member.state)}
          tone={props.member.state === "suspended" ? "warn" : undefined}
        />
      ) : null}
    </>
  );
}

/* ---- People ---- */

export function TeamPeopleScreen({ route }: DeploymentProps) {
  return (
    <TeamScreen deploymentId={route.params.deploymentId} title="People">
      {(hostClient) => <People deploymentId={route.params.deploymentId} hostClient={hostClient} />}
    </TeamScreen>
  );
}

function People(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
}): ReactNode {
  const navigation = useNavigation();
  const { team, summary, generation } = useTeam(props.hostClient);
  const [query, setQuery] = useState("");
  const [state, setState] = useState<"all" | "active" | "suspended" | "removed">("all");
  const debounced = useDebounced(query);
  const read = useHostRead(
    team
      ? () =>
          team.people({
            limit: 30,
            ...(debounced ? { query: debounced } : {}),
            ...(state === "all" ? {} : { state }),
          })
      : null,
    `team-people:${debounced}:${state}:${generation}`,
  );
  const teamName = summary?.team.name ?? "the team";
  return (
    <>
      <AppText role="secondary" tone="muted">
        {`Everyone in ${teamName}. Open a person to see what they can use, switch them off or on, or make them an admin.`}
      </AppText>
      <View style={styles.sectionHead}>
        <SecondaryButton
          compact
          label="Groups"
          onPress={() => navigation.navigate("TeamGroups", { deploymentId: props.deploymentId })}
        />
        <ChoiceMenu
          accessibilityLabel="Show"
          choices={[
            { id: "all", title: "All" },
            { id: "active", title: "Active" },
            { id: "suspended", title: "Suspended" },
            { id: "removed", title: "Removed" },
          ]}
          label={state === "all" ? "All" : memberStateLabel(state)}
          onChoose={(id) => setState(id as typeof state)}
        />
        <View style={styles.grow} />
        {summary?.can.invite.allowed ? (
          <PrimaryButton
            compact
            label="Invite"
            onPress={() => navigation.navigate("TeamInvite", { deploymentId: props.deploymentId })}
          />
        ) : null}
      </View>
      <Field
        input={{
          onChangeText: setQuery,
          placeholder: "Find people",
          value: query,
          autoCorrect: false,
        }}
        label="Find people"
      />
      <RowGroup>
        {read.data
          ? read.data.items.length
            ? read.data.items.map((person) => (
                <NavRow
                  avatar={person.name}
                  chips={<MemberPills member={person} />}
                  detail={person.email}
                  key={person.id}
                  onPress={() =>
                    navigation.navigate("TeamPerson", {
                      deploymentId: props.deploymentId,
                      userId: person.id,
                    })
                  }
                  title={person.name}
                />
              ))
            : [
                <View key="none" style={styles.row}>
                  <AppText role="secondary" tone="muted">
                    {debounced ? `Nobody matches “${debounced}”.` : "Nobody here yet."}
                  </AppText>
                </View>,
              ]
          : [<ReadState error={read.error} key="state" onRetry={read.reload} team={teamName} />]}
      </RowGroup>
      {team && summary?.can.invite.allowed ? (
        <Invitations
          deploymentId={props.deploymentId}
          generation={generation}
          team={team}
          teamName={teamName}
        />
      ) : null}
    </>
  );
}

/**
 * Links this phone made while the app was open, by invitation id. The verifier
 * is kept nowhere else, so another device, or this one after a restart, can
 * only revoke and invite again.
 */
const heldLinks = new Map<string, string>();
function heldLink(invitationId: string, url: string): string {
  heldLinks.set(invitationId, url);
  return url;
}

const invitationStateLabel = {
  open: "Open",
  used: "Joined",
  revoked: "Revoked",
  expired: "Expired",
} as const;

function Invitations(props: {
  readonly deploymentId: string;
  readonly generation: number;
  readonly team: TeamAccess;
  readonly teamName: string;
}): ReactNode {
  const navigation = useNavigation();
  const { team, teamName } = props;
  const read = useHostRead(
    () => team.invitations({ limit: 30 }),
    `team-invitations:${props.generation}`,
  );
  const list = read.data;
  const day = (value: string) =>
    new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(new Date(value));
  return (
    <TeamSection
      footer="Open invitations, and those made, used or revoked in the last 30 days, from any device. A link can be shared again only on the phone that made it; anywhere else, revoke it and invite again."
      label="Invitations"
    >
      <RowGroup>
        {list
          ? list.items.length
            ? list.items.map((invitation) => {
                const link = invitation.state === "open" ? heldLinks.get(invitation.id) : undefined;
                return (
                  <View key={invitation.id} style={styles.row}>
                    <View style={styles.grow}>
                      <View style={styles.titleLine}>
                        <AppText numberOfLines={1} role="body">
                          {invitation.emailMasked}
                        </AppText>
                        {invitation.memberKind === "guest" ? <Pill label="Guest" /> : null}
                        <Pill
                          label={invitationStateLabel[invitation.state]}
                          tone={invitation.state === "expired" ? "warn" : undefined}
                        />
                      </View>
                      <AppText role="caption" tone="muted">
                        {`Made by ${invitation.createdBy.name}, ${day(invitation.createdAt)}${
                          invitation.state === "open"
                            ? link
                              ? ""
                              : ". Its link can’t be shown again here."
                            : ""
                        }`}
                      </AppText>
                    </View>
                    {link ? (
                      <SecondaryButton
                        compact
                        label="Share"
                        onPress={() => void Share.share({ message: link }).catch(() => undefined)}
                      />
                    ) : null}
                    {invitation.can.revoke.allowed ? (
                      <SecondaryButton
                        compact
                        label="Revoke"
                        onPress={() =>
                          Alert.alert(
                            `Revoke the invitation for ${invitation.emailMasked}?`,
                            "Its link stops working at once.",
                            [
                              { style: "cancel", text: "Cancel" },
                              {
                                style: "destructive",
                                text: "Revoke",
                                onPress: () => {
                                  team
                                    .revokeInvitation(list.accessRevision, invitation.id)
                                    .then(() => heldLinks.delete(invitation.id))
                                    .catch((error: unknown) => showError(error, teamName));
                                },
                              },
                            ],
                          )
                        }
                        tone="danger"
                      />
                    ) : invitation.state === "revoked" || invitation.state === "expired" ? (
                      <SecondaryButton
                        compact
                        label="Invite again"
                        onPress={() =>
                          navigation.navigate("TeamInvite", { deploymentId: props.deploymentId })
                        }
                      />
                    ) : null}
                  </View>
                );
              })
            : [
                <View key="none" style={styles.row}>
                  <AppText role="secondary" tone="muted">
                    No invitations in the last 30 days.
                  </AppText>
                </View>,
              ]
          : [<ReadState error={read.error} key="state" onRetry={read.reload} team={teamName} />]}
      </RowGroup>
    </TeamSection>
  );
}

export function TeamPersonScreen({ route }: DeploymentProps<{ readonly userId: string }>) {
  return (
    <TeamScreen deploymentId={route.params.deploymentId} title="Person">
      {(hostClient) => (
        <Person
          deploymentId={route.params.deploymentId}
          hostClient={hostClient}
          userId={route.params.userId}
        />
      )}
    </TeamScreen>
  );
}

function Person(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
  readonly userId: string;
}): ReactNode {
  const navigation = useNavigation();
  const { team, summary, generation } = useTeam(props.hostClient);
  const { snapshot } = useHostSnapshot(props.hostClient);
  const teamName = summary?.team.name ?? "the team";
  const read = useHostRead(
    team ? () => team.member({ userId: props.userId }) : null,
    `team-member:${props.userId}:${generation}`,
  );
  const person = read.data;
  if (!team || !person)
    return (
      <RowGroup>
        {[<ReadState error={read.error} key="state" onRetry={read.reload} team={teamName} />]}
      </RowGroup>
    );
  const change = (next: MemberChange) => {
    team
      .previewMember(person.id, next)
      .then((preview) => {
        const copy = memberPreviewCopy(person.name, next, preview, teamName);
        const body = [
          ...(copy.ends.length
            ? ["What ends now:", ...copy.ends.map((line) => `• ${line}`), ""]
            : []),
          ...(copy.carriesOn.length
            ? ["What carries on:", ...copy.carriesOn.map((line) => `• ${line}`), ""]
            : []),
          copy.after,
        ].join("\n");
        if (!preview.allowed) {
          Alert.alert(
            copy.title,
            `${preview.reason ? teamReasonText(preview.reason, teamName) : ""}\n\n${body}`,
          );
          return;
        }
        Alert.alert(copy.title, body, [
          { style: "cancel", text: "Cancel" },
          {
            style: next.kind === "set-state" && next.value !== "active" ? "destructive" : "default",
            text: copy.confirm,
            onPress: () => {
              team
                .changeMember(preview.accessRevision, person.id, next)
                .catch((error: unknown) => showError(error, teamName));
            },
          },
        ]);
      })
      .catch((error: unknown) => showError(error, teamName));
  };
  const roles: {
    title: string;
    detail: string;
    label: string;
    can: MemberSummary["can"]["setKind"];
    next: MemberChange;
    danger?: boolean;
  }[] = [
    {
      title: person.administrator ? "Admin" : "Not an admin",
      detail: "Admins manage people, groups and every project’s list.",
      label: person.administrator ? "Remove as admin" : "Make admin",
      can: person.can.setAdministrator,
      next: { kind: "set-administrator", value: !person.administrator },
    },
    {
      title: memberKindLabel(person.kind),
      detail:
        person.kind === "guest"
          ? "Sees only the projects they’re added to."
          : "In Everyone, so they get every project shared with Everyone.",
      label: person.kind === "guest" ? "Make member" : "Make guest",
      can: person.can.setKind,
      next: { kind: "set-kind", value: person.kind === "guest" ? "full" : "guest" },
    },
    ...(person.state === "active"
      ? [
          {
            title: "Switch off",
            detail: `Ends their sign-ins and running work in ${teamName}. You can turn them back on.`,
            label: "Suspend",
            can: person.can.setState,
            next: { kind: "set-state", value: "suspended" } as MemberChange,
            danger: true,
          },
        ]
      : person.state === "suspended"
        ? [
            {
              title: "Suspended",
              detail: `They can’t sign in to ${teamName} until you turn them back on.`,
              label: "Turn back on",
              can: person.can.setState,
              next: { kind: "set-state", value: "active" } as MemberChange,
            },
          ]
        : []),
    ...(person.state !== "removed"
      ? [
          {
            title: `Remove from ${teamName}`,
            detail: "Takes them out of every group and project. They need a new invite to return.",
            label: "Remove",
            can: person.can.setState,
            next: { kind: "set-state", value: "removed" } as MemberChange,
            danger: true,
          },
        ]
      : []),
  ];
  return (
    <>
      <View style={styles.identity}>
        <Avatar name={person.name} />
        <View style={styles.grow}>
          <View style={styles.titleLine}>
            <AppText role="title">
              {person.id === snapshot.user?.id ? `${person.name} (you)` : person.name}
            </AppText>
            <MemberPills member={person} />
          </View>
          <AppText role="secondary" tone="muted">
            {`${person.email} · ${memberKindLabel(person.kind, person.administrator)}${person.invitedBy ? ` · Invited by ${person.invitedBy.name}` : ""}`}
          </AppText>
        </View>
      </View>
      {person.state === "removed" ? (
        <View style={styles.banner}>
          <AppText role="bodyMedium">{`${person.name} was removed from ${teamName}.`}</AppText>
          <AppText role="secondary" tone="soft">
            Their history stays in the audit log. To come back, they need a new invite.
          </AppText>
        </View>
      ) : null}
      <TeamSection label="Projects">
        <RowGroup>
          {person.effectiveProjects.length
            ? person.effectiveProjects.map((project) => (
                <NavRow
                  detail={levelLabel(project.level)}
                  key={project.id}
                  onPress={() =>
                    navigation.navigate("ProjectSettings", {
                      deploymentId: props.deploymentId,
                      workspaceId: project.id,
                    })
                  }
                  title={project.name}
                />
              ))
            : [
                <View key="none" style={styles.row}>
                  <AppText
                    role="secondary"
                    tone="muted"
                  >{`${person.name} can’t use any projects yet.`}</AppText>
                </View>,
              ]}
        </RowGroup>
      </TeamSection>
      <TeamSection label="Groups">
        {person.groups.items.length ? (
          <View style={styles.chips}>
            {person.groups.items.map((group) => (
              <Pressable
                key={group.id}
                onPress={() =>
                  navigation.navigate("TeamGroup", {
                    deploymentId: props.deploymentId,
                    groupId: group.id,
                  })
                }
                style={styles.chip}
              >
                <AppText role="caption" tone="soft">
                  {group.name}
                </AppText>
              </Pressable>
            ))}
          </View>
        ) : (
          <AppText role="caption" tone="muted">
            Not in any group.
          </AppText>
        )}
      </TeamSection>
      <TeamSection
        footer={`Disconnecting one stops it acting for ${person.name}; they stay a member.`}
        label="Connected agents"
      >
        <RowGroup>
          {person.connections.items.length
            ? person.connections.items.map((connection) => (
                <View key={connection.id} style={styles.row}>
                  <View style={styles.grow}>
                    <AppText numberOfLines={1} role="body">
                      {connection.label}
                    </AppText>
                    <AppText role="caption" tone="muted">
                      {connection.revoked
                        ? "Disconnected"
                        : connection.lastUsedAt
                          ? "In use"
                          : "Never used"}
                    </AppText>
                  </View>
                  {connection.canRevoke.allowed ? (
                    <SecondaryButton
                      compact
                      label="Disconnect"
                      onPress={() =>
                        Alert.alert(
                          `Disconnect ${connection.label}?`,
                          `It stops acting for ${person.name} in ${teamName} now, and work it started there stops. ${person.name} stays a member.`,
                          [
                            { style: "cancel", text: "Cancel" },
                            {
                              style: "destructive",
                              text: "Disconnect",
                              onPress: () => {
                                team
                                  .revokeConnection(person.accessRevision, connection.id)
                                  .catch((error: unknown) => showError(error, teamName));
                              },
                            },
                          ],
                        )
                      }
                      tone="danger"
                    />
                  ) : null}
                </View>
              ))
            : [
                <View key="none" style={styles.row}>
                  <AppText role="secondary" tone="muted">
                    None.
                  </AppText>
                </View>,
              ]}
        </RowGroup>
      </TeamSection>
      <TeamSection label="Role and access">
        <RowGroup>
          {roles.map((role) => (
            <View key={role.label} style={styles.row}>
              <View style={styles.grow}>
                <AppText role="body">{role.title}</AppText>
                <AppText role="caption" tone="muted">
                  {role.detail}
                </AppText>
                <CanLine can={role.can} team={teamName} />
              </View>
              {role.can.allowed ? (
                <SecondaryButton
                  compact
                  label={role.label}
                  onPress={() => change(role.next)}
                  tone={role.danger ? "danger" : "default"}
                />
              ) : null}
            </View>
          ))}
        </RowGroup>
      </TeamSection>
    </>
  );
}

/* ---- Invite ---- */

export function TeamInviteScreen({ route }: DeploymentProps) {
  return (
    <TeamScreen deploymentId={route.params.deploymentId} title="Invite">
      {(hostClient) => <Invite hostClient={hostClient} />}
    </TeamScreen>
  );
}

function Invite(props: { readonly hostClient: HostClient }): ReactNode {
  const { team, summary } = useTeam(props.hostClient);
  const { snapshot } = useHostSnapshot(props.hostClient);
  const teamName = summary?.team.name ?? "the team";
  const [email, setEmail] = useState("");
  const [kind, setKind] = useState<MemberKind>("full");
  const [validFor, setValidFor] = useState<"1d" | "7d">("7d");
  const [draft] = useState(() => createTeamInvitationDraft());
  const [pending, setPending] = useState(false);
  const [made, setMade] = useState<{
    url: string;
    invitationId: string;
    expiresAt: string;
    revoked: boolean;
  } | null>(null);
  const origin = snapshot.identityConfig?.publicOrigin ?? null;
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email.trim());
  if (!team || !summary || !origin) return null;
  if (made)
    return (
      <>
        <AppText role="title">
          {made.revoked ? "Invite revoked" : `Invite for ${email.trim()} is ready`}
        </AppText>
        <AppText role="secondary" tone="soft">
          {made.revoked
            ? "That link no longer works."
            : `Send it to them yourself. It works once, only for ${email.trim()}, until ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(made.expiresAt))}.`}
        </AppText>
        {made.revoked ? null : (
          <>
            <CodeBlock label="Invite link" text={made.url} />
            <PrimaryButton
              label="Share link"
              onPress={() => void Share.share({ message: made.url }).catch(() => undefined)}
            />
            <SecondaryButton
              label="Revoke"
              onPress={() =>
                void team
                  .revokeInvitation(summary.accessRevision, made.invitationId)
                  .then(() => setMade({ ...made, revoked: true }))
                  .catch((error: unknown) => showError(error, teamName))
              }
              tone="danger"
            />
            <AppText role="caption" tone="muted">
              You can share it again from People while this app stays open on this phone. Any device
              can revoke it under Invitations.
            </AppText>
          </>
        )}
      </>
    );
  return (
    <>
      <Field
        hint="Only someone signed in with this email can join."
        input={{
          autoCapitalize: "none",
          autoComplete: "email",
          keyboardType: "email-address",
          onChangeText: setEmail,
          placeholder: "name@company.com",
          value: email,
        }}
        label="Email"
      />
      <View style={styles.row}>
        <View style={styles.grow}>
          <AppText role="body">As</AppText>
          <AppText role="caption" tone="muted">
            {kind === "full"
              ? "Members are in Everyone."
              : "Guests see only projects they’re added to."}
          </AppText>
        </View>
        <ChoiceMenu
          accessibilityLabel="As"
          choices={[
            { id: "full", title: "Member" },
            { id: "guest", title: "Guest" },
          ]}
          label={kind === "full" ? "Member" : "Guest"}
          onChoose={(id) => setKind(id === "guest" ? "guest" : "full")}
        />
      </View>
      <View style={styles.row}>
        <View style={styles.grow}>
          <AppText role="body">Link works for</AppText>
        </View>
        <ChoiceMenu
          accessibilityLabel="Link works for"
          choices={[
            { id: "7d", title: "7 days" },
            { id: "1d", title: "1 day" },
          ]}
          label={validFor === "7d" ? "7 days" : "1 day"}
          onChoose={(id) => setValidFor(id === "1d" ? "1d" : "7d")}
        />
      </View>
      <PrimaryButton
        busy={pending}
        disabled={!valid}
        label="Make invite link"
        onPress={() => {
          setPending(true);
          team
            .createInvitation(summary.accessRevision, draft, {
              email: email.trim(),
              kind,
              validFor,
            })
            .then((result) =>
              setMade({
                url: heldLink(result.invitationId, teamInvitationUrl(origin, draft)),
                invitationId: result.invitationId,
                expiresAt: result.expiresAt,
                revoked: false,
              }),
            )
            .catch((error: unknown) => showError(error, teamName))
            .finally(() => setPending(false));
        }}
      />
    </>
  );
}

/* ---- Groups ---- */

export function TeamGroupsScreen({ route }: DeploymentProps) {
  return (
    <TeamScreen deploymentId={route.params.deploymentId} title="Groups">
      {(hostClient) => <Groups deploymentId={route.params.deploymentId} hostClient={hostClient} />}
    </TeamScreen>
  );
}

function Groups(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
}): ReactNode {
  const navigation = useNavigation();
  const { team, summary, generation } = useTeam(props.hostClient);
  const teamName = summary?.team.name ?? "the team";
  const read = useHostRead(
    team ? () => team.groups({ limit: 100 }) : null,
    `team-groups:${generation}`,
  );
  const [name, setName] = useState("");
  const list = read.data;
  return (
    <>
      <AppText role="secondary" tone="muted">
        Give a group access to a project once, and everyone in it can use that project. Groups can
        hold other groups.
      </AppText>
      <RowGroup>
        {list
          ? list.items.map((group) => (
              <NavRow
                avatar={group.name}
                chips={group.builtin ? <Pill label="Built in" /> : null}
                detail={
                  group.builtin
                    ? `Every member of ${teamName} · ${peopleCount(group.effectivePeopleCount)}`
                    : `${peopleCount(group.effectivePeopleCount)}${group.parentCount ? ` · in ${group.parentCount} group${group.parentCount === 1 ? "" : "s"}` : ""}`
                }
                group
                key={group.id}
                onPress={() =>
                  navigation.navigate("TeamGroup", {
                    deploymentId: props.deploymentId,
                    groupId: group.id,
                  })
                }
                title={group.name}
              />
            ))
          : [<ReadState error={read.error} key="state" onRetry={read.reload} team={teamName} />]}
      </RowGroup>
      {list?.can.create.allowed && team ? (
        <TeamSection label="New group">
          <Field
            input={{ onChangeText: setName, placeholder: "Support team", value: name }}
            label="Name"
          />
          <SecondaryButton
            disabled={!name.trim()}
            label="Create group"
            onPress={() => {
              const id = globalThis.crypto.randomUUID();
              team
                .applyAccess(list.accessRevision, [{ kind: "create-group", id, name: name.trim() }])
                .then(() => {
                  setName("");
                  navigation.navigate("TeamGroup", {
                    deploymentId: props.deploymentId,
                    groupId: id,
                  });
                })
                .catch((error: unknown) => showError(error, teamName));
            }}
          />
        </TeamSection>
      ) : null}
    </>
  );
}

export function TeamGroupScreen({ route }: DeploymentProps<{ readonly groupId: string }>) {
  return (
    <TeamScreen deploymentId={route.params.deploymentId} title="Group">
      {(hostClient) => (
        <Group
          deploymentId={route.params.deploymentId}
          groupId={route.params.groupId}
          hostClient={hostClient}
        />
      )}
    </TeamScreen>
  );
}

function Group(props: {
  readonly deploymentId: string;
  readonly groupId: string;
  readonly hostClient: HostClient;
}): ReactNode {
  const navigation = useNavigation();
  const { team, summary, generation } = useTeam(props.hostClient);
  const teamName = summary?.team.name ?? "the team";
  const read = useHostRead(
    team ? () => team.group({ groupId: props.groupId, limit: 100 }) : null,
    `team-group:${props.groupId}:${generation}`,
  );
  const [renaming, setRenaming] = useState<string | null>(null);
  const group = read.data;
  if (!team || !group)
    return (
      <RowGroup>
        {[<ReadState error={read.error} key="state" onRetry={read.reload} team={teamName} />]}
      </RowGroup>
    );
  return (
    <>
      <View style={styles.identity}>
        <Avatar group name={group.name} />
        <View style={styles.grow}>
          <AppText role="title">{group.name}</AppText>
          <AppText role="secondary" tone="muted">
            {group.builtin
              ? `Every member of ${teamName}, kept up to date by ${teamName}. Guests aren’t in it.`
              : `${peopleCount(group.effectivePeopleCount)}, counting everyone in the groups inside it.`}
          </AppText>
        </View>
      </View>
      {group.parents.length ? (
        <View style={styles.chips}>
          {group.parents.map((parent) => (
            <Pressable
              key={parent.id}
              onPress={() =>
                navigation.navigate("TeamGroup", {
                  deploymentId: props.deploymentId,
                  groupId: parent.id,
                })
              }
              style={styles.chip}
            >
              <AppText role="caption" tone="soft">{`In ${parent.name}`}</AppText>
            </Pressable>
          ))}
        </View>
      ) : null}
      {group.can.rename.allowed ? (
        renaming === null ? (
          <SecondaryButton compact label="Rename" onPress={() => setRenaming(group.name)} />
        ) : (
          <View style={styles.section}>
            <Field
              input={{ autoFocus: true, onChangeText: setRenaming, value: renaming }}
              label="Name"
            />
            <SecondaryButton
              disabled={!renaming.trim() || renaming.trim() === group.name}
              label="Save name"
              onPress={() =>
                void team
                  .applyAccess(group.accessRevision, [
                    { kind: "rename-group", groupId: group.id, name: renaming.trim() },
                  ])
                  .then(() => setRenaming(null))
                  .catch((error: unknown) => showError(error, teamName))
              }
            />
          </View>
        )
      ) : null}
      <TeamSection
        action={
          group.can.editMembers.allowed ? (
            <SecondaryButton
              compact
              label="Add"
              onPress={() =>
                navigation.navigate("TeamAdd", {
                  deploymentId: props.deploymentId,
                  target: "group" as const,
                  id: group.id,
                  level: "use" as const,
                })
              }
            />
          ) : undefined
        }
        label="Members"
      >
        <RowGroup>
          {group.directMembers.items.length
            ? group.directMembers.items.map((member) => (
                <View key={subjectKey(member)} style={styles.row}>
                  <Avatar group={member.kind === "group"} name={member.name} />
                  <View style={styles.grow}>
                    <AppText numberOfLines={1} role="body">
                      {member.name}
                    </AppText>
                    <AppText role="caption" tone="muted">
                      {member.kind === "group"
                        ? `Group · ${peopleCount(member.memberCount ?? 0)}`
                        : "Person"}
                    </AppText>
                  </View>
                  {group.can.editMembers.allowed ? (
                    <SecondaryButton
                      compact
                      label="Remove"
                      onPress={() =>
                        void confirmAccessChange({
                          team,
                          teamName,
                          revision: group.accessRevision,
                          changes: [
                            {
                              kind: "remove-group-member",
                              groupId: group.id,
                              member:
                                member.kind === "group"
                                  ? { kind: "group", groupId: member.groupId }
                                  : { kind: "person", userId: member.userId },
                            },
                          ],
                          title: `Remove ${member.name} from ${group.name}?`,
                          confirm: "Remove",
                          destructive: true,
                        })
                      }
                      tone="danger"
                    />
                  ) : null}
                </View>
              ))
            : [
                <View key="none" style={styles.row}>
                  <AppText role="secondary" tone="muted">
                    Nobody is in this group yet.
                  </AppText>
                </View>,
              ]}
        </RowGroup>
        <CanLine can={group.can.editMembers} team={teamName} />
      </TeamSection>
      {group.can.delete.allowed ? (
        <SecondaryButton
          label="Delete group…"
          onPress={() =>
            void confirmAccessChange({
              team,
              teamName,
              revision: group.accessRevision,
              changes: [{ kind: "delete-group", groupId: group.id }],
              title: `Delete ${group.name}?`,
              confirm: "Delete group",
              destructive: true,
              onDone: () => navigation.goBack(),
            })
          }
          tone="danger"
        />
      ) : null}
    </>
  );
}

/* ---- Add people or groups ---- */

export function TeamAddScreen({
  route,
}: DeploymentProps<{
  readonly target: "project" | "group";
  readonly id: string;
  readonly level: Level;
}>) {
  const { target } = route.params;
  return (
    <TeamScreen
      deploymentId={route.params.deploymentId}
      title={target === "project" ? "Add people" : "Add to group"}
    >
      {(hostClient) => (
        <Add
          hostClient={hostClient}
          id={route.params.id}
          initialLevel={route.params.level}
          target={target}
        />
      )}
    </TeamScreen>
  );
}

function Add(props: {
  readonly hostClient: HostClient;
  readonly target: "project" | "group";
  readonly id: string;
  readonly initialLevel: Level;
}): ReactNode {
  const navigation = useNavigation();
  const { team, summary } = useTeam(props.hostClient);
  const teamName = summary?.team.name ?? "the team";
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<Level>(props.initialLevel);
  const [picked, setPicked] = useState<{ subject: Subject; name: string }[]>([]);
  const debounced = useDebounced(query);
  const results = useHostRead(
    team && debounced ? () => search(team, props.target, props.id, debounced) : null,
    `team-add:${props.target}:${props.id}:${debounced}`,
  );
  const revision = useHostRead(
    team
      ? () =>
          (props.target === "project"
            ? team.projectAccess({ workspaceId: props.id, limit: 1 })
            : team.group({ groupId: props.id, limit: 1 })
          ).then((view) => view.accessRevision)
      : null,
    `team-add-revision:${props.target}:${props.id}`,
  );
  const keys = new Set(picked.map(({ subject }) => subjectKey(subject)));
  const toggle = (subject: Subject, name: string) =>
    setPicked((current) =>
      keys.has(subjectKey(subject))
        ? current.filter((item) => subjectKey(item.subject) !== subjectKey(subject))
        : [...current, { subject, name }],
    );
  if (!team) return null;
  const changes: AccessChange[] =
    props.target === "project"
      ? grantChanges(
          props.id,
          picked.map(({ subject }) => subject),
          level,
        )
      : picked.map(({ subject }) => ({
          kind: "add-group-member",
          groupId: props.id,
          member: subject,
        }));
  return (
    <>
      <Field
        input={{
          autoCapitalize: "none",
          autoCorrect: false,
          autoFocus: true,
          onChangeText: setQuery,
          placeholder: "Name or group",
          value: query,
        }}
        label="Find people or groups"
      />
      {props.target === "project" ? (
        <View style={styles.row}>
          <View style={styles.grow}>
            <AppText role="body">Level</AppText>
            <AppText role="caption" tone="muted">
              {level === "manage"
                ? "Can also decide who else can use it."
                : "Can read its chat, tasks and files, and start work in it."}
            </AppText>
          </View>
          <ChoiceMenu
            accessibilityLabel="Level"
            choices={[
              { id: "use", title: "Can use" },
              { id: "manage", title: "Can manage" },
            ]}
            label={levelLabel(level)}
            onChoose={(id) => setLevel(id === "manage" ? "manage" : "use")}
          />
        </View>
      ) : null}
      {picked.length ? (
        <View style={styles.chips}>
          {picked.map((item) => (
            <Pressable
              key={subjectKey(item.subject)}
              onPress={() => toggle(item.subject, item.name)}
              style={[
                styles.chip,
                { borderColor: color.emberLine, backgroundColor: color.emberWash },
              ]}
            >
              <AppText role="caption" tone="ember">{`${item.name} ✕`}</AppText>
            </Pressable>
          ))}
        </View>
      ) : null}
      {debounced ? (
        <RowGroup>
          {results.data
            ? results.data.length
              ? results.data.map((result) => (
                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: keys.has(subjectKey(result.subject)) }}
                    key={subjectKey(result.subject)}
                    onPress={() => toggle(result.subject, result.name)}
                    style={styles.row}
                  >
                    <Avatar group={result.subject.kind === "group"} name={result.name} />
                    <View style={styles.grow}>
                      <AppText role="body">{result.name}</AppText>
                      <AppText role="caption" tone="muted">
                        {result.detail}
                      </AppText>
                    </View>
                    {keys.has(subjectKey(result.subject)) ? (
                      <Symbol name="checkmark.circle.fill" size={20} tint={color.ember} />
                    ) : (
                      <Symbol name="circle" size={20} tint={color.muted} />
                    )}
                  </Pressable>
                ))
              : [
                  <View key="none" style={styles.row}>
                    <AppText
                      role="secondary"
                      tone="muted"
                    >{`Nobody in ${teamName} matches “${debounced}”.`}</AppText>
                  </View>,
                ]
            : [
                <ReadState
                  error={results.error}
                  key="state"
                  onRetry={results.reload}
                  team={teamName}
                />,
              ]}
        </RowGroup>
      ) : (
        <AppText
          role="caption"
          tone="muted"
        >{`Search the people and groups in ${teamName}.`}</AppText>
      )}
      <PrimaryButton
        disabled={picked.length === 0 || revision.data === null}
        label={
          picked.length === 1
            ? `Review adding ${picked[0]!.name}`
            : `Review adding ${picked.length}`
        }
        onPress={() =>
          void confirmAccessChange({
            team,
            teamName,
            revision: revision.data ?? 0,
            changes,
            title: props.target === "project" ? `Add at ${levelLabel(level)}?` : "Add to group?",
            confirm: "Add",
            onDone: () => navigation.goBack(),
          })
        }
      />
    </>
  );
}

async function search(team: TeamAccess, target: "project" | "group", id: string, query: string) {
  if (target === "project") {
    const found = await team.directory({ workspaceId: id, query, limit: 12 });
    return [
      ...found.groups.map((group) => ({
        subject: { kind: "group", groupId: group.id } as Subject,
        name: group.name,
        detail: group.builtin ? "Every member" : "Group",
      })),
      ...found.people.map((person) => ({
        subject: { kind: "person", userId: person.id } as Subject,
        name: person.name,
        detail: "Person",
      })),
    ];
  }
  const [people, groups] = await Promise.all([
    team.people({ query, state: "active", limit: 10 }),
    team.groups({ query, limit: 10 }),
  ]);
  return [
    ...groups.items
      .filter((group) => group.id !== id && !group.builtin)
      .map((group) => ({
        subject: { kind: "group", groupId: group.id } as Subject,
        name: group.name,
        detail: `Group · ${peopleCount(group.effectivePeopleCount)}`,
      })),
    ...people.items.map((person) => ({
      subject: { kind: "person", userId: person.id } as Subject,
      name: person.name,
      detail: person.email,
    })),
  ];
}

/* ---- How a Project runs ---- */

export function TeamProjectRuntimeScreen({
  route,
}: DeploymentProps<{ readonly workspaceId: string }>) {
  return (
    <TeamScreen deploymentId={route.params.deploymentId} title="How it runs">
      {(hostClient) => <Runtime hostClient={hostClient} workspaceId={route.params.workspaceId} />}
    </TeamScreen>
  );
}

function Runtime(props: {
  readonly hostClient: HostClient;
  readonly workspaceId: string;
}): ReactNode {
  const navigation = useNavigation();
  const { team, summary } = useTeam(props.hostClient);
  const teamName = summary?.team.name ?? "the team";
  const read = useHostRead(
    team
      ? () =>
          Promise.all([
            team.projectSettings(props.workspaceId),
            team.runtimeChoices(props.workspaceId),
            team.projectAccess({ workspaceId: props.workspaceId, limit: 1 }),
          ])
      : null,
    `team-runtime:${props.workspaceId}`,
  );
  const [form, setForm] = useState<{
    instance: string;
    model: string;
    access: ThreadAccessMode;
    instructions: string;
    timeZone: string;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const data = read.data;
  useEffect(() => {
    if (!data || form) return;
    const settings = data[0].settings;
    setForm({
      instance: settings?.harnessInstanceId ?? data[1].instances[0]?.id ?? "",
      model: settings
        ? `${settings.modelSelection.providerId}/${settings.modelSelection.modelId}`
        : "",
      access: settings?.accessMode ?? "approval-required",
      instructions: settings?.instructions ?? "",
      timeZone: settings?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  }, [data, form]);
  if (!team || !data || !form)
    return (
      <RowGroup>
        {[<ReadState error={read.error} key="state" onRetry={read.reload} team={teamName} />]}
      </RowGroup>
    );
  const [current, choices, access] = data;
  const instance = choices.instances.find(({ id }) => id === form.instance) ?? null;
  const model = instance?.models.find((m) => `${m.providerId}/${m.modelId}` === form.model) ?? null;
  const problem = runtimeStateText(current.runtime);
  return (
    <>
      {current.settings === null ? (
        <View style={styles.banner}>
          <AppText role="bodyMedium">Not set up yet.</AppText>
          <AppText
            role="secondary"
            tone="soft"
          >{`Choose an engine and model before ${access.project.name} can run tasks.`}</AppText>
        </View>
      ) : problem ? (
        <View style={styles.banner}>
          <AppText role="bodyMedium">{`${access.project.name} can’t run tasks right now.`}</AppText>
          <AppText role="secondary" tone="soft">
            {problem}
          </AppText>
        </View>
      ) : null}
      <RowGroup>
        {[
          <View key="engine" style={styles.row}>
            <View style={styles.grow}>
              <AppText role="body">Engine</AppText>
            </View>
            <ChoiceMenu
              accessibilityLabel="Engine"
              choices={choices.instances.map(({ id, name }) => ({ id, title: name }))}
              label={instance?.name ?? "Choose"}
              onChoose={(id) => setForm({ ...form, instance: id, model: "" })}
            />
          </View>,
          <View key="model" style={styles.row}>
            <View style={styles.grow}>
              <AppText role="body">Model</AppText>
            </View>
            <ChoiceMenu
              accessibilityLabel="Model"
              choices={(instance?.models ?? []).map((m) => ({
                id: `${m.providerId}/${m.modelId}`,
                title: m.modelId,
              }))}
              label={model?.modelId ?? "Choose"}
              onChoose={(id) => setForm({ ...form, model: id })}
            />
          </View>,
          <View key="access" style={styles.row}>
            <View style={styles.grow}>
              <AppText role="body">Without asking</AppText>
              <AppText role="caption" tone="muted">
                {accessModeOptions.find(({ mode }) => mode === form.access)?.description ?? ""}
              </AppText>
            </View>
            <ChoiceMenu
              accessibilityLabel="What agents may do without asking"
              choices={accessModeOptions.map(({ mode, label }) => ({ id: mode, title: label }))}
              label={accessModeOptions.find(({ mode }) => mode === form.access)?.label ?? ""}
              onChoose={(id) => setForm({ ...form, access: id as ThreadAccessMode })}
            />
          </View>,
        ]}
      </RowGroup>
      <Field
        hint={`Everyone who can use ${access.project.name} works with these.`}
        input={{
          multiline: true,
          onChangeText: (instructions) => setForm({ ...form, instructions }),
          placeholder: `What should ${access.project.name}’s agent always know?`,
          value: form.instructions,
        }}
        label="Instructions"
      />
      <Field
        hint="A place name such as Europe/London."
        input={{
          autoCapitalize: "none",
          autoCorrect: false,
          onChangeText: (timeZone) => setForm({ ...form, timeZone }),
          value: form.timeZone,
        }}
        label="Time zone"
      />
      {current.can.edit.allowed ? (
        <PrimaryButton
          busy={pending}
          disabled={!instance || !model}
          label={current.settings ? "Save changes" : "Set up"}
          onPress={() => {
            if (!instance || !model) return;
            setPending(true);
            team
              .setProjectSettings(
                access.accessRevision,
                props.workspaceId,
                current.settings?.revision ?? null,
                {
                  harnessInstanceId: HarnessInstanceIdSchema.parse(instance.id),
                  modelSelection: {
                    modelId: model.modelId,
                    options: model.options,
                    providerId: model.providerId,
                  },
                  accessMode: form.access,
                  instructions: form.instructions,
                  timeZone: form.timeZone.trim(),
                },
              )
              .then(() => navigation.goBack())
              .catch((error: unknown) => showError(error, teamName))
              .finally(() => setPending(false));
          }}
        />
      ) : null}
    </>
  );
}
