import type { HostApiClient, HostApiCommandOutput } from "@opensteer/protocol";
import type { HostClient } from "./client.js";
import type { ClientCommandInput } from "./device-commands.js";
import type { HostSnapshotSource } from "./host-snapshot-store.js";

/**
 * Everything the Messaging, chat and connected-agent screens send to a Home, on the web and the
 * phone. Those screens reach the Home only through a `ChatScreenHost`, so a command or read that
 * is not listed here does not type-check there, and `tests/chat-parity-coverage.test.ts` fails for a listed one that the parity script, run on a real Home and
 * on the preview Home, does not both accept and refuse.
 */
export const chatScreenCommands = [
  "channel.connection.create",
  "channel.connection.computer.create",
  "channel.connection.credentials.replace",
  "channel.connection.status.set",
  "channel.me.link",
  "channel.chat.create",
  "connection.update",
  "connection.revoke",
  "connection.remove",
  "browser.profile.create",
  "run.interrupt",
] as const;

/** What those screens read. */
export const chatScreenReads = [
  "channels.get",
  "connections.list",
  "connections.activity",
  "threads.activity",
  "integration.computer.apps.approved",
  "channel.connection.check",
] as const;

/**
 * The hooks those screens hand a whole Home client, by why each may: none sends a command the
 * lists above do not hold. `tests/chat-parity-coverage.test.ts` fails on a hook given one that
 * is not here.
 */
export const chatScreenHooks = {
  useConnectedAgents:
    "Sends and reads only what these lists hold: its client is typed from ChatScreenHost (`ConnectedAgentsHost`); it takes the whole client to hear that connections changed.",
  useConnectedAgentLive:
    "Reads what a connected agent's task is doing now (connections.activity) for Watch; sends nothing.",
  useConnectedAgentActivity:
    "Reads what a connected agent did and asked (connections.activity) for Recent activity, again when its live task changes; sends nothing.",
  useLiveTasks:
    "Reads the tasks' live state the Home pushes for every task (the snapshot's task directory), so a chat's Stop ends when its Run does; sends nothing.",
  useChromeTabGrantCatalog:
    "Reads which shared Chrome tabs a grant may name (browser.sources.get); sends nothing.",
  useAgentAppOptions: "Reads which Mac apps and phone screens a grant may name; sends nothing.",
  useAgentPluginOptions: "Reads which plugins a grant may name; sends nothing.",
  usePersonalRemoteAccess:
    "Remote access to this Home, shown on the Connected agents list: its own page and its own tests, no chat or account.",
  useScreenAction:
    "Runs this screen's own sends, which go through ChatScreenHost; it takes the client for its connection state only.",
  useSettingsHost: "Reads the snapshot the phone's Settings draw; no call of its own.",
} as const;

export type ChatScreenCommandType = (typeof chatScreenCommands)[number];
export type ChatScreenCommand = Extract<
  ClientCommandInput,
  { readonly type: ChatScreenCommandType }
>;

export interface ChatScreenHost extends HostSnapshotSource {
  dispatch(command: ChatScreenCommand): Promise<HostApiCommandOutput>;
  readonly rpc: Pick<HostApiClient, (typeof chatScreenReads)[number]>;
}

/** A Home as those screens may reach it. */
export function chatScreenHost(
  client: Pick<HostClient, "dispatch" | "rpc"> & HostSnapshotSource,
): ChatScreenHost {
  return client;
}
