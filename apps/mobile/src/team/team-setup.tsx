import { teamSetupSteps, type HostClient } from "@opensteer/client/host";
import { useHostRead, useTeam } from "@opensteer/client/react";
import { useNavigation } from "@react-navigation/native";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { color, space } from "../theme.js";
import { AppText, RowGroup } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { TeamSection } from "./team-parts.js";

/**
 * "Get Acme ready": what a new team still needs, ticked from what its Host
 * reports. Read only for someone the Host lets connect its computer and invite.
 */
export function TeamSetupChecklist(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
}): ReactNode {
  const navigation = useNavigation();
  const { team, summary, identity, generation } = useTeam(props.hostClient);
  const allowed = summary?.can.computer?.allowed === true && summary.can.invite.allowed;
  const computer = useHostRead(
    team && allowed ? () => team.computer() : null,
    `team-setup-computer:${identity}:${generation}`,
  );
  const invitations = useHostRead(
    team && allowed ? () => team.invitations({ limit: 1 }) : null,
    `team-setup-invitations:${identity}:${generation}`,
  );
  if (!summary || !allowed) return null;
  const steps = teamSetupSteps({
    team: summary.team.name,
    computer: computer.data ? computer.data.computer : undefined,
    projects: summary.projects,
    invited: invitations.data ? invitations.data.items.length > 0 : undefined,
  });
  if (!steps) return null;
  const done = steps.filter((step) => step.done).length;
  const { deploymentId } = props;
  const open = (key: (typeof steps)[number]["key"]): void => {
    if (key === "computer") navigation.navigate("TeamComputer", { deploymentId });
    else if (key === "project") navigation.navigate("NewProject", { deploymentId });
    else navigation.navigate("TeamInvite", { deploymentId });
  };
  return (
    <View style={styles.wrap}>
      <TeamSection label={`Get ${summary.team.name} ready · ${done} of ${steps.length}`}>
        <RowGroup>
          {steps.map((step) => (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ checked: step.done, disabled: step.done }}
              disabled={step.done}
              key={step.key}
              onPress={() => open(step.key)}
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            >
              <Symbol
                name={step.done ? "checkmark.circle.fill" : "circle"}
                size={17}
                tint={step.done ? color.green : color.muted}
              />
              <AppText role="body" style={styles.text} tone={step.done ? "muted" : "default"}>
                {step.title}
              </AppText>
              {step.done ? null : <Symbol name="chevron.right" size={13} tint={color.mutedDim} />}
            </Pressable>
          ))}
        </RowGroup>
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
  text: { flex: 1 },
  wrap: { paddingBottom: space[16] },
});
