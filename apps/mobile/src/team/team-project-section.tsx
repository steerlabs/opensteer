import {
  accessModeOptions,
  accessPathSentence,
  accessPaths,
  changeLevelChanges,
  levelLabel,
  peopleCount,
  runtimeStateForUser,
  runtimeStateText,
  subjectRef,
  teamErrorText,
  type HostClient,
  type ProjectAccessView,
} from "@opensteer/client/host";
import { useHostRead, useTeam } from "@opensteer/client/react";
import type { EntryView } from "@opensteer/protocol";
import { useNavigation } from "@react-navigation/native";
import { useState, type ReactNode } from "react";
import { Alert, Pressable, View } from "react-native";
import { color } from "../theme.js";
import { ChoiceMenu } from "../ui/choice-menu.js";
import { AppText, PrimaryButton, RowGroup, SecondaryButton } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import {
  Avatar,
  ReadState,
  TeamSection,
  confirmAccessChange,
  showError,
  styles,
} from "./team-parts.js";

/** One read of a shared Project's access view, for its marker and its people. */
export function useTeamProjectAccess(hostClient: HostClient, workspaceId: string) {
  const { team, generation } = useTeam(hostClient);
  return useHostRead(
    team ? () => team.projectAccess({ workspaceId }) : null,
    `team-access:${workspaceId}:${generation}`,
  );
}

/** "Customer launch · 6 people", and who they are when tapped. */
export function TeamMarker(props: {
  readonly access: ProjectAccessView;
  readonly teamName: string;
}): ReactNode {
  const { audience, project, managerNames } = props.access;
  const show = () => {
    const managers = new Set(managerNames.map(({ id }) => id));
    const lines = [
      ...audience.groups.map((group) => `${group.name} (group) · ${peopleCount(group.count)}`),
      ...audience.preview.map((person) =>
        [
          person.name,
          person.kind === "guest" ? "Guest" : null,
          managers.has(person.id) ? "Can manage" : null,
        ]
          .filter(Boolean)
          .join(" · "),
      ),
      ...(audience.people > audience.preview.length
        ? [`and ${peopleCount(audience.people - audience.preview.length)} more`]
        : []),
    ];
    Alert.alert(
      "Who can see this",
      `${peopleCount(audience.people)} at ${props.teamName} can read ${project.name}’s chat, tasks and files.\n\n${lines.join("\n")}`,
    );
  };
  return (
    <Pressable
      accessibilityLabel={`${project.name}, ${peopleCount(audience.people)} can see it. Who can see this`}
      accessibilityRole="button"
      onPress={show}
      style={styles.marker}
    >
      <Symbol name="person.2" size={13} tint={color.textSoft} />
      <AppText role="caption" tone="soft">
        {`${project.name} · ${peopleCount(audience.people)}`}
      </AppText>
    </Pressable>
  );
}

/**
 * Who can use a shared Project, and how it runs, on the phone's Project
 * settings. Every control comes from the Host's `can`.
 */
