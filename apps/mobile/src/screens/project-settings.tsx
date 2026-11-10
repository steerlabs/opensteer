import {
  canRespondToRequests,
  mutationIdempotencyKey,
  pluginAvailableIn,
  pluginSummaries,
  pluginVersionLabel,
  sameStableHostSnapshot,
  specialistModels,
  unwrapRpcResult,
  type HostClient,
  type HostSnapshot,
  type PluginSummary,
  type WorkspaceMemberSummary,
  type WorkspaceSummary,
} from "@opensteer/client/host";
import { useHostRead, useHostSnapshot, type HostRead } from "@opensteer/client/react";
import { WorkspaceIdSchema, type SpecialistRegistration } from "@opensteer/core";
import { useFocusEffect, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import { color, radius, space, touchTarget } from "../theme.js";
import { ChoiceMenu } from "../ui/choice-menu.js";
import {
  AppText,
  CodeBlock,
  Notice,
  RowGroup,
  SecondaryButton,
  SectionLabel,
  Toggle,
} from "../ui/primitives.js";
import { Screen, useListContentInsets, useReadingColumn } from "../ui/screen.js";
import { Symbol, type SFSymbolName } from "../ui/symbol.js";
import { WorkspaceMark } from "../ui/workspace-mark.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";
import { ProjectHealthNotice } from "./project-health.js";
import { memberInitials } from "./project-settings-model.js";
import { useTeam } from "@opensteer/client/react";
import {
  TeamMarker,
  TeamProjectSection,
  useTeamProjectAccess,
} from "../team/team-project-section.js";

export type ProjectSettingsScreenProps = StaticScreenProps<{
  readonly deploymentId: string;
  readonly workspaceId: string;
}>;

/** The accounts this Project may use, as Access lists them. */
function readGrants(hostClient: HostClient, workspaceId: string) {
  return hostClient.rpc["integration.grants.list"]({ workspaceId })
    .then(unwrapRpcResult)
    .then(({ grants }) => grants.filter(({ status }) => status === "active"));
}
type ProjectGrant = Awaited<ReturnType<typeof readGrants>>[number];

/** Where the screen sends the person for what the phone cannot do inline. */
interface Destinations {
  readonly allPlugins: () => void;
  readonly browserProfiles: () => void;
  readonly connections: () => void;
}

/**
 * A Project's settings, as the web's: who is in it, what it may use beyond
 * its own folder, which plugins run here, the specialists agents added, its
 * mute, and its deletion. Each section reads on its own, so one slow or
 * refused read never holds the others, and nothing is read before the screen
 * is open: Chat and the sidebar never wait on any of it.
 */
export function ProjectSettingsScreen(props: ProjectSettingsScreenProps): ReactNode {
  const { deploymentId, workspaceId } = props.route.params;
  const hostClient = useAttachedHost(deploymentId);
  if (hostClient === null) return <DeploymentGate deploymentId={deploymentId} />;
  return (
    <ProjectSettings
      deploymentId={deploymentId}
      hostClient={hostClient}
      key={`${deploymentId}:${workspaceId}`}
      workspaceId={workspaceId}
    />
  );
}

function ProjectSettings(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
  readonly workspaceId: string;
}): ReactNode {
  const { deploymentId, hostClient, workspaceId } = props;
  const navigation = useNavigation();
  const column = useReadingColumn();
  const insets = useListContentInsets(space[32]);
  const { snapshot } = useHostSnapshot(hostClient, sameStableHostSnapshot);
  const workspace = snapshot.workspaces.find(({ id }) => id === workspaceId) ?? null;
  const project = workspace?.kind === "project" ? workspace : null;
  const userId = snapshot.user?.id ?? null;
  const administrator = snapshot.user?.instanceRole === "administrator";
  const connected = canRespondToRequests(snapshot);
  const readable = project !== null && userId !== null;
  const teamProject = snapshot.teamAdministrationAvailable === true;
  const teamAccess = useTeamProjectAccess(hostClient, workspaceId);
  const teamName = useTeam(hostClient).summary?.team.name ?? "the team";

  const members = useHostRead(
    readable && !teamProject
      ? () => hostClient.rpc["workspace.members.list"]({ workspaceId }).then(unwrapRpcResult)
      : null,
    `members:${workspaceId}:${userId}`,
  );
  const grants = useHostRead<readonly ProjectGrant[]>(
    readable ? () => readGrants(hostClient, workspaceId) : null,
    `grants:${workspaceId}:${userId}`,
  );
  const owner =
    members.data?.members.some(
      (member) => member.userId === userId && member.role === "owner" && member.state === "active",
    ) ?? false;

  // Coming back from Connections or Browser profiles is how access changes
  // from here, so what was allowed is read again on return.
  const reloadGrants = grants.reload;
  const reloadMembers = members.reload;
  useReadAgainOnReturn(
    useCallback(() => {
      reloadGrants();
      reloadMembers();
    }, [reloadGrants, reloadMembers]),
  );

  useLayoutEffect(() => {
    navigation.setOptions({ title: "Project settings" });
  }, [navigation]);

  const destinations = useMemo<Destinations>(
    () => ({
      allPlugins: () => navigation.navigate("Plugins", { deploymentId }),
      browserProfiles: () => navigation.navigate("BrowserProfiles", { deploymentId }),
      connections: () => navigation.navigate("ConnectedApps", { deploymentId }),
    }),
    [deploymentId, navigation],
  );

  if (project === null && teamProject) {
    const view = teamAccess.data;
    return (
      <Screen edgeToEdge>
        <ScrollView
          contentContainerStyle={[styles.content, column, insets]}
          contentInsetAdjustmentBehavior="automatic"
        >
          {view ? (
            <View style={styles.identity}>
              <WorkspaceMark color={view.project.color} icon={null} name={view.project.name} />
              <View style={styles.grow}>
                <AppText role="title">{view.project.name}</AppText>
                <AppText role="secondary" tone="muted">
                  {view.audience.myLevel
                    ? `A shared project in ${teamName}.`
                    : `A shared project in ${teamName}. You can see who is on it, not its chats or files.`}
                </AppText>
                <TeamMarker access={view} teamName={teamName} />
              </View>
            </View>
          ) : null}
          <TeamProjectSection
            access={teamAccess}
            deploymentId={deploymentId}
            hostClient={hostClient}
            viewerId={userId}
          />
        </ScrollView>
      </Screen>
    );
  }

  if (project === null) {
    return (
      <Screen>
        <View style={styles.centred}>
          {snapshot.workspaces.length === 0 ? (
            <ActivityIndicator color={color.muted} />
          ) : (
            <Notice
              detail="It may have been deleted, or it belongs to another deployment."
              title="This project is not here"
              tone="neutral"
            />
          )}
        </View>
      </Screen>
    );
  }

  return (
    <Screen edgeToEdge>
      <ScrollView
        contentContainerStyle={[styles.content, column, insets]}
        contentInsetAdjustmentBehavior="automatic"
      >
        <View style={styles.identity}>
          <WorkspaceMark color={project.color} icon={project.icon} name={project.name} />
          <View style={styles.grow}>
            <AppText role="title">{project.name}</AppText>
            <AppText role="secondary" tone="muted">
              {[
                project.machineName === null
                  ? "Its folder is in Main."
                  : `Its folder is in Main on ${project.machineName}.`,
                teamProject
                  ? null
                  : owner
                    ? "You own this project."
                    : members.data === null
                      ? null
                      : "An owner decides who joins it and what it can use.",
              ]
                .filter(Boolean)
                .join(" ")}
            </AppText>
          </View>
        </View>

        {connected ? null : (
          <Notice
            detail="This screen shows what it last read, and changes wait until it’s back."
            title="Opensteer can’t be reached right now"
            tone="neutral"
          />
        )}
        <ProjectHealthNotice
          connected={connected}
          hostClient={hostClient}
          owner={owner}
          workspace={project}
        />

        {teamAccess.data ? <TeamMarker access={teamAccess.data} teamName={teamName} /> : null}
        {teamProject ? (
          <TeamProjectSection
            access={teamAccess}
            deploymentId={deploymentId}
            hostClient={hostClient}
            viewerId={userId}
          />
        ) : null}
        {teamProject ? null : (
          <PeopleSection
            connected={connected}
            hostClient={hostClient}
            members={members}
            owner={owner}
            sharing={snapshot.workspaceSharingAvailable}
            userId={userId}
            workspace={project}
          />
        )}
        <AccessSection
          destinations={destinations}
          grants={grants}
          snapshot={snapshot}
          workspace={project}
        />
        <PluginsSection
          administrator={administrator}
          canChange={connected && (owner || administrator)}
          destinations={destinations}
          hostClient={hostClient}
          workspace={project}
        />
        <SpecialistsSection
          connected={connected}
          hostClient={hostClient}
          userId={userId}
          workspace={project}
        />

        {project.status === "ready" ? (
          <MuteSection
            connected={connected}
            hostClient={hostClient}
            muted={(snapshot.notificationMutes ?? []).includes(project.id)}
            workspace={project}
          />
        ) : null}
        {/* The Host lets only an active owner delete a Project. */}
        {project.status === "ready" && owner ? (
          <DeleteSection
            connected={connected}
            hostClient={hostClient}
            onDeleted={() => navigation.navigate("Projects", { deploymentId })}
            workspace={project}
          />
        ) : null}
      </ScrollView>
    </Screen>
  );
}

