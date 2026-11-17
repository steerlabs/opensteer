import { useState } from "react";
import {
  computerConnectionCommands,
  runnerDistributionPrefix,
  runnerImageReference,
} from "@opensteer/client/computers";
import { mutationIdempotencyKey, unwrapRpcResult, type HostClient } from "@opensteer/client/host";
import { Text, View } from "react-native";
import { NativeSettingsPage } from "./native-settings-page.js";
import { notDone, settingsFooter, useScreenAction } from "../ui/client-feedback.js";

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
    reconcile: async () => notDone({ label: "create", done: "created" }),
    retry: () => void create(),
  });
  const snapshot = host.getSnapshot();
  const revision = process.env.EXPO_PUBLIC_OPENSTEER_RUNNER_SOURCE_REVISION;
  const commands =
    issued && snapshot.deploymentShape && snapshot.identityConfig
      ? computerConnectionCommands({
          deploymentShape: snapshot.deploymentShape,
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
    <View style={{ minHeight: 260 }}>
      <NativeSettingsPage
        sections={[
          {
            key: "computer",
            title: "Computer",
            rows: issued
              ? [
                  {
                    key: "expiry",
                    kind: "text" as const,
                    label: `Command expires ${issued.expiresAt}`,
                  },
                ]
              : [
                  {
                    key: "name",
                    kind: "input" as const,
                    label: "Computer name",
                    value: name,
                    onChange: setName,
                  },
                  {
                    key: "create",
                    kind: "button" as const,
                    label: "Create connection command",
                    disabled: creation.running || !name.trim(),
                    onPress: () => void create(),
                  },
                ],
            ...(creation.line ? { footer: settingsFooter(creation.line)! } : {}),
          },
        ]}
      />
      {commands ? (
        <View style={{ padding: 16, gap: 12 }}>
          <Text>Run on the computer you’re adding</Text>
          {commands.bareHost ? (
            <Text selectable accessibilityLabel="Computer enrollment command">
              {commands.bareHost}
            </Text>
          ) : (
            <Text>No Runner download is published for this build. Use Docker on the computer.</Text>
          )}
          <Text>Docker</Text>
          <Text selectable accessibilityLabel="Docker enrollment command">
            {commands.container}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
