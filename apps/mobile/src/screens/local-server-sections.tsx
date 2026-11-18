import { mutationIdempotencyKey, unwrapRpcResult, type HostClient } from "@opensteer/client/host";
import {
  localMcpSecretServers,
  localMcpSecretsToSend,
  setLocalMcpServerSecrets,
  type LocalMcpSecretServer,
} from "@opensteer/client/integrations";
import { localServerRecord } from "@opensteer/client/plugins";
import { fixDeviceDraftText } from "@opensteer/client/settings";
import { useState, type ReactNode } from "react";
import { Alert } from "react-native";
import { useLeaveSheets } from "./leave-sheets.js";
import { NativeSettingsPage } from "./native-settings-page.js";
import type { NativeSettingsSection } from "./native-settings-page.types.js";
import { usePluginAction } from "./plugins.js";
import { usePluginRead } from "./use-plugin-read.js";

/**
 * A local server's own controls on a phone: whether its computer approved it,
 * the secrets its owner entered, a task to fix it, and removing it. The local
 * tool page and the other-device page both show them.
 */
export function useLocalServerSections(input: {
  readonly host: HostClient;
  readonly deploymentId: string;
  /** Null reads nothing: the page is not a local server's. */
  readonly by: { readonly serverId: string } | { readonly pluginId: string } | null;
  readonly name: string;
  readonly onRemoved: () => void;
}): { readonly sections: NativeSettingsSection[]; readonly sheet: ReactNode } {
  const { host, by, name } = input;
  const leave = useLeaveSheets(input.deploymentId, host);
  const key = `local-server:${JSON.stringify(by)}`;
  const removal = usePluginAction(host, `${key}:remove`, "remove this server", "removed");
  const save = usePluginAction(host, `${key}:secrets`, "save these values", "saved");
  const busy = removal.pending !== null || save.pending !== null;
  const platform = usePluginRead(
    host,
    by ? () => host.rpc["integration.platform.get"]({}).then(unwrapRpcResult) : null,
    `local-servers:${JSON.stringify(by)}`,
    "local servers",
  );
  const secrets = usePluginRead(
    host,
    by ? () => localMcpSecretServers(host) : null,
    `secrets:${JSON.stringify(by)}`,
    "server secrets",
  );
  const [changing, setChanging] = useState<LocalMcpSecretServer | null>(null);
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [saved, setSaved] = useState(false);
  const record = platform.data && by ? localServerRecord(platform.data, by) : null;
  const server = record
    ? (secrets.data?.find((candidate) => candidate.id === record.serverId) ?? null)
    : null;
  const pluginId = record?.pluginId ?? null;
  const sections: NativeSettingsSection[] = [];
  if (record)
    sections.push({
      key: "local-server",
      title: "Local server",
      rows: [
        {
          key: "state",
          kind: "status",
          tone:
            record.state.tone === "ok"
              ? "good"
              : record.state.tone === "attention"
                ? "attention"
                : "neutral",
          label: record.state.label,
        },
        ...(server
          ? [
              {
                key: "secrets",
                kind: "button" as const,
                label: "Change secrets",
                detail: server.secrets.map((secret) => secret.title).join(" · "),
                disabled: busy,
                onPress: () => {
                  setValues({});
                  setSaved(false);
                  save.setError(null);
                  setChanging(server);
                },
              },
            ]
          : []),
        ...(pluginId
          ? [
              {
                key: "fix",
                kind: "button" as const,
                label: "Not working? Ask an agent to fix it",
                onPress: () => void leave.openNewTask(fixDeviceDraftText({ name, pluginId })),
              },
              {
                key: "remove",
                kind: "button" as const,
                label: `Remove ${name}`,
                destructive: true,
                disabled: busy,
                onPress: () =>
                  Alert.alert(
                    `Remove ${name}?`,
                    "Agents can no longer use it. What it saved on its computer, such as a pairing, is deleted.",
                    [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Remove",
                        style: "destructive",
                        onPress: () =>
                          removal.run("remove", async () => {
                            await host.dispatch({
                              type: "plugin.remove",
                              pluginId,
                              idempotencyKey: mutationIdempotencyKey("local-server-remove"),
                            });
                            input.onRemoved();
                          }),
                      },
                    ],
                  ),
              },
            ]
          : []),
      ],
      ...(removal.footer
        ? { footer: removal.footer }
        : saved
          ? { footer: { text: "Secrets changed" } }
          : {}),
    });
  else if (by && (platform.error || secrets.error))
    sections.push({
      key: "local-server",
      title: "Local server",
      rows: [
        {
          key: "error",
          kind: "status",
          tone: "bad",
          label: platform.error ?? secrets.error ?? "",
        },
      ],
    });
  const sheet = changing ? (
    <NativeSettingsPage
      sheet={{
        title: `${changing.plugin}’s secrets`,
        onClose: () => {
          if (!busy) setChanging(null);
        },
      }}
      sections={[
        {
          key: "fields",
          title: "Enter only what changed",
          rows: [
            ...changing.secrets.map((secret) => ({
              key: secret.name,
              kind: "input" as const,
              label: secret.title,
              secure: true,
              value: values[secret.name] ?? "",
              onChange: (value: string) =>
                setValues((current) => ({ ...current, [secret.name]: value })),
            })),
            {
              key: "save",
              kind: "primary",
              label: save.pending === "secrets" ? "Saving…" : "Save",
              disabled: busy,
              onPress: () => {
                const entered = localMcpSecretsToSend(
                  changing.secrets.map((secret) => ({ ...secret, saved: true })),
                  values,
                );
                if (!entered.ok || Object.keys(entered.secrets).length === 0) {
                  save.setError(entered.ok ? "Enter a new value to change." : entered.message);
                  return;
                }
                save.run("secrets", async () => {
                  await setLocalMcpServerSecrets(host, changing.id, entered.secrets);
                  setChanging(null);
                  setValues({});
                  setSaved(true);
                });
              },
            },
          ],
          footer: save.footer ?? { text: `${changing.name} restarts with the new values.` },
        },
      ]}
    />
  ) : null;
  return { sections, sheet };
}