/** Runs `refresh` each time the screen is shown again, not on its first showing. */
function useReadAgainOnReturn(refresh: () => void): void {
  const shown = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (shown.current) refresh();
      shown.current = true;
    }, [refresh]),
  );
}

/* ---- People ---- */

function PeopleSection(props: {
  readonly connected: boolean;
  readonly hostClient: HostClient;
  readonly members: HostRead<{ readonly members: readonly WorkspaceMemberSummary[] }>;
  readonly owner: boolean;
  readonly sharing: boolean;
  readonly userId: string | null;
  readonly workspace: WorkspaceSummary;
}): ReactNode {
  const { connected, hostClient, members, owner, userId, workspace } = props;
  const manages = owner && props.sharing;
  const invitations = useHostRead(
    manages
      ? () =>
          hostClient.rpc["workspace.invitations.list"]({ workspaceId: workspace.id })
            .then(unwrapRpcResult)
            .then(({ invitations }) =>
              invitations.filter(
                ({ acceptedAt, revokedAt }) => acceptedAt === null && revokedAt === null,
              ),
            )
      : null,
    `invitations:${workspace.id}`,
  );
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  const run = (key: string, action: () => Promise<unknown>, after: () => void): void => {
    if (pending !== null) return;
    setPending(key);
    setFailure(null);
    void action()
      .then(after)
      .catch((error: unknown) => setFailure(operationDetail(error, "That change didn’t save.")))
      .finally(() => setPending(null));
  };

  const invite = (role: "collaborator" | "owner"): void =>
    run(
      "invite",
      async () => {
        const result = await hostClient.dispatch({
          idempotencyKey: mutationIdempotencyKey(`workspace-invitation:${workspace.id}`),
          role,
          type: "workspace.invitation.create",
          workspaceId: workspace.id,
        });
        if (result.type !== "workspace.invitation.create") {
          throw new Error("Workspace invitation command mismatch.");
        }
        setInviteUrl(result.invitationUrl);
        // The share sheet is how a link leaves a phone; dismissing it keeps the link here.
        await Share.share({ message: result.invitationUrl }).catch(() => undefined);
      },
      invitations.reload,
    );

  const update = (member: WorkspaceMemberSummary, change: "owner" | "collaborator" | "remove") => {
    const apply = () =>
      run(
        `member:${member.userId}`,
        () =>
          hostClient.dispatch({
            idempotencyKey: mutationIdempotencyKey(`workspace-member:${member.userId}`),
            ...(change === "remove" ? { state: "revoked" as const } : { role: change }),
            type: "workspace.member.update",
            userId: member.userId,
            workspaceId: workspace.id,
          }),
        members.reload,
      );
    if (change !== "remove") {
      apply();
      return;
    }
    Alert.alert(
      `Remove ${member.displayName}?`,
      `They lose access to ${workspace.name}: its files, chat and tasks. Work they started stays.`,
      [
        { style: "cancel", text: "Cancel" },
        { onPress: apply, style: "destructive", text: "Remove" },
      ],
    );
  };

  const active = members.data?.members.filter((member) => member.state === "active") ?? null;
  return (
    <Section
      footer={
        owner
          ? "Everyone here can see its files, chat and tasks, and start work in it. Your own accounts and computers stay yours unless you allow them below."
          : "Everyone here can see its files, chat and tasks, and start work in it. An owner decides who joins."
      }
      label="People"
    >
      <RowGroup>
        {[
          ...(active === null
            ? [
                <ReadState
                  error={members.error}
                  key="state"
                  onRetry={members.reload}
                  what="who is in this project"
                />,
              ]
            : active.map((member) => (
                <View key={member.id} style={styles.row}>
                  <View style={styles.avatar}>
                    <Text allowFontScaling={false} style={styles.avatarText}>
                      {memberInitials(member.displayName)}
                    </Text>
                  </View>
                  <View style={styles.grow}>
                    <AppText numberOfLines={1} role="body">
                      {member.userId === userId
                        ? `${member.displayName} (you)`
                        : member.displayName}
                    </AppText>
                    <AppText numberOfLines={1} role="caption" tone="muted">
                      {member.email}
                    </AppText>
                  </View>
                  {manages && member.userId !== userId ? (
                    <ChoiceMenu
                      accessibilityLabel={`${member.displayName}: ${roleName(member.role)}. Change`}
                      busy={pending === `member:${member.userId}`}
                      choices={[
                        member.role === "owner"
                          ? { id: "collaborator", title: "Make Can work" }
                          : { id: "owner", title: "Make Owner" },
                        { destructive: true, id: "remove", title: "Remove from project" },
                      ]}
                      disabled={!connected || pending !== null}
                      label={roleName(member.role)}
                      onChoose={(id) => {
                        if (id === "owner" || id === "collaborator" || id === "remove") {
                          update(member, id);
                        }
                      }}
                    />
                  ) : (
                    <AppText role="caption" tone="muted">
                      {roleName(member.role)}
                    </AppText>
                  )}
                </View>
              ))),
          manages ? (
            <View key="invite" style={styles.row}>
              <View style={styles.grow}>
                <AppText role="body">Invite someone</AppText>
                <AppText role="caption" tone="muted">
                  Makes a link to send them. It works once, for a week.
                </AppText>
              </View>
              <ChoiceMenu
                accessibilityLabel="Invite someone"
                busy={pending === "invite"}
                choices={[
                  { id: "collaborator", title: "Invite to work in it" },
                  { id: "owner", title: "Invite as an owner" },
                ]}
                disabled={!connected || pending !== null}
                label="Share link"
                onChoose={(id) => invite(id === "owner" ? "owner" : "collaborator")}
              />
            </View>
          ) : null,
        ]}
      </RowGroup>
      {inviteUrl === null ? null : <CodeBlock label="Invite link" text={inviteUrl} />}
      {manages && (invitations.data?.length ?? 0) > 0 ? (
        <View style={styles.subsection}>
          <SectionLabel>Invite links not used yet</SectionLabel>
          <RowGroup>
            {(invitations.data ?? []).map((invitation) => (
              <View key={invitation.id} style={styles.row}>
                <View style={styles.grow}>
                  <AppText role="body">
                    {invitation.role === "owner" ? "Owner link" : "Can-work link"}
                  </AppText>
                  <AppText role="caption" tone="muted">
                    {`Expires ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
                      new Date(invitation.expiresAt),
                    )}`}
                  </AppText>
                </View>
                <SecondaryButton
                  busy={pending === `invite:${invitation.id}`}
                  compact
                  disabled={!connected || pending !== null}
                  label="Revoke"
                  onPress={() =>
                    run(
                      `invite:${invitation.id}`,
                      () =>
                        hostClient.dispatch({
                          idempotencyKey: mutationIdempotencyKey(
                            `workspace-invitation:${invitation.id}`,
                          ),
                          invitationId: invitation.id,
                          type: "workspace.invitation.revoke",
                          workspaceId: workspace.id,
                        }),
                      invitations.reload,
                    )
                  }
                  tone="danger"
                />
              </View>
            ))}
          </RowGroup>
        </View>
      ) : null}
      <ErrorLine detail={failure} />
    </Section>
  );
}

