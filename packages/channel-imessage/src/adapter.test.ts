import { describe, expect, it, vi } from "vitest";
import {
  ChannelConnectionError,
  ChannelDeliveryError,
  createChannelId,
  type ChannelDelivery,
  type NormalizedChannelEvent,
} from "@opensteer/channel-core";
import type { ComputerUseIMessagePollResult, IMessageRow } from "@opensteer/protocol";
import {
  IMessageHelperError,
  createIMessageAdapter,
  type IMessageCursorStore,
  type IMessageHelperPort,
} from "./adapter.js";

/**
 * Every way the iMessage transport can go wrong between the Runner and the
 * Mac's helper, written before the adapter: a Mac with no desktop app, a
 * position lost after setup, a text the Host did not record, an account
 * changed or claimed elsewhere, a history rebuilt, and a reply whose answer
 * was lost.
 */
const bot = { handle: "bot@example.com", id: "A1B2C3D4-0000-4000-8000-000000000001" };
const accountId = createChannelId("account");

function row(rowId: number, text: string | null, handle = "+15551230000"): IMessageRow {
  return {
    guid: `guid-${rowId}`,
    message: text === null ? null : { handle, sentAt: "2026-09-22T10:00:00Z", text },
    rowId,
  };
}

function page(rows: IMessageRow[], overrides: Partial<ComputerUseIMessagePollResult> = {}) {
  return { account: "current", claim: "held", cursor: "valid", rows, ...overrides } as const;
}

function helper(pages: ComputerUseIMessagePollResult[] = []) {
  const polls: { after: { guid: string | null; rowId: number }; owner: string }[] = [];
  const queue = [...pages];
  const port: IMessageHelperPort & { polls: typeof polls } = {
    account: vi.fn(async () => ({ account: bot, end: { guid: "guid-40", rowId: 40 } })),
    poll: vi.fn(async (params) => {
      polls.push({ after: params.after, owner: params.owner });
      return queue.shift() ?? page([]);
    }),
    polls,
    send: vi.fn(async (params) => ({ key: params.key, sentAt: "2026-09-22T10:00:05Z" })),
  };
  return port;
}

function store(initial: Record<string, string> = {}) {
  const kept = new Map(Object.entries(initial));
  const cursors: IMessageCursorStore & { kept: Map<string, string> } = {
    kept,
    read: vi.fn(async (key: string) => kept.get(key) ?? null),
    write: vi.fn(async (key: string, cursor: string) => {
      kept.set(key, cursor);
    }),
  };
  return cursors;
}

/** Runs the transport until `until` holds, then stops it. */
async function run(
  port: IMessageHelperPort | null,
  cursors: IMessageCursorStore,
  options: {
    readonly initialCursor?: string | null;
    readonly onEvent?: (event: NormalizedChannelEvent) => Promise<void>;
    readonly until: () => boolean;
  },
) {
  const adapter = createIMessageAdapter({ cursors, helper: port, pollIntervalMs: 1 });
  const stop = new AbortController();
  const events: NormalizedChannelEvent[] = [];
  const ready = vi.fn(async () => undefined);
  const running = adapter.connection.run({
    accountId,
    credentials: {},
    expectedAccountExternalId: bot.id,
    initialCursor: options.initialCursor === undefined ? "40:guid-40" : options.initialCursor,
    onEvent: async (event) => {
      await options.onEvent?.(event);
      events.push(event);
    },
    onReady: ready,
    signal: stop.signal,
    transportKind: "computer",
  });
  await vi.waitFor(() => expect(options.until()).toBe(true), { interval: 2, timeout: 2_000 });
  stop.abort();
  await running;
  return { events, ready };
}