export function TeamProjectSection(props: {
  readonly hostClient: HostClient;
  readonly deploymentId: string;
  readonly access: ReturnType<typeof useTeamProjectAccess>;
  readonly viewerId: string | null;
}): ReactNode {
  const { hostClient, deploymentId, access, viewerId } = props;
  const navigation = useNavigation();
  const { team, summary, error: summaryError } = useTeam(hostClient);
  const teamName = summary?.team.name ?? "the team";
  const view = access.data;
  if (!team) return null;
  if (!view)
    return (
      <TeamSection label="Who can use this">
        <RowGroup>
          {[
            <ReadState
              error={access.error ?? summaryError}
              key="state"
              onRetry={access.reload}
              team={teamName}
            />,
          ]}
        </RowGroup>
      </TeamSection>
    );
  const { project, audience } = view;
  const useOnly = view.can.manage.allowed
    ? null
    : runtimeStateForUser(view.runtime, view.managerNames, teamName);
  const add = (level: "use" | "manage") =>
    navigation.navigate("TeamAdd", { deploymentId, target: "project", id: project.id, level });
  const why = (entry: EntryView) => {
    const subject = subjectRef(entry.subject);
    team
      .explain({ workspaceId: project.id, subject })
      .then((explanation) => {
        const paths = accessPaths(explanation);
        Alert.alert(
          `Why ${entry.subject.name} has access`,
          explanation.effectiveLevel && paths.length
            ? [
                `${entry.subject.name} ${levelLabel(explanation.effectiveLevel).toLocaleLowerCase()} because:`,
                ...paths.map((path) => `• ${accessPathSentence(entry.subject.name, path)}`),
                ...(paths.length > 1 ? ["The highest level counts."] : []),
              ].join("\n")
            : `${entry.subject.name} has no access to this project.`,
        );
      })
      .catch((error: unknown) => showError(error, teamName));
  };
  return (
    <>
      {audience.managerCount === 0 ? (
        <View style={styles.banner}>
          <AppText role="bodyMedium">{`${project.name} has no manager.`}</AppText>
          <AppText role="secondary" tone="soft">
            {view.can.appointManager.allowed
              ? "Nobody can add people or change its settings until someone can manage it."
              : `Ask an admin of ${teamName} to appoint one.`}
          </AppText>
          {view.can.appointManager.allowed ? (
            <SecondaryButton compact label="Appoint a manager" onPress={() => add("manage")} />
          ) : null}
        </View>
      ) : null}
      {useOnly ? (
        <View style={styles.banner}>
          <AppText role="bodyMedium">{`${project.name} can’t run tasks right now.`}</AppText>
          <AppText role="secondary" tone="soft">{`${useOnly.why} ${useOnly.fix}`}</AppText>
        </View>
      ) : null}
      {view.iAmAdminNotMember && view.can.selfGrant.allowed ? (
        <SelfGrant team={team} teamName={teamName} view={view} />
      ) : null}
      <TeamSection
        action={
          view.can.addPeople.allowed ? (
            <SecondaryButton compact label="Add people" onPress={() => add("use")} />
          ) : undefined
        }
        footer={`${peopleCount(audience.people)} can read ${project.name}’s chat, tasks and files, and start work in it.`}
        label={`Who can use ${project.name}`}
      >
        <RowGroup>
          {view.entries === null
            ? [
                <View key="hidden" style={styles.row}>
                  <AppText role="secondary" tone="muted">
                    {`Only people who can manage ${project.name} see its list.`}
                  </AppText>
                </View>,
              ]
            : view.entries.items.map((entry) => {
                const mine = entry.subject.kind === "person" && entry.subject.userId === viewerId;
                const choices = [
                  { id: "why", title: "Why?" },
                  ...(entry.can.change.allowed
                    ? [
                        entry.level === "use"
                          ? { id: "manage", title: "Change to Can manage" }
                          : { id: "use", title: "Change to Can use" },
                      ]
                    : []),
                  ...(entry.can.revoke.allowed
                    ? [
                        {
                          destructive: true,
                          id: "remove",
                          title: mine ? "Remove myself" : "Remove",
                        },
                      ]
                    : []),
                ];
                return (
                  <View key={entry.id} style={styles.row}>
                    <Avatar group={entry.subject.kind === "group"} name={entry.subject.name} />
                    <View style={styles.grow}>
                      <AppText numberOfLines={1} role="body">
                        {mine ? `${entry.subject.name} (you)` : entry.subject.name}
                      </AppText>
                      <AppText numberOfLines={1} role="caption" tone="muted">
                        {entry.subject.kind === "group" && entry.subject.memberCount !== undefined
                          ? `Group · ${peopleCount(entry.subject.memberCount)}`
                          : `${entry.subject.kind === "person" && entry.subject.memberKind === "guest" ? "Guest · " : ""}Added by ${entry.grantedBy.name}`}
                      </AppText>
                    </View>
                    <ChoiceMenu
                      accessibilityLabel={`${entry.subject.name}: ${levelLabel(entry.level)}. Change`}
                      choices={choices}
                      label={levelLabel(entry.level)}
                      onChoose={(id) => {
                        if (id === "why") why(entry);
                        else
                          void confirmAccessChange({
                            team,
                            teamName,
                            revision: view.accessRevision,
                            changes:
                              id === "remove"
                                ? [{ kind: "revoke", entryId: entry.id }]
                                : changeLevelChanges(entry, id === "manage" ? "manage" : "use"),
                            title:
                              id === "remove"
                                ? `Remove ${entry.subject.name}?`
                                : `Change ${entry.subject.name} to ${levelLabel(id === "manage" ? "manage" : "use")}?`,
                            confirm: id === "remove" ? "Remove" : "Change",
                            destructive: id === "remove",
                          });
                      }}
                    />
                  </View>
                );
              })}
        </RowGroup>
      </TeamSection>
      {view.can.manage.allowed ? (
        <RuntimeSummary deploymentId={deploymentId} hostClient={hostClient} view={view} />
      ) : null}
    </>
  );
}

