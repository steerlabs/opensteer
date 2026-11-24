import { ManualClock } from "@opensteer/shared/test-support/clock";
import { createId, notificationPushWindowMilliseconds } from "@opensteer/core";
import type {
  DecidedNotification,
  NotificationPublication,
  NotificationTransition,
} from "@opensteer/database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NotificationDispatcher,
  type NotificationDispatcherOptions,
} from "./notification-dispatcher.js";
import { NotificationPublicationClient } from "./notification-publication-client.js";
const instant = new Date("2026-10-01T12:00:00Z");
function fixture(kind: "reply-published" | "request-opened" = "reply-published") {
  const messageId = createId("message");
  const requestId = createId("request");
  const runId = createId("run");
  const threadId = createId("thread");
  const change: NotificationTransition =
    kind === "reply-published"
      ? { type: "replyPublished", runId, threadId, messageId }
      : {
          type: "requestChanged",
          runId,
          threadId,
          requestId,
          kind: "person.question",
          status: "pending",
          opened: true,
        };
  const decided: DecidedNotification = {
    userId: createId("user"),
    view: {
      body: "Done",
      id: createId("notification"),
      kind,
      messageId: kind === "reply-published" ? messageId : null,
      occurredAt: instant.toISOString(),
      requestId: kind === "request-opened" ? requestId : null,
      runId,
      threadId,
      title: "Opensteer",
    },
  };
  return {
    change,
    decided,
  };
}
function setup(
  input: {
    readonly timing?: Pick<NotificationDispatcherOptions, "now" | "wait">;
    readonly kind?: "reply-published" | "request-opened";
    readonly ready?: Promise<void>;
    readonly answers?: readonly (number | "network" | "not-configured" | "garbled")[];
    readonly noTarget?: boolean;
    /** A connected agent's Request: its alert is an attempt in that connection's Disconnect set. */
    readonly connection?: string;
  } = {},
) {
  const { change, decided } = fixture(input.kind);
  const calls: {
    at: number;
    body: Record<string, unknown>;
    authorization: string | null;
  }[] = [];
  const target = vi.fn(async () =>
    input.noTarget
      ? null
      : {
          controlApiOrigin: new URL("https://accounts.invalid"),
          hostCredential: `osc_${"a".repeat(43)}`,
        },
  );
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    calls.push({
      at: Date.now(),
      body: JSON.parse(String(init?.body)),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    const answer = input.answers?.[calls.length - 1] ?? 202;
    if (answer === "network") throw new Error(`Bearer osc_${"a".repeat(43)}`);
    if (answer === "garbled") return new Response("{", { status: 202 });
    if (answer === "not-configured")
      return new Response(
        JSON.stringify({
          error: {
            reason: "push-not-configured",
          },
        }),
        {
          status: 404,
        },
      );
    return new Response(
      answer === 202
        ? JSON.stringify({
            accepted: true,
            deliveries: 1,
            notificationId: decided.view.id,
          })
        : "",
      {
        status: answer,
      },
    );
  });
  /**
   * What the hand-off statement reads: whether the connection is still live. The Request still
   * pending is read from `publicationSkipReason`, the same fact the dispatcher reads earlier.
   */
  const world = { live: true };
  const settled: { readonly id: string; readonly state: string }[] = [];
  const store = {
    decide: vi.fn(async (_change: NotificationTransition) => [
      { ...decided, sequence: "3", connectionId: input.connection ?? null },
    ]),
    publicationSkipReason: vi.fn(async (_entry?: NotificationPublication) => null as string | null),
    accountSubjects: vi.fn(async () => [`acct_${crypto.randomUUID()}`] as readonly string[]),
    beginPublication: vi.fn(async (entry: NotificationPublication) =>
      world.live && !(await store.publicationSkipReason(entry))
        ? { kind: "begun" as const, attemptId: "cat_fixture" }
        : { kind: "refused" as const, reason: "withdrawn" },
    ),
    continuePublication: vi.fn(
      async (_id: string, entry: NotificationPublication) =>
        world.live && !(await store.publicationSkipReason(entry)),
    ),
    settlePublication: vi.fn(async (id: string, state: "done" | "failed" | "unknown") => {
      settled.push({ id, state });
    }),
  };
  const onLive = vi.fn<NotificationDispatcherOptions["onLive"]>();
  const onError = vi.fn<NotificationDispatcherOptions["onError"]>();
  const onWarning = vi.fn<NotificationDispatcherOptions["onWarning"]>();
  const dispatcher = new NotificationDispatcher({
    ...input.timing,
    store,
    ready: input.ready ?? Promise.resolve(),
    onLive,
    onError,
    onWarning,
    client: new NotificationPublicationClient({
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance"),
      target,
      fetch,
    }),
  });
  return {
    dispatcher,
    change,
    decided,
    store,
    world,
    settled,
    target,
    fetch,
    calls,
    onLive,
    onError,
    onWarning,
  };
}
const dispatchers: NotificationDispatcher[] = [];
function start(input: Parameters<typeof setup>[0] = {}) {
  const result = setup(input);
  dispatchers.push(result.dispatcher);
  result.dispatcher.dispatch(result.change);
  return result;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(instant);
});
afterEach(async () => {
  await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.close()));
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});
describe("NotificationDispatcher", () => {
  it("does not publish a request notice withdrawn during recipient lookup", async () => {
    const f = setup({ kind: "request-opened", connection: "agc_fixture" });
    dispatchers.push(f.dispatcher);
    const accountIds = await f.store.accountSubjects();
    f.store.accountSubjects.mockClear();
    const recipients = Promise.withResolvers<readonly string[]>();
    f.store.accountSubjects.mockReturnValueOnce(recipients.promise);
    f.dispatcher.dispatch(f.change);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.accountSubjects).toHaveBeenCalledOnce();
    f.store.publicationSkipReason.mockResolvedValue("Request was withdrawn");
    recipients.resolve(accountIds);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("drains the complete grace and retry intervals on a domain clock", async () => {
    const clock = new ManualClock(instant.getTime());
    const f = start({
      answers: [503, 202],
      timing: {
        now: () => new Date(clock.now()),
        wait: clock.wait,
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(0);
    clock.advanceBy(4_999);
    expect(f.calls).toHaveLength(0);
    await clock.runUntilSettled(f.dispatcher.drain());
    expect(clock.now() - instant.getTime()).toBe(6_000);
    expect(f.calls).toHaveLength(2);
    expect(f.onError).not.toHaveBeenCalled();
    expect(f.onWarning).not.toHaveBeenCalled();
  });
  it("H1 sends live immediately and posts a reply after exactly five seconds with a fifteen-minute window", async () => {
    const f = start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.onLive).toHaveBeenCalledExactlyOnceWith(f.decided);
    expect(f.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(f.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.body).toMatchObject({
      notificationId: f.decided.view.id,
      schemaVersion: 1,
      expiresAt: new Date(instant.getTime() + 15 * 60_000).toISOString(),
    });
  });
  it("H2 stops a reply read during its hold", async () => {
    const f = start();
    await vi.advanceTimersByTimeAsync(0);
    f.store.publicationSkipReason.mockResolvedValue("Reply was read before publication");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.calls).toEqual([]);
    expect(f.onError).not.toHaveBeenCalled();
  });
  it("H4 sends Requests immediately and suppresses an already answered Request", async () => {
    const f = start({
      kind: "request-opened",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(1);
    const answered = setup({
      kind: "request-opened",
    });
    dispatchers.push(answered.dispatcher);
    answered.store.publicationSkipReason.mockResolvedValue("answered");
    answered.dispatcher.dispatch(answered.change);
    await vi.advanceTimersByTimeAsync(0);
    expect(answered.calls).toEqual([]);
  });
  it("H5 never delivers a publication at or past the window", async () => {
    const f = setup();
    dispatchers.push(f.dispatcher);
    vi.setSystemTime(instant.getTime() + notificationPushWindowMilliseconds);
    f.dispatcher.dispatch(f.change);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.onLive).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  });
  it("uses the committed reply time for the push window", async () => {
    const f = setup();
    dispatchers.push(f.dispatcher);
    f.dispatcher.dispatch(f.change);
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.onLive).toHaveBeenCalledExactlyOnceWith(f.decided);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.body).toMatchObject({
      occurredAt: f.decided.view.occurredAt,
      expiresAt: new Date(instant.getTime() + notificationPushWindowMilliseconds).toISOString(),
    });
  });
  it("H6 retries network, 5xx and 429 after 1, 2, 4, 8, 16 seconds then logs one drop", async () => {
    const f = start({
      kind: "request-opened",
      answers: ["network", 503, 429, 500, 503, 503],
    });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(f.calls.map(({ at }) => at - instant.getTime())).toEqual([
      0, 1_000, 3_000, 7_000, 15_000, 31_000,
    ]);
    expect(f.store.publicationSkipReason).toHaveBeenCalledTimes(6);
    expect(f.target).toHaveBeenCalledTimes(6);
    expect(f.onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        notificationId: f.decided.view.id,
        kind: f.decided.view.kind,
        reason: expect.stringContaining("exhausted"),
      }),
    );
    expect(JSON.stringify(f.onError.mock.calls)).not.toContain("osc_");
  });
  it("H6 delivers a 503 then 202 and drops 400 or push-not-configured with one appropriate log", async () => {
    const f = start({
      kind: "request-opened",
      answers: [503, 202],
    });
    const bad = start({
      kind: "request-opened",
      answers: [400],
    });
    const missing = start({
      kind: "request-opened",
      answers: ["not-configured"],
    });
    await vi.advanceTimersByTimeAsync(32_000);
    expect(f.calls).toHaveLength(2);
    expect(f.onError).not.toHaveBeenCalled();
    expect(bad.calls).toHaveLength(1);
    expect(bad.onError).toHaveBeenCalledTimes(1);
    expect(missing.calls).toHaveLength(1);
    expect(missing.onWarning).toHaveBeenCalledTimes(1);
    expect(missing.onError).not.toHaveBeenCalled();
  });
  it("H7 skips absent targets and Account subjects quietly after live delivery", async () => {
    const f = start({
      noTarget: true,
    });
    const noSubject = start();
    noSubject.store.accountSubjects.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(40_000);
    for (const entry of [f, noSubject]) {
      expect(entry.onLive).toHaveBeenCalledTimes(1);
      expect(entry.calls).toEqual([]);
      expect(entry.onError).not.toHaveBeenCalled();
    }
  });
  it("H11 rechecks eligibility and subjects after readiness and between retries", async () => {
    let ready!: () => void;
    const f = start({
      ready: new Promise<void>((resolve) => {
        ready = resolve;
      }),
      answers: [503],
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.store.publicationSkipReason).not.toHaveBeenCalled();
    f.store.publicationSkipReason.mockResolvedValue("revoked during readiness");
    ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toEqual([]);
    const retry = start({
      kind: "request-opened",
      answers: [503],
    });
    await vi.advanceTimersByTimeAsync(0);
    retry.store.accountSubjects.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(retry.calls).toHaveLength(1);
    expect(retry.onError).not.toHaveBeenCalled();
  });
  it("H11 resolves a changed Personal target for each retry", async () => {
    const f = start({
      kind: "request-opened",
      answers: [503],
    });
    await vi.advanceTimersByTimeAsync(0);
    f.target.mockResolvedValue({
      controlApiOrigin: new URL("https://new.invalid"),
      hostCredential: `osc_${"b".repeat(43)}`,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.calls[1]?.authorization).toBe(`Bearer osc_${"b".repeat(43)}`);
  });
  it("logs once when readiness outlasts the window", async () => {
    const f = start({
      ready: new Promise<void>(() => undefined),
    });
    await vi.advanceTimersByTimeAsync(notificationPushWindowMilliseconds);
    expect(f.calls).toEqual([]);
    expect(f.onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        reason: "Notification push window closed",
      }),
    );
  });
  it("H8/H12 closes pending holds and retries and unresolved readiness promptly", async () => {
    const hold = start();
    const retry = start({
      kind: "request-opened",
      answers: [503],
    });
    const waiting = start({
      kind: "request-opened",
      ready: new Promise<void>(() => undefined),
    });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([hold, retry, waiting].map(({ dispatcher }) => dispatcher.close()));
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hold.calls).toEqual([]);
    expect(retry.calls).toHaveLength(1);
    expect(waiting.calls).toEqual([]);
  });
  it("H8 aborts and awaits the in-flight request and ignores events after close", async () => {
    const f = setup({
      kind: "request-opened",
    });
    dispatchers.push(f.dispatcher);
    let finished = false;
    f.fetch.mockImplementation(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              queueMicrotask(() => {
                finished = true;
                reject(new Error("aborted"));
              });
            },
            {
              once: true,
            },
          );
        }),
    );
    f.dispatcher.dispatch(f.change);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    await f.dispatcher.close();
    expect(finished).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    f.dispatcher.dispatch(f.change);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.onLive).toHaveBeenCalledTimes(1);
    expect(f.onError).not.toHaveBeenCalled();
  });

  describe("a connected agent's Request alert (A5)", () => {
    const connected = (input: Parameters<typeof setup>[0] = {}) =>
      start({ kind: "request-opened", connection: "agc_fixture", ...input });

    it("hands off once, after every await, and records it acknowledged", async () => {
      const f = connected();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.fetch).toHaveBeenCalledOnce();
      // The hand-off is the last thing before the request leaves.
      expect(f.store.beginPublication.mock.invocationCallOrder[0]!).toBeGreaterThan(
        f.target.mock.invocationCallOrder[0]!,
      );
      expect(f.store.beginPublication.mock.invocationCallOrder[0]!).toBeLessThan(
        f.fetch.mock.invocationCallOrder[0]!,
      );
      expect(f.settled).toEqual([{ id: "cat_fixture", state: "done" }]);
    });

    it("sends nothing when the Disconnect lands while the account target is resolved", async () => {
      const f = setup({ kind: "request-opened", connection: "agc_fixture" });
      dispatchers.push(f.dispatcher);
      const resolved = Promise.withResolvers<{
        controlApiOrigin: URL;
        hostCredential: string;
      } | null>();
      f.target.mockReturnValueOnce(resolved.promise);
      f.dispatcher.dispatch(f.change);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.target).toHaveBeenCalledOnce();
      f.world.live = false;
      resolved.resolve({
        controlApiOrigin: new URL("https://accounts.invalid"),
        hostCredential: `osc_${"a".repeat(43)}`,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(f.fetch).not.toHaveBeenCalled();
      // Refused where it would be recorded: no attempt, nothing to settle.
      expect(f.settled).toEqual([]);
    });

    it("sends nothing when the Request is withdrawn during the skip check", async () => {
      const f = setup({ kind: "request-opened", connection: "agc_fixture" });
      dispatchers.push(f.dispatcher);
      const skip = Promise.withResolvers<string | null>();
      f.store.publicationSkipReason.mockReturnValueOnce(skip.promise);
      f.dispatcher.dispatch(f.change);
      await vi.advanceTimersByTimeAsync(0);
      f.store.publicationSkipReason.mockResolvedValue("Request was withdrawn");
      skip.resolve(null);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.fetch).not.toHaveBeenCalled();
      expect(f.settled).toEqual([]);
    });

    it("completes the same attempt after a lost acknowledgement, never a second alert", async () => {
      const f = connected({ answers: ["network", 202] });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.calls).toHaveLength(2);
      expect(f.calls[0]!.body.notificationId).toBe(f.calls[1]!.body.notificationId);
      expect(f.store.beginPublication).toHaveBeenCalledOnce();
      expect(f.store.continuePublication).toHaveBeenCalledOnce();
      expect(f.settled).toEqual([{ id: "cat_fixture", state: "done" }]);
    });

    it("keeps a lost acknowledgement unknown when the Disconnect lands before the next send", async () => {
      const f = connected({ answers: ["network", 202] });
      await vi.advanceTimersByTimeAsync(0);
      expect(f.calls).toHaveLength(1);
      f.world.live = false;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.calls).toHaveLength(1);
      expect(f.settled).toEqual([{ id: "cat_fixture", state: "unknown" }]);
    });

    it("records unknown, not failed, when every acknowledgement was lost", async () => {
      const f = connected({ answers: [503, 503, 503, 503, 503, 503] });
      await vi.advanceTimersByTimeAsync(31_000);
      expect(f.calls).toHaveLength(6);
      expect(f.settled).toEqual([{ id: "cat_fixture", state: "unknown" }]);
    });

    it("records unknown for an acknowledgement it could not read, and does not send it again", async () => {
      const f = connected({ answers: ["garbled"] });
      await vi.advanceTimersByTimeAsync(31_000);
      expect(f.calls).toHaveLength(1);
      expect(f.settled).toEqual([{ id: "cat_fixture", state: "unknown" }]);
    });

    it("records failed only when the account refused it before taking it", async () => {
      const bad = connected({ answers: [400] });
      const missing = connected({ answers: ["not-configured"] });
      await vi.advanceTimersByTimeAsync(31_000);
      expect(bad.settled).toEqual([{ id: "cat_fixture", state: "failed" }]);
      expect(missing.settled).toEqual([{ id: "cat_fixture", state: "failed" }]);
    });

    it("waits out a Disconnect during an in-flight send and records what the account said", async () => {
      const acknowledged = setup({ kind: "request-opened", connection: "agc_fixture" });
      const lost = setup({ kind: "request-opened", connection: "agc_fixture" });
      for (const f of [acknowledged, lost]) dispatchers.push(f.dispatcher);
      const answers = [
        Promise.withResolvers<Response>(),
        Promise.withResolvers<Response>(),
      ] as const;
      acknowledged.fetch.mockReturnValueOnce(answers[0].promise);
      lost.fetch.mockReturnValueOnce(answers[1].promise);
      for (const f of [acknowledged, lost]) f.dispatcher.dispatch(f.change);
      await vi.advanceTimersByTimeAsync(0);
      for (const f of [acknowledged, lost]) {
        expect(f.fetch).toHaveBeenCalledOnce();
        // In flight when the connection is disconnected: running, so the Disconnect waits.
        f.world.live = false;
        expect(f.settled).toEqual([]);
      }
      answers[0].resolve(
        new Response(
          JSON.stringify({
            accepted: true,
            deliveries: 1,
            notificationId: acknowledged.decided.view.id,
          }),
          { status: 202 },
        ),
      );
      answers[1].reject(new Error("socket hang up"));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(acknowledged.settled).toEqual([{ id: "cat_fixture", state: "done" }]);
      // Lost on the wire: never sent again, unknown.
      expect(lost.fetch).toHaveBeenCalledOnce();
      expect(lost.settled).toEqual([{ id: "cat_fixture", state: "unknown" }]);
    });

    it("records an attempt cut off by shutdown as unknown", async () => {
      const f = setup({ kind: "request-opened", connection: "agc_fixture" });
      dispatchers.push(f.dispatcher);
      f.fetch.mockImplementationOnce(
        async (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          }),
      );
      f.dispatcher.dispatch(f.change);
      await vi.advanceTimersByTimeAsync(0);
      await f.dispatcher.close();
      expect(f.settled).toEqual([{ id: "cat_fixture", state: "unknown" }]);
    });

    it("leaves your own agents' Request alerts exactly as they were", async () => {
      const f = start({ kind: "request-opened", answers: [503, 202] });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.calls).toHaveLength(2);
      expect(f.store.beginPublication).not.toHaveBeenCalled();
      expect(f.store.continuePublication).not.toHaveBeenCalled();
      expect(f.store.settlePublication).not.toHaveBeenCalled();
    });
  });
});