async function failure(
  port: IMessageHelperPort | null,
  cursors = store({ [accountId]: "40:guid-40" }),
) {
  const adapter = createIMessageAdapter({ cursors, helper: port, pollIntervalMs: 1 });
  return await adapter.connection
    .run({
      accountId,
      credentials: {},
      expectedAccountExternalId: bot.id,
      initialCursor: null,
      onEvent: async () => undefined,
      onReady: async () => undefined,
      signal: new AbortController().signal,
      transportKind: "computer",
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
}

describe("the iMessage adapter", () => {
  describe("setup", () => {
    it("needs the desktop app on this Mac", async () => {
      const inspection = await createIMessageAdapter({
        cursors: store(),
        helper: null,
      }).connection.inspect({
        credentials: {},
        transportKind: "computer",
      });
      expect(inspection).toMatchObject({ identity: null, ready: false });
      expect(inspection.issues[0]).toMatchObject({ kind: "configuration" });
      expect(inspection.issues[0]?.message).toContain("Opensteer desktop app");
    });

    it("needs Messages signed in to iMessage, and the helper's permission", async () => {
      const signedOut = helper();
      vi.mocked(signedOut.account).mockResolvedValue({ account: null, end: null });
      const out = await createIMessageAdapter({
        cursors: store(),
        helper: signedOut,
      }).connection.inspect({
        credentials: {},
        transportKind: "computer",
      });
      expect(out.ready).toBe(false);
      expect(out.issues[0]?.message).toContain("not signed in to iMessage");

      const withheld = helper();
      vi.mocked(withheld.account).mockRejectedValue(
        new IMessageHelperError(
          "permission-required",
          "Sending in Messages needs macOS Automation permission.",
        ),
      );
      const held = await createIMessageAdapter({
        cursors: store(),
        helper: withheld,
      }).connection.inspect({
        credentials: {},
        transportKind: "computer",
      });
      expect(held.issues[0]).toMatchObject({
        kind: "permissions",
        message: "Sending in Messages needs macOS Automation permission.",
      });
    });

    it("names the Apple account and starts after the whole existing history", async () => {
      const inspection = await createIMessageAdapter({
        cursors: store(),
        helper: helper(),
      }).connection.inspect({
        credentials: {},
        transportKind: "computer",
      });
      expect(inspection.ready).toBe(true);
      expect(inspection.identity).toMatchObject({
        externalAccountId: bot.id,
        externalIdentityId: bot.id,
        handle: bot.handle,
        metadata: { initialCursor: "40:guid-40" },
      });
      const empty = helper();
      vi.mocked(empty.account).mockResolvedValue({ account: bot, end: null });
      const fresh = await createIMessageAdapter({
        cursors: store(),
        helper: empty,
      }).connection.inspect({
        credentials: {},
        transportKind: "computer",
      });
      expect(fresh.identity?.metadata).toEqual({ initialCursor: "0:" });
    });
  });

  describe("reading", () => {
    it("starts from where setup left off, and keeps its own place from then on", async () => {
      const port = helper([page([])]);
      const cursors = store();
      const { ready } = await run(port, cursors, { until: () => port.polls.length >= 1 });
      expect(port.polls[0]).toEqual({ after: { guid: "guid-40", rowId: 40 }, owner: accountId });
      expect(cursors.kept.get(accountId)).toBe("40:guid-40");
      expect(ready).toHaveBeenCalled();
    });

    it("stops for a person when a Mac lost its place after the channel was connected", async () => {
      const error = await failure(helper(), store());
      expect(error).toBeInstanceOf(ChannelConnectionError);
      expect((error as ChannelConnectionError).retryable).toBe(false);
      expect((error as ChannelConnectionError).message).toContain("lost its place");
    });

    it("hands each text on as a direct message from its sender, in order, passing over the rest", async () => {
      const port = helper([
        page([row(41, "What's on today?"), row(42, null), row(43, "And tomorrow?")]),
      ]);
      const cursors = store();
      const { events } = await run(port, cursors, {
        until: () => cursors.kept.get(accountId) === "43:guid-43",
      });
      expect(events.map(({ eventId }) => eventId)).toEqual(["guid-41", "guid-43"]);
      expect(events[0]).toEqual({
        accountExternalId: bot.id,
        actor: { displayName: "+15551230000", externalUserId: "+15551230000" },
        content: [{ text: "What's on today?", type: "text" }],
        conversation: {
          displayName: null,
          externalConversationId: "+15551230000",
          externalScopeId: null,
          externalThreadId: null,
          type: "dm",
        },
        eventId: "guid-41",
        occurredAt: "2026-09-22T10:00:00Z",
        provider: "imessage",
        providerMessageId: "guid-41",
        trigger: "direct-message",
      });
    });

    it("never moves past a text the Host did not record, and hands it on again", async () => {
      const port = helper([page([row(41, "first"), row(42, "second")]), page([row(42, "second")])]);
      const cursors = store();
      let refusals = 0;
      const { events } = await run(port, cursors, {
        onEvent: async (event) => {
          if (event.eventId === "guid-42" && refusals === 0) {
            refusals += 1;
            throw new Error("The Host did not answer in time");
          }
        },
        until: () => cursors.kept.get(accountId) === "42:guid-42",
      });
      expect(events.map(({ eventId }) => eventId)).toEqual(["guid-41", "guid-42"]);
      expect(port.polls[1]?.after).toEqual({ guid: "guid-41", rowId: 41 });
    });

    it("waits for a person to fix the Mac, and stops for good when its history was rebuilt", async () => {
      const cases: [Partial<ComputerUseIMessagePollResult>, string, boolean][] = [
        [{ account: "changed" }, "different Apple account", true],
        [{ account: "signed-out" }, "not signed in to iMessage", true],
        [{ claim: "busy" }, "Another Opensteer on this Mac", true],
        [{ cursor: "rebuilt" }, "rebuilt", false],
      ];
      for (const [overrides, sentence, retryable] of cases) {
        const error = await failure(helper([page([], overrides)]));
        expect(error, sentence).toBeInstanceOf(ChannelConnectionError);
        expect((error as ChannelConnectionError).retryable, sentence).toBe(retryable);
        expect((error as Error).message).toContain(sentence);
      }
      const withheld = helper();
      vi.mocked(withheld.poll).mockRejectedValue(
        new IMessageHelperError(
          "permission-required",
          "Reading Messages needs macOS Full Disk Access.",
        ),
      );
      const denied = await failure(withheld);
      expect(denied).toBeInstanceOf(ChannelConnectionError);
      expect((denied as ChannelConnectionError).issue.kind).toBe("permissions");
      expect((denied as ChannelConnectionError).retryable).toBe(true);
    });

    it("rides out a desktop app that is not answering, to be tried again", async () => {
      const port = helper();
      vi.mocked(port.poll).mockRejectedValue(
        new IMessageHelperError("failed", "The Opensteer desktop app is not running on this Mac."),
      );
      const error = await failure(port);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ChannelConnectionError);
    });
  });

  describe("sending", () => {
    const delivery = {
      accountId,
      attempts: 0,
      audience: "conversation",
      content: [{ text: "On it.", type: "text" }],
      conversationId: null,
      createdAt: "2026-09-22T10:00:01Z",
      id: createChannelId("delivery"),
      kind: "reply",
      lastError: null,
      messageId: null,
      receipt: null,
      status: "leased",
      updatedAt: "2026-09-22T10:00:01Z",
    } as ChannelDelivery;
    const destination = {
      externalConversationId: "+15551230000",
      externalScopeId: null,
      externalThreadId: null,
      externalUserId: null,
    };
    const lease = { accountId, externalAccountId: bot.id, secrets: {} };

    it("replies from the bound account, keyed by the delivery so it happens once", async () => {
      const port = helper();
      const adapter = createIMessageAdapter({ cursors: store(), helper: port });
      await expect(
        adapter.outbound.send({
          delivery,
          destination,
          lease,
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({ receipt: { key: delivery.id, sentAt: "2026-09-22T10:00:05Z" } });
      expect(port.send).toHaveBeenCalledWith({
        accountId: bot.id,
        key: delivery.id,
        owner: accountId,
        text: "On it.",
        to: "+15551230000",
      });
      // Nothing to look up: sending again with the same key is the lookup.
      await expect(
        adapter.outbound.reconcile({
          delivery,
          destination,
          lease,
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({ kind: "unknown" });
    });

    it("stops a send the helper cannot confirm, but retries definite refusals", async () => {
      const cases = [
        ["delivery-unconfirmed", "dead"],
        ["outcome-unknown", "unknown"],
        ["busy", "retryable"],
        ["failed", "retryable"],
        ["permission-required", "retryable"],
      ] as const;
      for (const [code, kind] of cases) {
        const port = helper();
        vi.mocked(port.send).mockRejectedValue(
          new IMessageHelperError(code, "Messages did not confirm the send."),
        );
        const error = await createIMessageAdapter({ cursors: store(), helper: port })
          .outbound.send({ delivery, destination, lease, signal: new AbortController().signal })
          .catch((caught: unknown) => caught);
        expect(error, code).toBeInstanceOf(ChannelDeliveryError);
        expect((error as ChannelDeliveryError).kind, code).toBe(kind);
      }
    });

    it("reconciles a lost transport answer using the same delivery key", async () => {
      const port = helper();
      vi.mocked(port.send).mockRejectedValueOnce(new Error("Bridge disconnected"));
      const adapter = createIMessageAdapter({ cursors: store(), helper: port });
      const input = { delivery, destination, lease, signal: new AbortController().signal };
      await expect(adapter.outbound.send(input)).rejects.toMatchObject({ kind: "unknown" });
      await expect(adapter.outbound.send(input)).resolves.toMatchObject({
        receipt: { key: delivery.id },
      });
      expect(vi.mocked(port.send).mock.calls.map(([params]) => params.key)).toEqual([
        delivery.id,
        delivery.id,
      ]);
    });

    it("cannot reply on a Mac without the desktop app", async () => {
      const error = await createIMessageAdapter({ cursors: store(), helper: null })
        .outbound.send({ delivery, destination, lease, signal: new AbortController().signal })
        .catch((caught: unknown) => caught);
      expect((error as ChannelDeliveryError).kind).toBe("retryable");
    });
  });
});