function roleName(role: WorkspaceMemberSummary["role"]): string {
  return role === "owner" ? "Owner" : "Can work";
}

/* ---- Access ---- */

function AccessSection(props: {
  readonly destinations: Destinations;
  readonly grants: HostRead<readonly ProjectGrant[]>;
  readonly snapshot: Pick<HostSnapshot, "browserProfileGrants" | "browserProfiles">;
  readonly workspace: WorkspaceSummary;
}): ReactNode {
  const { destinations, grants, snapshot, workspace } = props;
  const profiles = snapshot.browserProfileGrants
    .filter((grant) => grant.workspaceId === workspace.id)
    .map((grant) => ({
      grant,
      name:
        snapshot.browserProfiles.find((profile) => profile.id === grant.profileId)?.name ??
        "Browser profile",
    }));
  const empty = grants.data !== null && grants.data.length === 0 && profiles.length === 0;
  return (
    <Section
      footer="A project works in its own folder and uses only the accounts, apps and browsers allowed here. Agents ask from a task when they need more."
      label="Access"
    >
      <RowGroup>
        {[
          ...(grants.data === null
            ? [
                <ReadState
                  error={grants.error}
                  key="state"
                  onRetry={grants.reload}
                  what="this project’s access"
                />,
              ]
            : empty
              ? [
                  <View key="empty" style={styles.row}>
                    <AppText role="secondary" tone="muted">
                      Nothing is allowed yet.
                    </AppText>
                  </View>,
                ]
              : [
                  ...grants.data.map((grant) => (
                    <FactRow
                      detail={grant.access === "read" ? "Read only" : "Read and make changes"}
                      key={grant.id}
                      symbol="key"
                      title={grant.isDefault ? `${grant.alias} (default)` : grant.alias}
                    />
                  )),
                  ...profiles.map(({ grant, name }) => (
                    <FactRow
                      detail={`Browser profile · ${
                        grant.access === "read" ? "Read only" : "Can sign in and act"
                      }`}
                      key={grant.id}
                      symbol="globe"
                      title={name}
                    />
                  )),
                ]),
          <LinkRow
            key="connections"
            label="Accounts in Connections"
            onPress={destinations.connections}
          />,
          <LinkRow
            key="profiles"
            label="Browser profiles"
            onPress={destinations.browserProfiles}
          />,
        ]}
      </RowGroup>
    </Section>
  );
}

