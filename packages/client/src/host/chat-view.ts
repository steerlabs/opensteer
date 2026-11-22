import type { AgentConnection } from "@opensteer/protocol";
import type { ConnectedAgentPhase } from "./connected-agent-view.js";
import { agentWords } from "./connected-agents-copy.js";

/**
 * What only a chat has beside any connected agent's page, in the person's words: where it
 * listens, who can give it work (fixed when it was added), why it ended, and replies that may
 * have been sent. Every sentence is read from the Home's facts; nothing here decides a state.
 */
export interface ChatFacts {
  readonly where: string;
  readonly speakers: { readonly title: string; readonly detail: string };
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
  const where =
    bridge.conversationId === null
      ? agentWords("chat.where.dm", { account, provider: bridge.provider })
      : agentWords("chat.where.channel", { conversation, account, provider: bridge.provider });
  const speakers =
    bridge.senders === "anyone"
      ? {
          title: agentWords("chat.speakers.anyone", { conversation }),
          detail: agentWords("chat.speakers.anyoneDetail"),
        }
      : bridge.me
        ? {
            title: agentWords("chat.speakers.me", { identity: bridge.me.displayName }),
            detail: agentWords("chat.speakers.meDetail", { identity: bridge.me.displayName }),
          }
        : {
            title: agentWords("chat.speakers.meNone"),
            detail: agentWords("chat.speakers.meNoneDetail", { provider: bridge.provider }),
          };
  const ending = phase === "stopping" || phase === "stopped" || phase === "revoked";
  const unknown = bridge.unknownReplies ?? 0;
  return {
    where,
    speakers,
    fixed: agentWords("chat.speakers.fixed"),
    ended: ending
      ? `${agentWords(endedWords[bridge.endedBy ?? "you"])} ${agentWords("chat.ended.again")}`
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
