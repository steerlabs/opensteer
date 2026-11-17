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
import { useSettingsRead } from "./use-settings-read.js";

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
  const action = usePluginAction(host);
  const platform = useSettingsRead(
    host,
    async () => (by ? unwrapRpcResult(await host.rpc["integration.platform.get"]({})) : null),
    JSON.stringify(by),
  );
  const secrets = useSettingsRead(
    host,
    async () => (by ? localMcpSecretServers(host) : null),
    `secrets:${JSON.stringify(by)}`,
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
                disabled: action.pending !== null,
                onPress: () => {
                  setValues({});
                  setSaved(false);
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
                disabled: action.pending !== null,
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
                          action.run("remove", async () => {
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
      ...(action.error
        ? { footer: { text: action.error, tone: "danger" as const } }
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
          if (action.pending === null) setChanging(null);
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
              label: action.pending === "secrets" ? "Saving…" : "Save",
              disabled: action.pending !== null,
              onPress: () => {
                const entered = localMcpSecretsToSend(
                  changing.secrets.map((secret) => ({ ...secret, saved: true })),
                  values,
                );
                if (!entered.ok || Object.keys(entered.secrets).length === 0) {
                  action.setError(entered.ok ? "Enter a new value to change." : entered.message);
                  return;
                }
                action.run("secrets", async () => {
                  await setLocalMcpServerSecrets(host, changing.id, entered.secrets);
                  setChanging(null);
                  setValues({});
                  setSaved(true);
                });
              },
            },
          ],
          footer: action.error
            ? { text: action.error, tone: "danger" }
            : { text: `${changing.name} restarts with the new values.` },
        },
      ]}
    />
  ) : null;
  return { sections, sheet };
}
