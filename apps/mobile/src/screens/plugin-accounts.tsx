import {
  pluginAccountRemoval,
  pluginAccountRowDetail,
  readPluginAccounts,
  removePluginAccount,
} from "@opensteer/client/plugins";
import type { HostClient } from "@opensteer/client/host";
import { usePluginEngine } from "@opensteer/client/react";
import type { StaticScreenProps } from "@react-navigation/native";
import type { ReactNode } from "react";
import { confirmDestructive } from "./confirm.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";
import { NativeSettingsPage } from "./native-settings-page.js";
import type { NativeSettingsRow, NativeSettingsSection } from "./native-settings-page.types.js";
import { engineSection, usePluginAction } from "./plugins.js";
import { useSettingsRead } from "./use-settings-read.js";

/**
 * Every saved account on a phone, whichever plugins use it, so one can be
 * removed even after the last plugin that used it is gone.
 */
export function PluginAccountsScreen({
  route,
}: StaticScreenProps<{ readonly deploymentId: string }>): ReactNode {
  const host = useAttachedHost(route.params.deploymentId);
  return host ? (
    <PluginAccounts host={host} key={route.params.deploymentId} />
  ) : (
    <DeploymentGate deploymentId={route.params.deploymentId} />
  );
}

function PluginAccounts({ host }: { host: HostClient }) {
  const accounts = useSettingsRead(host, () => readPluginAccounts(host));
  const engine = usePluginEngine(host, null);
  const action = usePluginAction(host);
  const sections: NativeSettingsSection[] = [];
  const notice = accounts.data ? null : engineSection(engine);
  if (notice) sections.push(notice);
  const rows: NativeSettingsRow[] = !accounts.data
    ? accounts.error
      ? [
          { key: "error", kind: "status", tone: "bad", label: accounts.error },
          {
            key: "retry",
            kind: "button",
            label: "Try again",
            onPress: () => void accounts.reload(),
          },
        ]
      : [{ key: "loading", kind: "text", label: "Loading accounts…" }]
    : accounts.data.length === 0
      ? [
          {
            key: "none",
            kind: "text",
            label: "No saved accounts",
            detail: "Connecting an account to a plugin saves it here.",
          },
        ]
      : accounts.data.map((row) => {
          const label = row.label || row.id;
          const remove = () => {
            const text = pluginAccountRemoval(row);
            confirmDestructive({
              title: text.title,
              message: text.message,
              confirm: text.confirm,
              onConfirm: () =>
                action.run(`remove:${row.id}`, async () => {
                  await removePluginAccount(host, row.id);
                  await accounts.reload();
                }),
            });
          };
          return {
            key: row.id,
            kind: "button",
            label: action.pending === `remove:${row.id}` ? `Removing ${label}…` : label,
            detail: pluginAccountRowDetail(row),
            mark: { definitionId: row.provider, name: row.providerName },
            disabled: action.pending !== null,
            onPress: remove,
            actions: [{ label: "Remove", destructive: true, onPress: remove }],
          } satisfies NativeSettingsRow;
        });
  sections.push({
    key: "accounts",
    title: "Connected accounts",
    rows,
    footer: action.error
      ? { text: action.error, tone: "danger" }
      : {
          text: "Saved on this computer for your plugins. Tap one to remove it. Unlinking one from a plugin keeps it here; removing it here takes it away from every plugin.",
        },
  });
  return <NativeSettingsPage sections={sections} />;
}
