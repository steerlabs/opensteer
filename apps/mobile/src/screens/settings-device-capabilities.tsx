import { useRef, useState } from "react";
import { Alert, TextInput, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { deviceRemovalConfirmation } from "@opensteer/client/computers";
import { mutationIdempotencyKey, type HostClient } from "@opensteer/client/host";
import {
  MachineAccessPolicySchema,
  type MachineAccessPolicy,
  type MachineSummary,
} from "@opensteer/protocol";
import { AppText, SecondaryButton, SwitchRow } from "../ui/primitives.js";
import { useSettingsLease } from "./use-settings-read.js";

export function SettingsDeviceCapabilities({
  host,
  machine,
  deploymentId,
}: {
  readonly host: HostClient;
  readonly machine: MachineSummary;
  readonly deploymentId: string;
}) {
  const navigation = useNavigation();
  const current = useSettingsLease(host);
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [folder, setFolder] = useState("");
  const [folderWritable, setFolderWritable] = useState(false);
  async function run(operation: () => Promise<unknown>) {
    if (busy.current || !current()) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      await operation();
      if (current()) await host.refresh();
    } catch {
      if (current()) setError("The change could not be confirmed. Refresh before trying again.");
    } finally {
      busy.current = false;
      if (current()) setPending(false);
    }
  }
  function change(policy: MachineAccessPolicy) {
    if (!machine.access) return;
    const parsed = MachineAccessPolicySchema.safeParse(policy);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the folder path.");
      return;
    }
    void run(() =>
      host.dispatch({
        type: "machine.access.update",
        runnerId: machine.id,
        expectedRevision: machine.access!.revision,
        policy: parsed.data,
        idempotencyKey: mutationIdempotencyKey("device-access"),
      }),
    );
  }
  return (
    <View style={{ gap: 12 }}>
      {(machine.apps ?? []).map((app) => (
        <SecondaryButton
          key={app.definitionId}
          label={`${app.definitionId === "apple-messages" ? "iMessage" : app.definitionId} · Plugin`}
          onPress={() =>
            navigation.navigate("SettingsPluginDetail", {
              deploymentId,
              target: { kind: "device-app", definitionId: app.definitionId },
            })
          }
        />
      ))}
      {machine.access ? (
        <>
          <AppText>{`Access from other computers: ${machine.access.policy.reach}`}</AppText>
          {(
            [
              "nobody",
              ...(machine.access.ownerReachAvailable ? ["owner" as const] : []),
              "deployment",
            ] as const
          ).map((reach) => (
            <SecondaryButton
              key={reach}
              label={
                reach === "nobody"
                  ? "Allow no other computers"
                  : reach === "owner"
                    ? "Allow my agents"
                    : "Allow agents in this Opensteer"
              }
              disabled={pending || machine.access!.policy.reach === reach}
              onPress={() =>
                Alert.alert(
                  "Change device access?",
                  "This changes which agents may use Terminal and shared folders on this computer.",
                  [
                    { text: "Cancel", style: "cancel" },
                    { text: "Apply", onPress: () => change({ ...machine.access!.policy, reach }) },
                  ],
                )
              }
            />
          ))}
          {machine.allowedModules.includes("shell") ? (
            <SwitchRow
              label="Terminal"
              value={machine.access.policy.commands}
              disabled={pending}
              onChange={(commands) => change({ ...machine.access!.policy, commands })}
            />
          ) : null}
          <AppText>Folders</AppText>
          {machine.access.policy.shares.map((share) => (
            <View key={share.path}>
              <AppText>
                {share.path} · {share.mode === "read" ? "Read only" : "Read and write"}
              </AppText>
              <SwitchRow
                label={`Allow changes to ${share.path}`}
                value={share.mode === "read-write"}
                disabled={pending}
                onChange={(writable) =>
                  change({
                    ...machine.access!.policy,
                    shares: machine.access!.policy.shares.map((item) =>
                      item.path === share.path
                        ? { ...item, mode: writable ? "read-write" : "read" }
                        : item,
                    ),
                  })
                }
              />
              <SecondaryButton
                label={`Stop sharing ${share.path}`}
                disabled={pending}
                onPress={() =>
                  change({
                    ...machine.access!.policy,
                    shares: machine.access!.policy.shares.filter(
                      (item) => item.path !== share.path,
                    ),
                  })
                }
              />
            </View>
          ))}
          <TextInput
            accessibilityLabel="Folder path on this computer"
            placeholder="/absolute/folder/path"
            value={folder}
            onChangeText={setFolder}
            autoCapitalize="none"
            autoCorrect={false}
            style={{ minHeight: 48 }}
          />
          <SwitchRow
            label="Allow changes in new folder"
            value={folderWritable}
            disabled={pending}
            onChange={setFolderWritable}
          />
          <SecondaryButton
            label={folderWritable ? "Share folder read and write" : "Share folder read only"}
            disabled={pending || !folder.trim()}
            onPress={() =>
              change({
                ...machine.access!.policy,
                shares: [
                  ...machine.access!.policy.shares,
                  { path: folder.trim(), mode: folderWritable ? "read-write" : "read" },
                ],
              })
            }
          />
        </>
      ) : null}
      {error ? <AppText>{error}</AppText> : null}
      {machine.revocable ? (
        <SecondaryButton
          label="Remove device"
          disabled={pending}
          onPress={() => {
            const ask = deviceRemovalConfirmation(machine, host.getSnapshot().browserProfiles);
            Alert.alert(ask.title, ask.message, [
              { text: "Cancel", style: "cancel" },
              {
                text: ask.confirm,
                style: "destructive",
                onPress: () => {
                  void run(() =>
                    host.dispatch({
                      type: "machine.revoke",
                      machineId: machine.id,
                      idempotencyKey: mutationIdempotencyKey("device-remove"),
                    }),
                  );
                },
              },
            ]);
          }}
        />
      ) : null}
    </View>
  );
}