/* ---- Plugins ---- */

function PluginsSection(props: {
  readonly administrator: boolean;
  readonly canChange: boolean;
  readonly destinations: Destinations;
  readonly hostClient: HostClient;
  readonly workspace: WorkspaceSummary;
}): ReactNode {
  const { canChange, hostClient, workspace } = props;
  const plugins = useHostRead(
    () =>
      hostClient.rpc["plugin.list"]({ workspaceId: WorkspaceIdSchema.parse(workspace.id) }).then(
        (result) =>
          pluginSummaries(unwrapRpcResult(result).plugins).filter((plugin) =>
            pluginAvailableIn(plugin, workspace.id),
          ),
      ),
    `plugins:${workspace.id}`,
  );
  // The switch shows where it was moved to until the Host's answer is read back.
  const [pending, setPending] = useState<{ readonly id: string; readonly on: boolean } | null>(
    null,
  );
  const [failure, setFailure] = useState<string | null>(null);
  const toggle = (plugin: PluginSummary, active: boolean): void => {
    if (pending !== null) return;
    setPending({ id: plugin.id, on: active });
    setFailure(null);
    void hostClient
      .dispatch({
        active,
        idempotencyKey: mutationIdempotencyKey(`plugin-activation:${plugin.id}:${workspace.id}`),
        pluginId: plugin.id,
        type: "plugin.activation.set",
        workspaceId: WorkspaceIdSchema.parse(workspace.id),
      })
      .then(plugins.reload)
      .catch((error: unknown) =>
        setFailure(operationDetail(error, `${plugin.name} didn’t change. Try again.`)),
      )
      .finally(() => setPending(null));
  };
  const list = plugins.data;
  return (
    <Section
      action={
        props.administrator ? (
          <SecondaryButton compact label="All plugins" onPress={props.destinations.allPlugins} />
        ) : null
      }
      footer={
        list !== null && list.length > 0 && !canChange
          ? "Only an owner of this project can turn plugins on or off."
          : "Skills and tools agents get in this project. Turning one on here leaves Main and other projects as they are."
      }
      label="Plugins"
    >
      <RowGroup>
        {list === null
          ? [
              <ReadState
                error={plugins.error}
                key="state"
                onRetry={plugins.reload}
                what="plugins"
              />,
            ]
          : list.length === 0
            ? [
                <View key="empty" style={styles.row}>
                  <AppText role="secondary" tone="muted">
                    {props.administrator
                      ? "No plugins are installed. Install one from All plugins."
                      : "No plugins are installed."}
                  </AppText>
                </View>,
              ]
            : list.map((plugin) => {
                const on =
                  pending?.id === plugin.id ? pending.on : plugin.activeIn.includes(workspace.id);
                const tags = [
                  plugin.specialist ? "Specialist" : null,
                  plugin.scope === "workspace" ? "Added here" : null,
                ].filter(Boolean);
                return (
                  <View key={plugin.id} style={styles.row}>
                    <Tile symbol="puzzlepiece.extension" />
                    <View style={styles.grow}>
                      <AppText numberOfLines={1} role="body">
                        {plugin.name}
                      </AppText>
                      <AppText numberOfLines={2} role="caption" tone="muted">
                        {[...tags, plugin.description ?? pluginVersionLabel(plugin)].join(" · ")}
                      </AppText>
                    </View>
                    <Toggle
                      accessibilityLabel={`${plugin.name} on in ${workspace.name}`}
                      disabled={!canChange || pending !== null}
                      onChange={(value) => toggle(plugin, value)}
                      value={on}
                    />
                  </View>
                );
              })}
      </RowGroup>
      <ErrorLine detail={failure} />
    </Section>
  );
}

