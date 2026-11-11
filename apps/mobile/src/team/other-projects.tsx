import { otherProjectLine, type HostClient } from "@opensteer/client/host";
import { usePagedList, useTeam } from "@opensteer/client/react";
import { useNavigation } from "@react-navigation/native";
import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { color, space } from "../theme.js";
import { AppText, RowGroup, SecondaryButton } from "../ui/primitives.js";
import { WorkspaceMark } from "../ui/workspace-mark.js";
import { ShowMoreRow, TeamSection } from "./team-parts.js";

/**
 * An administrator's names-only list of the team's Projects they aren't on.
 * A row opens the Project's page, where adding oneself is confirmed and audited.
 */
export function OtherProjects(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
  readonly open: boolean;
}): ReactNode {
  const navigation = useNavigation();
  const { team, summary, identity, generation } = useTeam(props.hostClient);
  const [open, setOpen] = useState(props.open);
  // The read is an administrator's; nothing is asked unless the Host lets this person see people.
  const allowed = summary?.can.people.allowed === true;
  const list = usePagedList(
    team && allowed && open
      ? (cursor: string | null) => team.projects({ limit: 50, ...(cursor ? { cursor } : {}) })
      : null,
    `team-projects:${identity}:${generation}`,
  );
  if (!summary || !allowed) return null;
  const teamName = summary.team.name;
  if (!open)
    return (
      <View style={styles.toggle}>
        <SecondaryButton
          compact
          label={`Other projects in ${teamName}`}
          onPress={() => setOpen(true)}
        />
      </View>
    );
  const others = list.items.filter(({ myLevel }) => myLevel === null);
  // A team with no Projects at all has nothing to list here.
  if (list.first && list.items.length === 0) return null;
  return (
    <View style={styles.section}>
      <TeamSection
        footer="You can see their names and who is on them. Add yourself to see their work; their managers are told."
        label={`Other projects in ${teamName}`}
      >
        {list.first && others.length === 0 && !list.nextCursor ? (
          <AppText role="secondary" tone="muted">
            {`You’re on every project in ${teamName}.`}
          </AppText>
        ) : (
          <RowGroup>
            {others.map((project) => (
              <Pressable
                accessibilityHint="Opens its page, where you can add yourself"
                accessibilityLabel={`${project.name}. ${otherProjectLine(project)}`}
                accessibilityRole="button"
                key={project.id}
                onPress={() =>
                  navigation.navigate("ProjectSettings", {
                    deploymentId: props.deploymentId,
                    workspaceId: project.id,
                  })
                }
                style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              >
                <WorkspaceMark color={project.color} icon={null} name={project.name} />
                <View style={styles.text}>
                  <AppText numberOfLines={1} role="body">
                    {project.name}
                  </AppText>
                  <AppText role="caption" tone="muted">
                    {otherProjectLine(project)}
                  </AppText>
                </View>
                <AppText role="caption" tone="ember">
                  Add myself…
                </AppText>
              </Pressable>
            ))}
          </RowGroup>
        )}
        <ShowMoreRow list={list} team={teamName} />
      </TeamSection>
    </View>
  );
}

const styles = StyleSheet.create({
  pressed: { backgroundColor: color.surfaceRaised },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    paddingHorizontal: space[16],
    paddingVertical: space[12],
  },
  section: { paddingTop: space[24] },
  text: { flex: 1, gap: space[2], minWidth: 0 },
  toggle: { alignItems: "flex-start", paddingTop: space[24] },
});
