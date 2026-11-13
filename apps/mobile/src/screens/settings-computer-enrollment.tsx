import { useRef, useState } from "react";
import {
  computerConnectionCommands,
  runnerDistributionPrefix,
  runnerImageReference,
} from "@opensteer/client/computers";
import { mutationIdempotencyKey, unwrapRpcResult, type HostClient } from "@opensteer/client/host";
import { Text, View } from "react-native";
import { NativeSettingsPage } from "./native-settings-page.js";
import { useSettingsLease } from "./use-settings-read.js";

export function SettingsComputerEnrollment({ host }: { readonly host: HostClient }) {
  const current = useSettingsLease(host);
  const [name, setName] = useState("New computer");
  const [issued, setIssued] = useState<{
    enrollmentId: string;
    token: string;
    expiresAt: string;
    hostOrigin: string;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [error, setError] = useState<string | null>(null);
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
    if (busy.current || !current() || !name.trim()) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const target = unwrapRpcResult(await host.rpc["agentPhone.target.get"]({}));
      const result = await host.dispatch({
        type: "runner.enrollment.createLocal",
        allowedModules: ["agents", "shell"],
        name: name.trim(),
        idempotencyKey: mutationIdempotencyKey("computer-add"),
      });
      if (current() && result.type === "runner.enrollment.createLocal")
        setIssued({ ...result, hostOrigin: target.hostUrl });
    } catch {
      if (current()) setError("Couldn’t create the command. Try again.");
    } finally {
      busy.current = false;
      if (current()) setPending(false);
    }
  }
  return (
    <View style={{ minHeight: 260 }}>
      <NativeSettingsPage
        sections={[
          {
            key: "computer",
            title: "Computer",
            rows: [
              ...(issued
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
                      disabled: pending || !name.trim(),
                      onPress: () => void create(),
                    },
                  ]),
              ...(error ? [{ key: "error", kind: "text" as const, label: error }] : []),
            ],
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