/* ---- Specialists ---- */

function SpecialistsSection(props: {
  readonly connected: boolean;
  readonly hostClient: HostClient;
  readonly userId: string | null;
  readonly workspace: WorkspaceSummary;
}): ReactNode {
  const { hostClient, workspace } = props;
  const specialists = useHostRead(
    () =>
      hostClient.rpc["specialist.list"]({ workspaceId: WorkspaceIdSchema.parse(workspace.id) })
        .then(unwrapRpcResult)
        .then(({ specialists }) => specialists),
    `specialists:${workspace.id}`,
  );
  const list = specialists.data ?? undefined;
  useReadAgainOnReturn(specialists.reload);

  // Agents add specialists as work calls for them; with none, there is nothing to set here.
  if (list?.length === 0) return null;
  return (
    <Section
      footer="Agents added these to hand parts of their work to. Each runs on its own models and can use what this project can."
      label="Specialists"
    >
      {list === undefined ? (
        <RowGroup>
          {[
            <ReadState
              error={specialists.error}
              key="state"
              onRetry={specialists.reload}
              what="this project’s specialists"
            />,
          ]}
        </RowGroup>
      ) : (
        list.map((registration) => (
          <SpecialistCard
            connected={props.connected}
            hostClient={hostClient}
            key={registration.id}
            mine={registration.ownerUserId === props.userId}
            onReread={specialists.reload}
            registration={registration}
            workspace={workspace}
          />
        ))
      )}
    </Section>
  );
}

