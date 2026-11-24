import { useState } from "react";
import {
  computerConnectionCommands,
  runnerDistributionPrefix,
  runnerImageReference,
} from "@opensteer/client/computers";
import {
  mutationIdempotencyKey,
  unwrapRpcResult,
  type HostClient,
  type HostSnapshot,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { StyleSheet, TextInput, View } from "react-native";
import { color, material, radius, space, touchTarget, type } from "../theme.js";
import { ActionLine } from "../ui/action-line.js";
import { notDone, useScreenAction } from "../ui/client-feedback.js";
import { AppText, SecondaryButton, SectionLabel } from "../ui/primitives.js";

const selectDeploymentShape = (snapshot: HostSnapshot) => snapshot.deploymentShape;
const selectIdentityConfig = (snapshot: HostSnapshot) => snapshot.identityConfig;

export function SettingsComputerEnrollment({ host }: { readonly host: HostClient }) {
  const [name, setName] = useState("New computer");
  const [issued, setIssued] = useState<{
    enrollmentId: string;
    token: string;
    expiresAt: string;
    hostOrigin: string;
  } | null>(null);
  const creation = useScreenAction(host, "computer-enrollment", {
    label: "create the command",
    done: "created",
    happened: "the command was created",
    execute: async (computerName: string) => {
      const target = unwrapRpcResult(await host.rpc["agentPhone.target.get"]({}));
      const result = await host.dispatch({
        type: "runner.enrollment.createLocal",
        allowedModules: ["agents", "shell"],
        name: computerName,
        idempotencyKey: mutationIdempotencyKey("computer-add"),
      });
      // Handed straight to this sheet, never kept as the action's outcome: the token is a secret.
      if (result.type === "runner.enrollment.createLocal")
        setIssued({ ...result, hostOrigin: target.hostUrl });
    },
    // Its one-time token is never read back, so a lost answer leaves nothing to run.
    reconcile: async () => notDone("created"),
    retry: () => void create(),
  });
  // Selected, so the commands appear as soon as the identity read lands.
  const deploymentShape = useHostSelector(host, selectDeploymentShape);
  const identityConfig = useHostSelector(host, selectIdentityConfig);
  const revision = process.env.EXPO_PUBLIC_OPENSTEER_RUNNER_SOURCE_REVISION;
  const commands =
    issued && deploymentShape && identityConfig
      ? computerConnectionCommands({
          deploymentShape,
          enrollmentId: issued.enrollmentId,
          hostOrigin: issued.hostOrigin,
          name: name.trim(),
          token: issued.token,
          runnerDistribution: runnerDistributionPrefix(
            process.env.EXPO_PUBLIC_OPENSTEER_RUNNER_ARTIFACT_BASE_URL,
            revision,
          ),
          runnerImage: runnerImageReference(revision),
        })
      : null;
  async function create() {
    if (creation.running || !name.trim()) return;
    await creation.run(name.trim());
  }
  return (
    // Drawn in the sheet's own scroll view, as the guide under it is, so the name and the
    // button read whole and wrap at every text size: the native list cut "New computer" and
    // "Create connection command" to one line and clipped them in a fixed box.
    <View style={styles.section}>
      <SectionLabel>Computer</SectionLabel>
      {issued ? (
        <AppText role="secondary" tone="muted">
          {`Command expires ${issued.expiresAt}`}
        </AppText>
      ) : (
        <>
          <AppText role="caption" tone="muted">
            Computer name
          </AppText>
          <TextInput
            accessibilityLabel="Computer name"
            multiline
            onChangeText={setName}
            placeholderTextColor={color.muted}
            returnKeyType="done"
            selectionColor={color.ember}
            style={[type.body, styles.input]}
            submitBehavior="blurAndSubmit"
            value={name}
          />
          <SecondaryButton
            disabled={creation.running || !name.trim()}
            label="Create connection command"
            onPress={() => void create()}
          />
        </>
      )}
      {creation.line ? <ActionLine line={creation.line} /> : null}
      {commands ? (
        <View style={styles.commands}>
          <AppText role="secondary">Run on the computer you’re adding</AppText>
          {commands.bareHost ? (
            <AppText accessibilityLabel="Computer enrollment command" role="caption" selectable>
              {commands.bareHost}
            </AppText>
          ) : (
            <AppText role="secondary" tone="muted">
              No Runner download is published for this build. Use Docker on the computer.
            </AppText>
          )}
          <AppText role="secondary">Docker</AppText>
          <AppText accessibilityLabel="Docker enrollment command" role="caption" selectable>
            {commands.container}
          </AppText>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  commands: { gap: space[12] },
  input: {
    ...material.control,
    borderRadius: radius.md,
    color: color.text,
    minHeight: touchTarget,
    paddingHorizontal: space[12],
    paddingVertical: space[10],
  },
  section: { gap: space[8] },
});