function SelfGrant(props: {
  readonly team: NonNullable<ReturnType<typeof useTeam>["team"]>;
  readonly teamName: string;
  readonly view: ProjectAccessView;
}): ReactNode {
  const { team, teamName, view } = props;
  const [pending, setPending] = useState(false);
  const managers = view.managerNames.map(({ name }) => name).join(", ");
  return (
    <View style={[styles.banner, styles.bannerAccent]}>
      <AppText role="bodyMedium">{`You’re not on ${view.project.name}.`}</AppText>
      <AppText role="secondary" tone="soft">
        As an admin you can see who is on it, not its chats or files. You can add yourself at Can
        use.
      </AppText>
      <SecondaryButton
        busy={pending}
        compact
        label="Add myself…"
        onPress={() =>
          Alert.alert(
            `Add yourself to ${view.project.name}?`,
            `You’ll read its chat, tasks and files, and start work in it, at Can use. ${
              managers ? `Its managers (${managers}) are told, and it’s` : "It’s"
            } recorded in ${teamName}’s audit log.`,
            [
              { style: "cancel", text: "Cancel" },
              {
                text: "Add myself",
                onPress: () => {
                  setPending(true);
                  team
                    .selfGrant(view.accessRevision, view.project.id)
                    .catch((error: unknown) => showError(error, teamName))
                    .finally(() => setPending(false));
                },
              },
            ],
          )
        }
      />
    </View>
  );
}

function RuntimeSummary(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
  readonly view: ProjectAccessView;
}): ReactNode {
  const navigation = useNavigation();
  const { team, generation, summary } = useTeam(props.hostClient);
  const read = useHostRead(
    team ? () => team.projectSettings(props.view.project.id) : null,
    `team-settings:${props.view.project.id}:${generation}`,
  );
  const teamName = summary?.team.name ?? "the team";
  const open = () =>
    navigation.navigate("TeamProjectRuntime", {
      deploymentId: props.deploymentId,
      workspaceId: props.view.project.id,
    });
  const data = read.data;
  const problem = data ? runtimeStateText(data.runtime) : null;
  return (
    <TeamSection
      footer={`Tasks in ${props.view.project.name} run on ${teamName}’s computer with these.`}
      label="How it runs"
    >
      <RowGroup>
        {data
          ? [
              <View key="state" style={styles.row}>
                <View style={styles.grow}>
                  <AppText role="body">
                    {data.settings ? `${data.settings.modelSelection.modelId}` : "Not set up yet"}
                  </AppText>
                  <AppText role="caption" tone={problem ? "danger" : "muted"}>
                    {problem ??
                      (data.settings
                        ? `${accessModeOptions.find(({ mode }) => mode === data.settings?.accessMode)?.label ?? ""} · ${data.settings.timeZone.replaceAll("_", " ")}`
                        : "")}
                  </AppText>
                </View>
                {data.can.edit.allowed ? (
                  data.settings ? (
                    <SecondaryButton compact label="Edit" onPress={open} />
                  ) : (
                    <PrimaryButton compact label="Set up" onPress={open} />
                  )
                ) : null}
              </View>,
            ]
          : [<ReadState error={read.error} key="state" onRetry={read.reload} team={teamName} />]}
      </RowGroup>
    </TeamSection>
  );
}

export function teamProjectGone(error: unknown, team: string): string {
  return teamErrorText(error, team);
}
