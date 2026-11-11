import {
  formatRelativeTime,
  teamComputerCommand,
  teamComputerReplace,
  teamComputerState,
  teamComputerTrustNote,
  type HostClient,
} from "@opensteer/client/host";
import { useHostRead, useHostSnapshot, useTeam } from "@opensteer/client/react";
import { useState, type ReactNode } from "react";
import { Alert, Share, View } from "react-native";
import { AppText, CodeBlock, PrimaryButton, RowGroup, SecondaryButton } from "../ui/primitives.js";
import { ReadState, TeamSection, showError, styles } from "./team-parts.js";

/**
 * The one computer every Project in the team runs on. Replacing it is its only
 * action, and with none it is how the first one joins. Nobody runs a server
 * command on a phone, so the command is shared rather than run here.
 */
export function TeamComputer(props: { readonly hostClient: HostClient }): ReactNode {
  const { team, summary, identity, generation } = useTeam(props.hostClient);
  const { snapshot } = useHostSnapshot(props.hostClient);
  const teamName = summary?.team.name ?? "the team";
  const read = useHostRead(
    team ? () => team.computer() : null,
    `team-computer:${identity}:${generation}`,
  );
  const [pending, setPending] = useState(false);
  // The connection code lives only in this screen's memory.
  const [command, setCommand] = useState<{
    kind: "command" | "unavailable";
    text: string;
    expiresAt: string;
  } | null>(null);
  const view = read.data;
  if (!view || !summary)
    return (
      <RowGroup>
        {[<ReadState error={read.error} key="state" onRetry={read.reload} team={teamName} />]}
      </RowGroup>
    );
  const state = teamComputerState(view.computer, teamName);
  const action = teamComputerReplace(view, teamName);
  const replace = (): void => {
    setPending(true);
    void (
      team
        ? team.replaceComputer(summary.accessRevision, view.computer?.id ?? null)
        : Promise.reject(new Error("No team."))
    )
      .then((result) => {
        if (snapshot.deploymentShape && snapshot.identityConfig)
          setCommand({
            ...teamComputerCommand({
              deploymentShape: snapshot.deploymentShape,
              hostOrigin: snapshot.identityConfig.publicOrigin,
              team: teamName,
              replaced: result,
            }),
            expiresAt: result.expiresAt,
          });
        read.reload();
      })
      .catch((error: unknown) => showError(error, teamName))
      .finally(() => setPending(false));
  };
  const confirm = (): void => {
    if (!view.computer) {
      replace();
      return;
    }
    Alert.alert(
      `Replace ${view.computer.name}?`,
      `${view.computer.name} stops working for ${teamName} at once. The new computer joins with the command that follows.`,
      [
        { style: "cancel", text: "Cancel" },
        { onPress: replace, style: "destructive", text: "Replace" },
      ],
    );
  };
  return (
    <>
      <TeamSection footer={teamComputerTrustNote(teamName)} label="Team computer">
        <View style={styles.grow}>
          <AppText role="title">{state.title}</AppText>
          <AppText role="secondary" tone="muted">
            {state.detail}
          </AppText>
          {view.computer?.lastSeenAt ? (
            <AppText role="caption" tone="muted">
              {`Last seen ${formatRelativeTime(view.computer.lastSeenAt)}`}
            </AppText>
          ) : null}
        </View>
      </TeamSection>
      {command?.kind === "unavailable" ? (
        <TeamSection label="Connect it">
          <AppText role="secondary" tone="muted">
            {command.text}
          </AppText>
        </TeamSection>
      ) : command ? (
        <TeamSection
          footer={`Whoever runs ${teamName}’s server runs this on the new computer. It needs Docker. The code expires at ${new Date(command.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`}
          label="Connect it"
        >
          <CodeBlock label="Container command" text={command.text} />
          <PrimaryButton
            label="Share command"
            onPress={() => void Share.share({ message: command.text }).catch(() => undefined)}
          />
        </TeamSection>
      ) : action ? (
        <>
          {view.computer ? (
            <SecondaryButton
              busy={pending}
              disabled={!action.enabled}
              label={action.label}
              onPress={confirm}
            />
          ) : (
            <PrimaryButton
              busy={pending}
              disabled={!action.enabled}
              label={action.label}
              onPress={confirm}
            />
          )}
          {action.note ? (
            <AppText role="secondary" tone="muted">
              {action.note}
            </AppText>
          ) : null}
        </>
      ) : null}
    </>
  );
}