function SpecialistCard(props: {
  readonly connected: boolean;
  readonly hostClient: HostClient;
  readonly mine: boolean;
  readonly onReread: () => void;
  readonly registration: SpecialistRegistration;
  readonly workspace: WorkspaceSummary;
}): ReactNode {
  const { hostClient, registration, workspace } = props;
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const workspaceId = WorkspaceIdSchema.parse(workspace.id);
  const models = specialistModels(registration);

  const run = (key: string, action: () => Promise<void>): void => {
    if (pending !== null) return;
    setPending(key);
    setFailure(null);
    void action()
      .catch((error: unknown) => setFailure(operationDetail(error, "That didn’t save. Try again.")))
      .finally(() => setPending(null));
  };
  const remove = () =>
    Alert.alert(
      `Remove ${registration.plugin}?`,
      `Agents in ${workspace.name} stop handing work to it. Its plugin stays installed and on here, and work it already did stays in its tasks.`,
      [
        { style: "cancel", text: "Cancel" },
        {
          onPress: () =>
            run("remove", async () => {
              await hostClient.dispatch({
                idempotencyKey: mutationIdempotencyKey(`specialist-remove:${registration.id}`),
                specialistId: registration.id,
                type: "specialist.remove",
                workspaceId,
              });
              props.onReread();
            }),
          style: "destructive",
          text: "Remove specialist",
        },
      ],
    );

  const ready = registration.status === "ready";
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <Tile symbol="sparkles" />
        <View style={styles.grow}>
          <View style={styles.titleLine}>
            <AppText numberOfLines={1} role="bodyMedium" style={styles.shrink}>
              {registration.plugin}
            </AppText>
            <View style={[styles.pill, ready ? styles.pillReady : styles.pillPending]}>
              <AppText role="caption" style={ready ? styles.readyText : styles.pendingText}>
                {ready
                  ? "Ready"
                  : registration.status === "pending"
                    ? "Needs setup"
                    : registration.status === "removing"
                      ? "Removing"
                      : "Removal failed"}
              </AppText>
            </View>
          </View>
          <AppText role="caption" tone="muted">
            {`Uses ${registration.ownerName ?? (props.mine ? "your" : "another member’s")} accounts. ${registration.canUse === false ? "Unavailable to you. " : ""}Runs on ${models.join(", then ")}${
              registration.fallback === "caller" ? ", or the model of the task that asks" : ""
            }.`}
          </AppText>
        </View>
        {props.mine ? (
          <SecondaryButton
            busy={pending === "remove"}
            compact
            disabled={!props.connected || pending !== null}
            label={
              registration.status === "removal-failed" || registration.status === "removing"
                ? "Retry removal"
                : "Remove"
            }
            onPress={remove}
            tone="danger"
          />
        ) : null}
      </View>
      {failure === null ? null : (
        <View style={styles.accessRow}>
          <ErrorLine detail={failure} />
        </View>
      )}
      {props.mine ? null : (
        <View style={styles.accessRow}>
          <AppText role="caption" tone="muted">
            Another member added this. Only they can change it.
          </AppText>
        </View>
      )}
    </View>
  );
}

