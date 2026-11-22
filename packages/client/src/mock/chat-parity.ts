import type { ChannelDashboard } from "@opensteer/channel-core";
import type { AgentGrant, ThreadAccessMode } from "@opensteer/core";
import type { AgentConnection } from "@opensteer/protocol";

/**
 * The parity of the preview Home with the Home, for chats and messaging accounts. One script of
 * what a person does is run against a real Home (`chat-parity.integration.test.ts` in apps/host)
 * and against `MockHostClient` (`chat-parity.test.ts`); each answer and the views it leaves are
 * recorded in `chat-parity.fixture.json` and must be the same on both. Everything is named the
 * way the person sees it (an account's name, a chat's label, a task's title), never by id.
 */
export type ChatParityCommand =
  | {
      readonly kind: "chat.create";
      readonly account: string;
      readonly conversation: { readonly id: string; readonly name: string } | null;
      readonly senders: "owner" | "anyone";
      readonly accessMode: ThreadAccessMode;
      readonly grant: AgentGrant;
    }
  | {
      readonly kind: "account.status";
      readonly account: string;
      readonly status: "connected" | "paused" | "revoked";
    }
  | {
      readonly kind: "task.stop";
      readonly account: string;
      readonly chat: string;
      readonly task: string;
    };

export interface ChatParityStep {
  readonly name: string;
  readonly command: ChatParityCommand;
}

/** What a command came to: done, with the chat it made, or refused in the Home's words. */
export type ChatParityAnswer =
  | { readonly ok: true; readonly chat?: ChatParityChat }
  | { readonly ok: false; readonly code: string | null; readonly message: string };

export interface ChatParityChat {
  readonly label: string;
  readonly state: string | null;
  readonly accessMode: string;
  readonly grant: unknown;
  readonly account: string | null;
  readonly conversation: string | null;
  readonly senders: string;
  readonly me: string | null;
  readonly pausedBy: string | null;
  readonly pauseDetail: string | null;
  readonly pausedMessages: string | null;
  readonly endedBy: string | null;
  readonly grantShape: unknown;
  readonly tasks: readonly { readonly title: string; readonly running: boolean }[];
}

export interface ChatParityViews {
  readonly accounts: readonly {
    readonly name: string;
    readonly provider: string;
    readonly status: string;
    readonly connection: string | null;
    readonly detail: string | null;
    readonly me: string | null;
  }[];
  readonly chats: readonly ChatParityChat[];
}

export interface ChatParityRecord {
  /** The Home before the script, as its reads answer: what the preview Home starts from. */
  readonly seed: {
    readonly channels: ChannelDashboard;
    readonly connections: readonly AgentConnection[];
  };
  readonly start: ChatParityViews;
  readonly steps: readonly (ChatParityStep & {
    readonly answer: ChatParityAnswer;
    readonly views: ChatParityViews;
  })[];
}

export function chatParityChat(connection: AgentConnection): ChatParityChat {
  const bridge = connection.bridge!;
  return {
    label: connection.label,
    state: connection.state ?? null,
    accessMode: connection.accessMode,
    grant: connection.grant ?? null,
    account: bridge.accountName ?? null,
    conversation: bridge.conversationName ?? null,
    senders: bridge.senders,
    me: bridge.me?.displayName ?? null,
    pausedBy: bridge.pausedBy ?? null,
    pauseDetail: bridge.pauseDetail ?? null,
    pausedMessages: bridge.pausedMessages ?? null,
    endedBy: bridge.endedBy ?? null,
    grantShape: bridge.grantShape ?? null,
    tasks: (bridge.tasks ?? []).map(({ title, running }) => ({ title, running })),
  };
}

/** The two reads a person's screens make, by name, in a stable order. */
export function chatParityViews(
  channels: ChannelDashboard,
  connections: readonly AgentConnection[],
): ChatParityViews {
  const byName = (left: { name: string }, right: { name: string }) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  return {
    accounts: channels.accounts
      .map((account) => {
        const connection = channels.connections.find(({ id }) => id === account.connectionId);
        return {
          name: account.displayName,
          provider: account.provider,
          status: account.status,
          connection: connection?.status ?? null,
          detail: connection?.statusDetail ?? null,
          me: channels.me?.find(({ accountId }) => accountId === account.id)?.displayName ?? null,
        };
      })
      .sort(byName),
    chats: connections
      .filter((connection) => connection.bridge !== undefined)
      .map(chatParityChat)
      .sort((left, right) => {
        // Chats on different accounts may share a label (each account's direct messages).
        const a = `${left.account ?? ""}\u0000${left.label}`;
        const b = `${right.account ?? ""}\u0000${right.label}`;
        return a < b ? -1 : a > b ? 1 : 0;
      }),
  };
}

/** An answer as both sides give it: a refusal's code and words, or done. */
export function chatParityRefusal(error: unknown): ChatParityAnswer {
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : null;
  return { ok: false, code, message: error instanceof Error ? error.message : String(error) };
}

const idPattern = /^([a-z]+)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const timePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/u;

/**
 * The same value with every id replaced by a stable one of its kind (in the order first met)
 * and every time by one instant: what a fixture keeps of a Home's answer.
 */
export function chatParityNormalized<T>(value: T): T {
  const ids = new Map<string, string>();
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") {
      const id = idPattern.exec(item);
      if (id) {
        let next = ids.get(item);
        if (!next) {
          next = `${id[1]}_00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, "0")}`;
          ids.set(item, next);
        }
        return next;
      }
      return timePattern.test(item) ? "2026-01-01T00:00:00.000Z" : item;
    }
    if (Array.isArray(item)) return item.map(walk);
    if (item !== null && typeof item === "object")
      return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, walk(entry)]));
    return item;
  };
  return walk(value) as T;
}
