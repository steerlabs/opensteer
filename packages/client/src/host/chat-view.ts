import type { ChannelProviderManifest } from "@opensteer/channel-core";
import type { AgentConnection, MachineSummary } from "@opensteer/protocol";
import type { ConnectedAgentPhase } from "./connected-agent-view.js";
import { agentWords } from "./connected-agents-copy.js";
import { plainSentence as plain, sentenceAroundName, type SentencePart } from "./sentence-parts.js";

/**
 * What only a chat has beside any connected agent's page, in the person's words: where it
 * listens, who can give it work (fixed when it was added), why it ended, and replies that may
 * have been sent. Every sentence is read from the Home's facts; nothing here decides a state.
 */
export interface ChatFacts {
  readonly where: string;
  /** `where` as parts: the account's address a part of its own when it is one. */
  readonly whereParts: readonly SentencePart[];
  readonly speakers: {
    readonly title: string;
    readonly detail: string;
    readonly titleParts: readonly SentencePart[];
    readonly detailParts: readonly SentencePart[];
  };
  /** Who can give it work is chosen when it is added; this says how to change it. */
  readonly fixed: string;
  /** Why it ended, once the Home lists it as ending or stopped. */
  readonly ended: string | null;
  readonly unknownReplies: string | null;
  readonly tasks: readonly {
    readonly id: string;
    readonly title: string;
    readonly running: boolean;
  }[];
}

export function chatFacts(
  connection: AgentConnection,
  phase: ConnectedAgentPhase,
): ChatFacts | null {
  const bridge = connection.bridge;
  if (!bridge) return null;
  const account = bridge.accountName ?? bridge.provider;
  const conversation = bridge.conversationName ?? bridge.conversationId ?? "";
  const whereParts = sentenceAroundName(
    (slot) =>
      bridge.conversationId === null
        ? agentWords("chat.where.dm", { account: slot, provider: bridge.provider })
        : agentWords("chat.where.channel", {
            conversation,
            account: slot,
            provider: bridge.provider,
          }),
    account,
  );
  const where = plain(whereParts);
  const words = (title: readonly SentencePart[], detail: readonly SentencePart[]) => ({
    title: plain(title),
    detail: plain(detail),
    titleParts: title,
    detailParts: detail,
  });
  const identity = bridge.me?.displayName;
  const speakers =
    bridge.senders === "anyone"
      ? words(
          [agentWords("chat.speakers.anyone", { conversation })],
          [agentWords("chat.speakers.anyoneDetail")],
        )
      : identity !== undefined
        ? words(
            sentenceAroundName(
              (slot) => agentWords("chat.speakers.me", { identity: slot }),
              identity,
            ),
            sentenceAroundName(
              (slot) => agentWords("chat.speakers.meDetail", { identity: slot }),
              identity,
            ),
          )
        : words(
            [agentWords("chat.speakers.meNone")],
            [agentWords("chat.speakers.meNoneDetail", { provider: bridge.provider })],
          );
  const ending = phase === "stopping" || phase === "stopped" || phase === "revoked";
  const unknown = bridge.unknownReplies ?? 0;
  return {
    where,
    whereParts,
    speakers,
    fixed: agentWords("chat.speakers.fixed"),
    // Why it ended only from a reason the Home sent and this app knows; otherwise only that it did.
    ended: ending
      ? `${agentWords(
          bridge.endedBy !== undefined && Object.hasOwn(endedWords, bridge.endedBy)
            ? endedWords[bridge.endedBy]
            : "chat.ended.unknown",
        )} ${agentWords("chat.ended.again")}`
      : null,
    unknownReplies:
      unknown === 0
        ? null
        : unknown === 1
          ? agentWords("chat.unknownReply")
          : agentWords("chat.unknownReplies", { count: unknown }),
    tasks: bridge.tasks ?? [],
  };
}

const endedWords = {
  you: "chat.ended.you",
  organization: "chat.ended.organization",
  account: "chat.ended.account",
  computer: "chat.ended.computer",
  "work-home": "chat.ended.work-home",
} as const satisfies Record<NonNullable<NonNullable<AgentConnection["bridge"]>["endedBy"]>, string>;

/** The chats that speak through one chat account, as the connected agents list holds them. */
export function chatsOfAccount(
  connections: readonly AgentConnection[] | null,
  accountId: string,
): readonly AgentConnection[] {
  return (connections ?? []).filter((connection) => connection.bridge?.accountId === accountId);
}

/**
 * Where a read of the connected agents stands for a screen that depends on it: still reading,
 * could not read (offer Try again), or read. Only a read answer may say something is gone or
 * that there is none.
 */
export type ConnectionsRead = "loading" | "failed" | "read";
export function connectionsRead(agents: {
  readonly connections: readonly unknown[] | null;
  readonly error: string | null;
}): ConnectionsRead {
  return agents.connections !== null ? "read" : agents.error !== null ? "failed" : "loading";
}

/**
 * One messaging account as the Home states it, for web and phone alike: its connection's status
 * in words (one this app doesn't know reads as such), what the connection reports, what becomes
 * of a message sent while it is paused (only from what its provider says), and which controls the
 * Home accepts for it.
 */
export interface MessagingAccountView {
  readonly label: string;
  readonly tone: "good" | "attention";
  readonly detail: string | null;
  readonly pausedNote: string | null;
  /** Its tokens can be replaced: a provider app, not a computer's Messages, that needs attention. */
  readonly canFix: boolean;
  readonly canPause: boolean;
  readonly canResume: boolean;
}
const accountStatuses = ["connected", "pending", "paused", "needs-attention", "revoked"] as const;
export function messagingAccountView(
  connection: {
    readonly status: string;
    readonly statusDetail: string | null;
    readonly transportKind: string;
  },
  manifest: { readonly pausedMessages?: string | undefined } | undefined,
): MessagingAccountView {
  const status = accountStatuses.find((candidate) => candidate === connection.status) ?? null;
  return {
    label:
      status === null
        ? agentWords("messaging.status.unknown")
        : agentWords(`messaging.status.${status}`),
    tone: status === "connected" ? "good" : "attention",
    detail: connection.statusDetail,
    pausedNote: status === "paused" ? pausedNote(manifest?.pausedMessages) : null,
    canFix: status === "needs-attention" && connection.transportKind !== "computer",
    canPause: status === "connected" || status === "pending",
    canResume: status === "paused",
  };
}
/** What a pause holds, and what becomes of a message sent meanwhile only where the provider says. */
export function pausedNote(pausedMessages: string | undefined): string {
  return pausedMessages === "kept"
    ? agentWords("messaging.pausedNote", { sent: agentWords("chat.paused.kept") })
    : pausedMessages === "lost"
      ? agentWords("messaging.pausedNote", { sent: agentWords("chat.paused.lost") })
      : agentWords("messaging.pausedNoteUnknown");
}

/**
 * The Macs a computer provider (iMessage) can be set up on, the same on the web and the phone:
 * online, with Messages turned on for it, and with the provider's app.
 */
export function messagingComputers<M extends MachineSummary>(
  machines: readonly M[],
  provider: Pick<ChannelProviderManifest, "computerApp">,
): readonly M[] {
  return machines.filter(
    (machine) =>
      machine.status === "online" &&
      machine.modules.messaging !== undefined &&
      (machine.apps ?? []).some(({ definitionId }) => definitionId === provider.computerApp),
  );
}