function MuteSection(props: {
  readonly connected: boolean;
  readonly hostClient: HostClient;
  readonly muted: boolean;
  readonly workspace: WorkspaceSummary;
}): ReactNode {
  const [pending, setPending] = useState<boolean | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const muted = pending ?? props.muted;
  return (
    <Section label="Notifications">
      <RowGroup>
        {[
          <View key="mute" style={styles.row}>
            <View style={styles.grow}>
              <AppText role="body">Mute this project</AppText>
              <AppText role="caption" tone="muted">
                {muted
                  ? "Its own conversations and tasks don’t notify you. Approvals and questions still do, and its work keeps running."
                  : "Silences its own conversations and tasks. Approvals and questions still notify you."}
              </AppText>
            </View>
            <Toggle
              accessibilityLabel={`Mute notifications from ${props.workspace.name}`}
              disabled={!props.connected || pending !== null}
              onChange={(next) => {
                setPending(next);
                setFailure(null);
                void props.hostClient
                  .setWorkspaceNotificationMute(props.workspace.id, next)
                  .catch((error: unknown) =>
                    setFailure(operationDetail(error, "That notification setting didn’t save.")),
                  )
                  .finally(() => setPending(null));
              }}
              value={muted}
            />
          </View>,
        ]}
      </RowGroup>
      <ErrorLine detail={failure} />
    </Section>
  );
}

function DeleteSection(props: {
  readonly connected: boolean;
  readonly hostClient: HostClient;
  readonly onDeleted: () => void;
  readonly workspace: WorkspaceSummary;
}): ReactNode {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { workspace } = props;
  const confirm = () =>
    Alert.alert(
      `Delete ${workspace.name}?`,
      "Everyone in it loses access now. Its folder, chat and tasks are kept for a while, and an owner can keep the project until then.",
      [
        { style: "cancel", text: "Cancel" },
        {
          onPress: () => {
            setPending(true);
            setFailure(null);
            void props.hostClient
              .dispatch({
                idempotencyKey: mutationIdempotencyKey(`workspace.delete:${workspace.id}`),
                type: "workspace.delete",
                workspaceId: workspace.id,
              })
              .then(props.onDeleted)
              .catch((error: unknown) => {
                setFailure(operationDetail(error, "The project wasn’t deleted. Try again."));
                setPending(false);
              });
          },
          style: "destructive",
          text: "Delete project",
        },
      ],
    );
  return (
    <Section
      footer="Its folder, chat and tasks are kept for a while, then removed for good. You can bring it back until then."
      label="Delete project"
    >
      <View style={styles.actionStart}>
        <SecondaryButton
          busy={pending}
          disabled={!props.connected || pending}
          label="Delete project…"
          onPress={confirm}
          tone="danger"
        />
      </View>
      <ErrorLine detail={failure} />
    </Section>
  );
}

/* ---- Shared rows ---- */

