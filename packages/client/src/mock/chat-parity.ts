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
      /**
       * Which Run the page asks to stop: the one the chat's list names now ("listed"), or the one
       * it named the last time it named one, from a page read before that Run ended ("ended").
       * After an accepted Stop of a listed Run, its device answers: the Run ends, interrupted.
       */
      readonly run: "listed" | "ended";
    }
  | {
      readonly kind: "connection.update";
      readonly account: string;
      readonly chat: string;
      /** "stale": the revision before the current one, as a page read before the last save. */
      readonly revision: "current" | "stale";
      readonly accessMode?: ThreadAccessMode;
      readonly grant?: AgentGrant;
      readonly label?: string;
    }
  | { readonly kind: "connection.revoke"; readonly account: string; readonly chat: string }
  | { readonly kind: "connection.remove"; readonly account: string; readonly chat: string }
  | { readonly kind: "me.link"; readonly account: string }
  | { readonly kind: "account.check"; readonly account: string }
  /** Adds an account with its tokens (bring your own app), as the Messaging page's form does. */
  | { readonly kind: "account.create"; readonly provider: string; readonly token: string }
  /** Adds an account reached through the person's computer (Messages on a Mac). */
  | { readonly kind: "account.computer.create"; readonly provider: string }
  /** `token` names the workspace the bot token belongs to (`chatParityProvider`). */
  | { readonly kind: "credentials.replace"; readonly account: string; readonly token: string };

export interface ChatParityStep {
  readonly name: string;
  readonly command: ChatParityCommand;
  /**
   * Why the preview's answer can't be the Home's here (a step that needs a provider the test
   * cannot have): it is recorded, and the preview's must still be one the Home can give.
   */
  readonly notComparable?: string;
}

/**
 * Every command and read the Messaging, chat and connected-agent screens send, by the parity
 * step kinds that cover them. A screen's client that sends one not listed here fails
 * `tests/chat-parity-coverage.test.ts`; one listed with no accepted and no refused step in the fixture
 * fails it too.
 */
export const chatScreenSends = {
  "channel.chat.create": "chat.create",
  "channel.connection.create": "account.create",
  "channel.connection.computer.create": "account.computer.create",
  "channel.connection.status.set": "account.status",
  "channel.me.link": "me.link",
  "channel.connection.check": "account.check",
  "channel.connection.credentials.replace": "credentials.replace",
  "connection.update": "connection.update",
  "connection.revoke": "connection.revoke",
  "connection.remove": "connection.remove",
  "run.interrupt": "task.stop",
} as const satisfies Record<string, ChatParityCommand["kind"]>;

/** The reads every step's views are made of: each step records both, as the screens read them. */
export const chatParityViewReads = ["channels.get", "connections.list"] as const;

/** Commands the Home never refuses, by why: a second step that repeats it stands for a refusal. */
export const chatParityRefusesNothing = {
  "connection.revoke":
    "Disconnect is never refused: a second one, from another device or a retry, is answered done and finishes stopping what the first began.",
} as const satisfies Partial<Record<keyof typeof chatScreenSends, string>>;

/**
 * The messaging provider both sides of the script reach: the Home's messaging runtime in
 * `chat-parity.integration.test.ts`, and the preview Home's (`MockHostClient`'s
 * `messagingProvider`) in `chat-parity.test.ts`. It says yes, as a provider does to tokens it
 * knows: a Slack workspace named after its bot token (`xoxb-<name>` is the workspace "<name>",
 * account `T-<name>`). So adding an account, checking one and replacing its tokens are compared
 * like any other step.
 */
export const chatParityProvider = {
  inspect(input: {
    readonly credentials: Readonly<Record<string, string>>;
    readonly provider: string;
    readonly account?: { readonly externalAccountId: string; readonly displayName: string };
  }): import("@opensteer/channel-core").ChannelConnectionInspection {
    // An account the preview holds no tokens for is the one its own tokens name.
    const name =
      input.credentials.botToken === undefined && input.account
        ? input.account.externalAccountId.replace(/^T-/u, "")
        : (input.credentials.botToken ?? "").replace(/^xoxb-/u, "");
    if (input.provider !== "slack" || name === "")
      return {
        capabilities: [],
        identity: null,
        issues: [
          {
            code: "credentials",
            kind: "credentials",
            message: "The provider did not accept these tokens.",
            missing: [],
          },
        ],
        ready: false,
      };
    return {
      capabilities: [],
      identity: {
        accountDisplayName: name,
        connectionDisplayName: name,
        externalAccountId: `T-${name}`,
        externalIdentityId: `U-${name}`,
        handle: null,
        metadata: {},
      },
      issues: [],
      ready: true,
    };
  },
};

/**
 * Commands whose accepted side no step can compare, by why: the coverage test takes these in
 * place of an accepted step, and nothing else.
 */
export const chatParityAcceptedOutside = {
  "channel.connection.computer.create":
    "Adding iMessage is accepted only by a Mac whose Messages app is on and allowed to read and send; the script has no Mac. Both of its refusals are compared.",
} as const;

/** What those screens send that this script does not cover, by why; listed so it is seen. */
export const chatParityOutside = {
  "connections.activity":
    "Reads earlier sessions of a connected agent that works tasks itself. The connected agent Settings tests cover paging those sessions; the chat script starts Runs instead.",
  "threads.activity":
    "Reads operations on a task a connected agent works itself. The connected agent Settings tests cover the operations and pending Request; the chat script starts Runs instead.",
  "browser.profile.create":
    "Makes the browser profile a connected agent's new grant names, as Browser profiles makes one; this script runs no browser.",
} as const;

/** What a command came to: done, with the chat it made, or refused in the Home's words. */
export type ChatParityAnswer =
  | { readonly ok: true; readonly chat?: ChatParityChat }
  | {
      readonly ok: false;
      readonly code: string | null;
      readonly reason: string | null;
      readonly message: string;
    };

export interface ChatParityChat {
  readonly label: string;
  readonly state: string | null;
  readonly accessMode: string;
  readonly grant: unknown;
  /** Moves when what it may do changes (mode or grant), not for a new name. */
  readonly grantRevision: number | null;
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
    grantRevision: connection.grantRevision ?? null,
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
  const reason =
    typeof error === "object" &&
    error !== null &&
    "reason" in error &&
    typeof error.reason === "string"
      ? error.reason
      : null;
  return {
    ok: false,
    code,
    reason,
    message:
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof error.message === "string"
        ? error.message
        : String(error),
  };
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
