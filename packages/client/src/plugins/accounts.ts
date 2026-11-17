import type { PluginAccountView } from "@opensteer/protocol";
import type { HostClient } from "../host/client.js";
import { unwrapRpcResult } from "../host/host-session-client.js";

export type { PluginAccountView } from "@opensteer/protocol";

/** Every saved account, its provider's name and the plugins it is linked to: one read. */
export async function readPluginAccounts(
  client: Pick<HostClient, "rpc">,
): Promise<readonly PluginAccountView[]> {
  return (await client.rpc["plugins.accounts.list"]({}).then(unwrapRpcResult)).accounts;
}

/** What a row says under the account's label. */
export function pluginAccountRowDetail(account: PluginAccountView) {
  return account.links.length
    ? `${account.providerName} · Used by ${listText(account.links.map(({ pluginName }) => pluginName))}`
    : `${account.providerName} · Not used by any plugin`;
}

/** The confirmation removing a saved account asks for: what it breaks, and what it can't undo. */
export function pluginAccountRemoval(account: PluginAccountView) {
  const label = account.label || account.id;
  const breaks = account.links.length
    ? `${listText(account.links.map(({ pluginName }) => pluginName))} ${
        account.links.length === 1 ? "loses" : "lose"
      } this account, and any of their tools, schedules or webhooks that need it stop working until you connect another.`
    : "No plugin uses it.";
  return {
    title: `Remove ${label}?`,
    message: `${breaks} It's removed from this computer right away. If you signed in to ${account.providerName}, Opensteer also asks ${account.providerName} to end its access; it's removed here even if ${account.providerName} can't be reached.`,
    confirm: "Remove account",
  };
}

function listText(items: readonly string[]) {
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
