import type { ConnectedAccountView, InstalledPluginView } from "@opensteer/protocol";
import type { HostClient } from "../host/client.js";
import { unwrapRpcResult } from "../host/host-session-client.js";

/** One saved account and every plugin it is linked to. */
export interface PluginAccountRow {
  readonly account: ConnectedAccountView;
  readonly providerName: string;
  readonly links: readonly { readonly pluginId: string; readonly pluginName: string }[];
}

/**
 * Every saved account with the plugins it is linked to. The Host's account
 * list names neither, so this reads the installed list beside it, then the
 * detail of each plugin that has a linked account: two waves.
 */
export async function readPluginAccounts(
  client: Pick<HostClient, "rpc">,
): Promise<readonly PluginAccountRow[]> {
  const [{ accounts }, installed] = await Promise.all([
    client.rpc["plugins.accounts.list"]({}).then(unwrapRpcResult),
    client.rpc["plugins.installed.list"]({}).then(unwrapRpcResult),
  ]);
  const details = await Promise.all(
    (installed.plugins ?? [])
      .filter((plugin) => plugin.accounts.linked > 0)
      .map((plugin) => client.rpc["plugins.get"]({ pluginId: plugin.id }).then(unwrapRpcResult)),
  );
  return pluginAccountRows(accounts, details);
}

export function pluginAccountRows(
  accounts: readonly ConnectedAccountView[],
  details: readonly Pick<InstalledPluginView, "plugin" | "requirements">[],
): readonly PluginAccountRow[] {
  const providerNames = new Map<string, string>();
  for (const { requirements } of details)
    for (const requirement of requirements)
      providerNames.set(requirement.provider, requirement.providerName);
  return accounts
    .map((account) => {
      const links = new Map<string, string>();
      for (const { plugin, requirements } of details)
        if (requirements.some(({ links }) => links.some((link) => link.account.id === account.id)))
          links.set(plugin.id, plugin.name);
      return {
        account,
        providerName: providerNames.get(account.provider) ?? providerTitle(account.provider),
        links: [...links].map(([pluginId, pluginName]) => ({ pluginId, pluginName })),
      };
    })
    .sort(
      (a, b) =>
        a.providerName.localeCompare(b.providerName) ||
        a.account.label.localeCompare(b.account.label),
    );
}

function providerTitle(provider: string) {
  const words = provider.replace(/[-_]+/gu, " ").trim();
  return words ? `${words[0]!.toLocaleUpperCase()}${words.slice(1)}` : provider;
}

/** What a row says under the account's label. */
export function pluginAccountRowDetail(row: PluginAccountRow) {
  return row.links.length
    ? `${row.providerName} · Used by ${listText(row.links.map(({ pluginName }) => pluginName))}`
    : `${row.providerName} · Not used by any plugin`;
}

/** The confirmation removing a saved account asks for: what it breaks, and what it can't undo. */
export function pluginAccountRemoval(row: PluginAccountRow) {
  const label = row.account.label || row.account.id;
  const breaks = row.links.length
    ? `${listText(row.links.map(({ pluginName }) => pluginName))} ${
        row.links.length === 1 ? "loses" : "lose"
      } this account, and any of their tools, schedules or webhooks that need it stop working until you connect another.`
    : "No plugin uses it.";
  return {
    title: `Remove ${label}?`,
    message: `${breaks} It's removed from this computer right away. If you signed in to ${row.providerName}, Opensteer also asks ${row.providerName} to end its access; it's removed here even if ${row.providerName} can't be reached.`,
    confirm: "Remove account",
  };
}

function listText(items: readonly string[]) {
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
