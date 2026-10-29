import { ManualClock } from "@opensteer/shared/test-support/clock";
import {
  AgentEventSchema,
  createId,
  notificationPushWindowMilliseconds,
  type AgentEvent,
} from "@opensteer/core";
import type { DecidedNotification } from "@opensteer/database";
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
  const event = AgentEventSchema.parse({
    createdAt: instant.toISOString(),
    data: { replyMessageId: messageId, status: "completed" },
    environmentId: createId("environment"),
    eventId: createId("event"),
    runId: createId("run"),
    sequence: "3",
    threadId: createId("thread"),
    type: "run.completed",
    workspaceId: createId("workspace"),
  });
  const decided: DecidedNotification = {
    userId: createId("user"),
    view: {
      body: "Done",
      id: createId("notification"),
      kind,
      messageId: kind === "reply-published" ? messageId : null,
      occurredAt: event.createdAt,
      requestId: kind === "request-opened" ? requestId : null,
      runId: event.runId,
      threadId: event.threadId,
      title: "Opensteer",
      workspaceId: event.workspaceId,
    },
  };
  return { event, decided };
}
function setup(
  input: {
    readonly timing?: Pick<NotificationDispatcherOptions, "now" | "wait">;
    readonly kind?: "reply-published" | "request-opened";
    readonly ready?: Promise<void>;
    readonly answers?: readonly (number | "network" | "not-configured")[];
    readonly noTarget?: boolean;
  } = {},
) {
  const { event, decided } = fixture(input.kind);
  const calls: { at: number; body: Record<string, unknown>; authorization: string | null }[] = [];
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
    if (answer === "not-configured")
      return new Response(JSON.stringify({ error: { reason: "push-not-configured" } }), {
        status: 404,
      });
    return new Response(
      answer === 202
        ? JSON.stringify({ accepted: true, deliveries: 1, notificationId: decided.view.id })
        : "",
      { status: answer },
    );
  });
  const store = {
    decide: vi.fn(async (_event: AgentEvent) => [decided]),
    publicationSkipReason: vi.fn(async () => null as string | null),
    accountSubjects: vi.fn(async () => [`acct_${crypto.randomUUID()}`] as readonly string[]),
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
  return { dispatcher, event, decided, store, target, fetch, calls, onLive, onError, onWarning };
}
const dispatchers: NotificationDispatcher[] = [];
function start(input: Parameters<typeof setup>[0] = {}) {
  const result = setup(input);
  dispatchers.push(result.dispatcher);
  result.dispatcher.dispatch(result.event);
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
  it("drains the complete grace and retry intervals on a domain clock", async () => {
    const clock = new ManualClock(instant.getTime());
    const f = start({
      answers: [503, 202],
      timing: { now: () => new Date(clock.now()), wait: clock.wait },
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
    const f = start({ kind: "request-opened" });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(1);
    const answered = setup({ kind: "request-opened" });
    dispatchers.push(answered.dispatcher);
    answered.store.publicationSkipReason.mockResolvedValue("answered");
    answered.dispatcher.dispatch(answered.event);
    await vi.advanceTimersByTimeAsync(0);
    expect(answered.calls).toEqual([]);
  });
  it("H5 never decides or delivers an event at or past the window", async () => {
    const f = setup();
    dispatchers.push(f.dispatcher);
    vi.setSystemTime(instant.getTime() + notificationPushWindowMilliseconds);
    f.dispatcher.dispatch(f.event);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.decide).not.toHaveBeenCalled();
    expect(f.onLive).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  });
  it("H6 retries network, 5xx and 429 after 1, 2, 4, 8, 16 seconds then logs one drop", async () => {
    const f = start({ kind: "request-opened", answers: ["network", 503, 429, 500, 503, 503] });
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
    const f = start({ kind: "request-opened", answers: [503, 202] });
    const bad = start({ kind: "request-opened", answers: [400] });
    const missing = start({ kind: "request-opened", answers: ["not-configured"] });
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
    const f = start({ noTarget: true });
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
    const retry = start({ kind: "request-opened", answers: [503] });
    await vi.advanceTimersByTimeAsync(0);
    retry.store.accountSubjects.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(retry.calls).toHaveLength(1);
    expect(retry.onError).not.toHaveBeenCalled();
  });
  it("H11 resolves a changed Personal target for each retry", async () => {
    const f = start({ kind: "request-opened", answers: [503] });
    await vi.advanceTimersByTimeAsync(0);
    f.target.mockResolvedValue({
      controlApiOrigin: new URL("https://new.invalid"),
      hostCredential: `osc_${"b".repeat(43)}`,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.calls[1]?.authorization).toBe(`Bearer osc_${"b".repeat(43)}`);
  });
  it("logs once when readiness outlasts the window", async () => {
    const f = start({ ready: new Promise<void>(() => undefined) });
    await vi.advanceTimersByTimeAsync(notificationPushWindowMilliseconds);
    expect(f.calls).toEqual([]);
    expect(f.onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ reason: "Notification push window closed" }),
    );
  });
  it("H8/H12 closes pending holds and retries and unresolved readiness promptly", async () => {
    const hold = start();
    const retry = start({ kind: "request-opened", answers: [503] });
    const waiting = start({ kind: "request-opened", ready: new Promise<void>(() => undefined) });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([hold, retry, waiting].map(({ dispatcher }) => dispatcher.close()));
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hold.calls).toEqual([]);
    expect(retry.calls).toHaveLength(1);
    expect(waiting.calls).toEqual([]);
  });
  it("H8 aborts and awaits the in-flight request and ignores events after close", async () => {
    const f = setup({ kind: "request-opened" });
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
            { once: true },
          );
        }),
    );
    f.dispatcher.dispatch(f.event);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    await f.dispatcher.close();
    expect(finished).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    f.dispatcher.dispatch(f.event);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.onLive).toHaveBeenCalledTimes(1);
    expect(f.onError).not.toHaveBeenCalled();
  });
});
