import type { HostApiClient, HostApiCommandOutput } from "@opensteer/protocol";
import type { HostClient } from "./client.js";
import type { ClientCommandInput } from "./device-commands.js";

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
] as const;

/** What those screens read. */
export const chatScreenReads = [
  "channels.get",
  "connections.list",
  "channel.connection.check",
] as const;

/** The Host methods those screens call that send a command, by the command each sends. */
export const chatScreenMethods = { stopRun: "run.interrupt" } as const;

export type ChatScreenCommandType = (typeof chatScreenCommands)[number];
export type ChatScreenCommand = Extract<
  ClientCommandInput,
  { readonly type: ChatScreenCommandType }
>;

export interface ChatScreenHost {
  dispatch(command: ChatScreenCommand): Promise<HostApiCommandOutput>;
  readonly rpc: Pick<HostApiClient, (typeof chatScreenReads)[number]>;
  stopRun(threadId: string): Promise<void>;
}

/** A Home as those screens may reach it. */
export function chatScreenHost(
  client: Pick<HostClient, "dispatch" | "rpc" | "stopRun">,
): ChatScreenHost {
  return client;
}