function Section(props: {
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly footer?: string;
  readonly label: string;
}): ReactNode {
  return (
    <View style={styles.section}>
      <View accessibilityRole="header" style={styles.sectionHead}>
        <View style={styles.grow}>
          <SectionLabel>{props.label}</SectionLabel>
        </View>
        {props.action ?? null}
      </View>
      {props.children}
      {props.footer === undefined ? null : (
        <AppText role="caption" tone="muted">
          {props.footer}
        </AppText>
      )}
    </View>
  );
}

/**
 * A section's read before it answers: a spinner, or what could not be read
 * and the way to read it again. Never an empty list, which would claim there
 * is nothing.
 */
function ReadState(props: {
  readonly error: unknown;
  readonly onRetry: () => void;
  readonly what: string;
}): ReactNode {
  if (props.error === null || props.error === undefined) {
    return (
      <View accessibilityLabel={`Loading ${props.what}`} style={styles.row}>
        <ActivityIndicator color={color.muted} size="small" />
      </View>
    );
  }
  return (
    <View style={styles.row}>
      <View style={styles.grow}>
        <AppText role="secondary" tone="danger">
          {`Couldn’t read ${props.what}.`}
        </AppText>
        <AppText role="caption" tone="muted">
          {operationDetail(props.error, "Check the connection and try again.")}
        </AppText>
      </View>
      <SecondaryButton compact label="Try again" onPress={props.onRetry} />
    </View>
  );
}

function FactRow(props: {
  readonly detail: string;
  readonly symbol: SFSymbolName;
  readonly title: string;
}): ReactNode {
  return (
    <View accessible accessibilityLabel={`${props.title}, ${props.detail}`} style={styles.row}>
      <Tile symbol={props.symbol} />
      <View style={styles.grow}>
        <AppText numberOfLines={1} role="body">
          {props.title}
        </AppText>
        <AppText role="caption" tone="muted">
          {props.detail}
        </AppText>
      </View>
    </View>
  );
}

function LinkRow(props: { readonly label: string; readonly onPress: () => void }): ReactNode {
  return (
    <View style={styles.linkRow}>
      <SecondaryButton compact label={props.label} onPress={props.onPress} />
    </View>
  );
}

function Tile(props: { readonly symbol: SFSymbolName }): ReactNode {
  return (
    <View style={styles.tile}>
      <Symbol name={props.symbol} size={15} tint={color.textSoft} />
    </View>
  );
}

function ErrorLine(props: { readonly detail: string | null }): ReactNode {
  return props.detail === null ? null : (
    <View accessibilityLiveRegion="assertive" accessibilityRole="alert">
      <AppText role="secondary" tone="danger">
        {props.detail}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  accessRow: {
    borderColor: color.line,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: space[8],
    paddingHorizontal: space[16],
    paddingVertical: space[12],
  },
  actionStart: { alignItems: "flex-start" },
  avatar: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.full,
    height: 30,
    justifyContent: "center",
    width: 30,
  },
  avatarText: { color: color.textSoft, fontSize: 12, fontWeight: "700" },
  card: {
    backgroundColor: color.surface,
    borderColor: color.line,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  centred: { flex: 1, justifyContent: "center", padding: space[16] },
  content: { gap: space[24], paddingTop: space[16] },
  grow: { flex: 1, gap: space[2], minWidth: 0 },
  identity: { alignItems: "center", flexDirection: "row", gap: space[12] },
  linkRow: { alignItems: "flex-start", paddingHorizontal: space[16], paddingVertical: space[10] },
  pendingText: { color: color.amber },
  pill: {
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space[8],
    paddingVertical: space[2],
  },
  pillPending: { backgroundColor: color.amberWash, borderColor: color.amberLine },
  pillReady: { backgroundColor: color.greenWash, borderColor: color.green },
  readyText: { color: color.green },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget + space[12],
    paddingHorizontal: space[16],
    paddingVertical: space[10],
  },
  section: { gap: space[8] },
  sectionHead: { alignItems: "center", flexDirection: "row", gap: space[8] },
  shrink: { flexShrink: 1 },
  subsection: { gap: space[8], marginTop: space[8] },
  tile: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.xs,
    height: 30,
    justifyContent: "center",
    width: 30,
  },
  titleLine: { alignItems: "center", flexDirection: "row", gap: space[8] },
});
