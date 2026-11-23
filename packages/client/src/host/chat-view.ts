import type { ChannelProviderManifest } from "@opensteer/channel-core";
import type { AgentConnection, MachineSummary } from "@opensteer/protocol";
import { RunIdSchema, ThreadIdSchema } from "@opensteer/core";
import type { ChatScreenCommand } from "./chat-screen-host.js";
import { HostClientRequestError, type HostSnapshot } from "./client.js";
import type { ConnectedAgentPhase } from "./connected-agent-view.js";
import { threadInDirectory } from "./host-snapshot-selectors.js";
import { agentWords } from "./connected-agents-copy.js";
import { plainSentence as plain, sentenceWith, type SentencePart } from "./sentence-parts.js";

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
    readonly runId: string | null;
  }[];
}

export function chatFacts(
  connection: AgentConnection,
  phase: ConnectedAgentPhase,
): ChatFacts | null {
  const bridge = connection.bridge;
  if (!bridge) return null;
  // The account by what its field is: its handle an address, its display name a name.
  const account = chatAccountPart(bridge);
  const conversation = { name: bridge.conversationName ?? bridge.conversationId ?? "" };
  const whereParts = sentenceWith(
    (slot) =>
      bridge.conversationId === null
        ? agentWords("chat.where.dm", { account: slot("account"), provider: bridge.provider })
        : agentWords("chat.where.channel", {
            conversation: slot("conversation"),
            account: slot("account"),
            provider: bridge.provider,
          }),
    { account, conversation },
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
          sentenceWith(
            (slot) => agentWords("chat.speakers.anyone", { conversation: slot("conversation") }),
            { conversation },
          ),
          [agentWords("chat.speakers.anyoneDetail")],
        )
      : identity !== undefined
        ? words(
            sentenceWith((slot) => agentWords("chat.speakers.me", { identity: slot("identity") }), {
              identity: { name: identity },
            }),
            sentenceWith(
              (slot) => agentWords("chat.speakers.meDetail", { identity: slot("identity") }),
              { identity: { name: identity } },
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

/** A chat's recent task as it is now. */
export interface ChatTaskNow {
  readonly id: string;
  readonly title: string;
  readonly running: boolean;
  /**
   * The Run it is doing, which Stop interrupts: a Stop is asked of that Run, and a later Run of
   * the task is a new one with a Stop of its own. Null while the chat's list has not caught up.
   */
  readonly runId: string | null;
}

/**
 * A chat's recent tasks as the Home's live task updates say they are now: running while the task
 * runs, as the Home's list counts it (`status` "running"). The chat's own list names its recent
 * tasks and the Run each is doing, and is read when the connection changes; `behind` says a live
 * update moved a task past it, so the page reads it again: once per such change, never on a timer.
 */
export function chatTasksNow(
  tasks: ChatFacts["tasks"],
  directory: Pick<HostSnapshot, "threads" | "tasks" | "activeTasks">,
): {
  readonly tasks: readonly ChatTaskNow[];
  /** What the live updates say that the list does not yet, as a key; null when it agrees. */
  readonly behind: string | null;
} {
  const moved: string[] = [];
  const now = tasks.map((task) => {
    const live = threadInDirectory(task.id, directory);
    const running = live ? live.status === "running" : task.running;
    if (running !== task.running) moved.push(`${task.id}:${running}`);
    // Running by the list, and held by no live update: the list is read again to know.
    else if (!live && task.running) moved.push(`${task.id}:unseen`);
    return {
      id: task.id,
      title: live?.title ?? task.title,
      running,
      runId: running && task.running ? task.runId : null,
    };
  });
  return { tasks: now, behind: moved.length === 0 ? null : moved.join(",") };
}

/**
 * The Home's answer to a Stop of a Run that had already ended: not a failure, the Run ended. The
 * page reads the chat's list again and says nothing.
 */
export function chatStopFoundRunEnded(error: unknown): boolean {
  return (
    error instanceof HostClientRequestError &&
    error.code === "conflict" &&
    error.message === "Run is already terminal"
  );
}

/** Stop, of the one Run the task is doing: the Home interrupts that Run and no later one. */
export function chatTaskStop(
  task: ChatTaskNow & { readonly runId: string },
  idempotencyKey: string,
): ChatScreenCommand {
  return {
    type: "run.interrupt",
    threadId: ThreadIdSchema.parse(task.id),
    runId: RunIdSchema.parse(task.runId),
    idempotencyKey,
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

/** A chat's account as a part, by what its field is: its handle an address, its name a name. */
export function chatAccountPart(
  bridge: Pick<
    NonNullable<AgentConnection["bridge"]>,
    "accountHandle" | "accountName" | "provider"
  >,
): { readonly address: string } | { readonly name: string } {
  return bridge.accountHandle
    ? { address: bridge.accountHandle }
    : { name: bridge.accountName ?? bridge.provider };
}

/** A Messaging account as a part: its handle, where it has one, an address; else its name. */
export function messagingAccountPart(account: {
  readonly handle: string | null;
  readonly displayName: string;
}): { readonly address: string } | { readonly name: string } {
  return account.handle ? { address: account.handle } : { name: account.displayName };
}

/**
 * A Messaging account's title: the handle of its one account (an iMessage address), or the
 * connection's own name (a Slack workspace's). The same on the web and the phone.
 */
export function messagingAccountTitle(
  connection: { readonly displayName: string },
  accounts: readonly { readonly handle: string | null; readonly displayName: string }[],
): { readonly address: string } | { readonly name: string } {
  const [only, ...more] = accounts;
  return only?.handle && more.length === 0
    ? { address: only.handle }
    : { name: connection.displayName };
}
