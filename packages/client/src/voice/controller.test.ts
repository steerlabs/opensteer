import { BrowserSurfaceIdSchema, ThreadIdSchema, createId } from "@opensteer/core";
import { PersonShowMessageSchema } from "@opensteer/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolEntry } from "../host/client.js";
import { VoiceStartError, type VoiceCall, type VoiceSnapshot as Snapshot } from "./contract.js";
import { VoiceController, voiceAccount, type VoiceControllerInput } from "./controller.js";
import {
  settle,
  semanticVoice,
  voiceHost,
  voiceIdentity,
  voiceTestId,
  voiceTestNow,
} from "./voice.test-support.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(voiceTestNow);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup(
  options: { home?: "seeded" | "absent"; input?: Partial<VoiceControllerInput> } = {},
) {
  const f = voiceHost(options.home);
  const voice = semanticVoice();
  const onStart = vi.fn();
  const controller = new VoiceController({
    hostClient: f.host,
    media: voice.media,
    createProvider: () => voice.provider,
    createId: () => voiceTestId,
    onStart,
    ...options.input,
  });
  return {
    ...f,
    ...voice,
    controller,
    onStart,
    dispose: () => {
      controller.dispose();
      f.host.dispose();
    },
  };
}

function step(
  runId: string,
  state: ToolEntry["state"],
  name = "browser_tab_read",
  id = "step",
): ToolEntry {
  return {
    kind: "tool",
    id,
    callId: id,
    runId,
    createdAt: new Date(voiceTestNow).toISOString(),
    arguments: {},
    integration: null,
    isError: false,
    output: undefined,
    state,
    streamText: "",
    tool: { namespace: "opensteer", name },
  };
}

describe("VoiceController", () => {
  it("never opens a call or touches media while consent is pending or declined", async () => {
    const permission = Promise.withResolvers<boolean>();
    const f = setup({ input: { authorize: () => permission.promise } });
    const opening = f.controller.start();
    await settle();
    expect(f.provider.open).not.toHaveBeenCalled();
    expect(f.onStart).not.toHaveBeenCalled();
    permission.resolve(false);
    await opening;
    expect(f.provider.open).not.toHaveBeenCalled();
    expect(f.controller.call()).toBeNull();
    f.dispose();
  });
  it("selects Chat's signed-in Codex subscription account, then the first eligible account", () => {
    const f = setup();
    const snapshot = f.host.getSnapshot();
    const selected = voiceAccount(snapshot)!;
    expect(selected).not.toBeNull();
    const home = snapshot.threads.find((thread) => thread.id === snapshot.homeThreadId)!;
    expect(selected).toEqual({
      environmentId: home.environmentId,
      harnessInstanceId: home.harnessInstanceId,
    });
    expect(voiceAccount({ ...snapshot, homeThreadId: null })).not.toBeNull();
    const signedOut = {
      ...snapshot,
      environments: snapshot.environments.map((environment) => ({
        ...environment,
        harnessCatalogs: environment.harnessCatalogs.map((catalog) => ({
          ...catalog,
          connections: catalog.connections.map((connection) => ({
            ...connection,
            authKind: "api-key" as const,
          })),
        })),
      })),
    };
    expect(voiceAccount(signedOut)).toBeNull();
    expect(
      voiceAccount({
        ...snapshot,
        harnesses: snapshot.harnesses.map((harness) => ({ ...harness, enabled: false })),
      }),
    ).toBeNull();
    f.dispose();
  });

  it("gates availability on Host capability, media and an eligible account before mic access", async () => {
    const f = setup();
    expect(f.controller.getSnapshot().available).toBe(true);
    f.publish({ voiceAvailable: false });
    expect(f.controller.getSnapshot().available).toBe(false);
    await f.controller.start();
    expect(f.provider.open).not.toHaveBeenCalled();
    f.publish({ voiceAvailable: true, harnesses: [] });
    await f.controller.start();
    expect(f.provider.open).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot().notice?.kind).toBe("no-account");
    f.dispose();
    const g = setup({ input: { media: null } });
    expect(g.controller.getSnapshot().available).toBe(false);
    await g.controller.start();
    expect(g.provider.open).not.toHaveBeenCalled();
    g.dispose();
  });

  it("reads each phase from the call and the agent's own steps on its hidden Thread", async () => {
    const f = setup();
    const history: Snapshot["phase"][] = [];
    f.controller.subscribe(() => history.push(f.controller.getSnapshot().phase));
    const observe = vi.mocked(f.host.observeThread);
    await f.controller.start();
    const { threadId, runId } = f.call.identity;
    expect(f.onStart).toHaveBeenCalledTimes(1);
    expect(f.controller.call()).toEqual(f.call.identity);
    expect(observe, "the call's Thread was never held").toHaveBeenCalledWith(threadId);
    expect(f.controller.getSnapshot()).toMatchObject({
      phase: "listening",
      since: voiceTestNow,
      activity: null,
    });
    expect(f.media.keepAwake).toHaveBeenCalledWith(true);

    f.emit({ type: "hearing", text: "Open my" });
    expect(f.controller.getSnapshot()).toMatchObject({ phase: "hearing", heard: "Open my" });
    f.emit({ type: "heard", turnId: "one", text: "Open my reading list" });
    expect(f.controller.getSnapshot().phase).toBe("thinking");

    // The agent's tool step: the orb names it with a glyph, and a short gap does not flicker.
    f.publish({ transcripts: { [threadId]: [step(runId, "running")] } });
    expect(f.controller.getSnapshot()).toMatchObject({ phase: "thinking", activity: "browser" });
    f.publish({ transcripts: { [threadId]: [step(runId, "done")] } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.controller.getSnapshot()).toMatchObject({ phase: "thinking", activity: "browser" });
    // Another Run's step on the same Thread is not this call's agent.
    f.publish({ transcripts: { [threadId]: [step(createId("run"), "running")] } });
    await vi.advanceTimersByTimeAsync(600);
    expect(f.controller.getSnapshot()).toMatchObject({ phase: "listening", activity: null });

    f.emit({ type: "speaking", text: "It's open." });
    expect(f.controller.getSnapshot()).toMatchObject({ phase: "speaking", spoken: "It's open." });
    f.emit({ type: "spoke" });
    expect(f.controller.getSnapshot().phase).toBe("listening");

    // Working after the person speaks is bounded when the agent never starts a step.
    f.emit({ type: "heard", turnId: "two", text: "Thanks" });
    expect(f.controller.getSnapshot().phase).toBe("thinking");
    await vi.advanceTimersByTimeAsync(8_000);
    expect(f.controller.getSnapshot().phase).toBe("listening");
    expect(history).toContain("connecting");

    f.controller.setMuted(true);
    expect(f.call.setMuted).toHaveBeenLastCalledWith(true);
    await f.controller.stop();
    expect(f.controller.getSnapshot()).toMatchObject({ phase: "idle", since: null, muted: false });
    expect(f.controller.call()).toBeNull();
    expect(f.call.close).toHaveBeenCalledTimes(1);
    // Both holds end: Chat for the speaker, the call's Thread for its steps.
    expect(f.release).toHaveBeenCalledTimes(observe.mock.calls.length);
    expect(f.media.keepAwake).toHaveBeenLastCalledWith(false);
    f.dispose();
  });

  it("opens the Voice Thread before the first call", async () => {
    const f = setup();
    const snapshot = f.host.getSnapshot();
    const threadId = createId("thread");
    f.publish({ voiceThreadId: null });
    const open = vi.fn(async () => ({
      ok: true,
      data: { threadId, ...voiceAccount(snapshot) },
    }));
    Object.defineProperty(f.host, "rpc", { value: { "voice.open": open } });
    await f.controller.start();
    expect(open).toHaveBeenCalledExactlyOnceWith({
      ...voiceAccount(snapshot),
      accessMode: snapshot.executionPreferences.accessMode,
    });
    expect(f.provider.open).toHaveBeenCalledTimes(1);
    f.dispose();
  });

  it("follows the account the call is on, not the one it would pick now", async () => {
    const f = setup();
    const snapshot = f.host.getSnapshot();
    const account = voiceAccount(snapshot)!;
    const environment = snapshot.environments.find(({ id }) => id === account.environmentId)!;
    const catalog = environment.harnessCatalogs.find(
      ({ harnessInstanceId }) => harnessInstanceId === account.harnessInstanceId,
    )!;
    const harness = snapshot.harnesses.find(({ id }) => id === account.harnessInstanceId)!;
    const other = createId("harnessInstance");
    const both = {
      environments: snapshot.environments.map((item) =>
        item.id === environment.id
          ? {
              ...item,
              harnessCatalogs: [...item.harnessCatalogs, { ...catalog, harnessInstanceId: other }],
            }
          : item,
      ),
      harnesses: [...snapshot.harnesses, { ...harness, id: other }],
    };
    f.publish(both);
    await f.controller.start();
    expect(f.controller.getSnapshot().phase).toBe("listening");

    // Chat moving to the other account changes this device's pick, and nothing about the call.
    f.publish({
      environments: both.environments
        .filter(({ id }) => id === environment.id)
        .map((item) => ({ ...item, harnessCatalogs: [...item.harnessCatalogs].reverse() })),
      harnesses: both.harnesses,
      homeThreadId: null,
    });
    expect(voiceAccount(f.host.getSnapshot())?.harnessInstanceId).toBe(other);
    expect(f.controller.getSnapshot().phase).toBe("listening");

    f.publish({
      environments: both.environments.map((item) => ({
        ...item,
        harnessCatalogs: item.harnessCatalogs.filter(
          ({ harnessInstanceId }) => harnessInstanceId !== account.harnessInstanceId,
        ),
      })),
    });
    await vi.waitFor(() => expect(f.controller.getSnapshot().phase).toBe("idle"));
    f.dispose();
  });

  it("says the call failed when the Voice Thread can't open", async () => {
    const f = setup();
    f.publish({ voiceThreadId: null });
    Object.defineProperty(f.host, "rpc", {
      value: { "voice.open": async () => ({ ok: false }) },
    });
    await f.controller.start();
    expect(f.provider.open).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot()).toMatchObject({
      phase: "idle",
      notice: { kind: "connection-failed" },
    });
    f.dispose();
  });

  it("keeps the call's work and what needs the person on the snapshot", async () => {
    const f = setup();
    await f.controller.start();
    const { threadId } = f.call.identity;
    const task = (parentThreadId: string) => ({
      failure: null,
      lastReply: null,
      thread: { id: createId("thread"), parentThreadId },
    });
    const waiting = (id: string) => ({
      assignments: [],
      request: { id, originatingThreadId: threadId, status: "pending" },
    });
    f.publish({
      activeTasks: [task(threadId), task(createId("thread"))] as never,
      waitingRequests: [waiting("first"), waiting("second")] as never,
    });
    expect(f.controller.getSnapshot()).toMatchObject({
      tasks: 1,
      ask: { kind: "request", requestId: "first", others: 1 },
    });
    // The card the person is reading stays put when an earlier Request appears.
    f.publish({ waitingRequests: [waiting("newer"), waiting("first")] as never });
    expect(f.controller.getSnapshot().ask).toMatchObject({ requestId: "first" });
    const held = f.controller.getSnapshot();
    f.publish({ network: "online" } as never);
    expect(f.controller.getSnapshot()).toBe(held);
    f.publish({ activeTasks: [], waitingRequests: [] });
    expect(f.controller.getSnapshot()).toMatchObject({ tasks: 0, ask: null });
    f.dispose();
  });

  it("meters do not redraw snapshots and idle time resets only for the person's utterances", async () => {
    const f = setup();
    await f.controller.start();
    const snapshot = f.controller.getSnapshot();
    const changed = vi.fn();
    const levels = vi.fn();
    f.controller.subscribe(changed);
    f.controller.subscribeLevel(levels);
    f.emit({ type: "level", input: 0.4, output: 0.2 });
    expect(levels).toHaveBeenCalledWith({ input: 0.4, output: 0.2 });
    expect(f.controller.getSnapshot()).toBe(snapshot);
    expect(changed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(599_000);
    f.emit({ type: "heard", turnId: "nav", text: "go back" });
    await vi.advanceTimersByTimeAsync(599_000);
    f.emit({ type: "speaking", text: "background speech" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.controller.getSnapshot()).toMatchObject({ phase: "idle", notice: { kind: "idle" } });
    expect(f.call.close).toHaveBeenCalledTimes(1);
    expect(levels).toHaveBeenLastCalledWith({ input: 0, output: 0 });
    f.dispose();
  });

  it("stops and fences late events when the Host session changes", async () => {
    const f = setup();
    await f.controller.start();
    f.publish({ deploymentId: "another-host" });
    f.emit({ type: "heard", turnId: "late", text: "after stop" });
    expect(f.controller.getSnapshot().phase).toBe("idle");
    expect(f.signal()?.aborted).toBe(true);
    expect(f.call.close).toHaveBeenCalledTimes(1);
    f.dispose();
    expect(f.listeners.size).toBe(0);
  });

  it("cancels connecting, closes late provider calls and does not display a failure notice", async () => {
    const f = setup();
    let connected!: (call: VoiceCall) => void;
    vi.mocked(f.provider.open).mockImplementation(
      () =>
        new Promise((resolve) => {
          connected = resolve;
        }),
    );
    const starting = f.controller.start();
    await settle();
    expect(f.provider.open, "provider never started").toHaveBeenCalledTimes(1);
    await f.controller.stop();
    connected(f.call);
    await starting;
    expect(f.call.close).toHaveBeenCalledTimes(1);
    expect(f.controller.getSnapshot()).toMatchObject({ phase: "idle", notice: null });
    f.dispose();
  });

  it("shows actionable plain notices, dismisses them and maps a call ended elsewhere", async () => {
    const f = setup();
    vi.mocked(f.provider.open).mockRejectedValueOnce(new VoiceStartError("permission-denied"));
    await f.controller.start();
    expect(f.controller.getSnapshot().notice).toEqual({
      kind: "permission-denied",
      message: "Allow microphone access to talk to Opensteer.",
      action: "open-settings",
    });
    f.controller.openMicrophoneSettings();
    expect(f.media.openMicrophoneSettings).toHaveBeenCalledTimes(1);
    f.controller.dismissNotice();
    expect(f.controller.getSnapshot().notice).toBeNull();
    // A refused renewal, say or context closes the call as replaced.
    await f.controller.start();
    f.emit({ type: "closed", reason: "replaced" });
    expect(f.controller.getSnapshot()).toMatchObject({
      phase: "idle",
      notice: { kind: "ended", message: "The voice call ended." },
    });
    expect(f.controller.call()).toBeNull();
    await f.controller.start();
    f.emit({ type: "closed", reason: "connection-lost" });
    expect(f.controller.getSnapshot().notice?.message).toBe("Voice disconnected.");
    f.dispose();
  });

  it("keeps hearing visible when voice output ends during the person's utterance", async () => {
    const f = setup();
    await f.controller.start();
    f.emit({ type: "speaking", text: "Hello" });
    f.emit({ type: "hearing", text: "Go" });
    f.emit({ type: "spoke" });
    expect(f.controller.getSnapshot()).toMatchObject({ phase: "hearing", heard: "Go" });
    f.dispose();
  });
});

describe("what the person sees", () => {
  const chat = ThreadIdSchema.parse(createId("thread"));
  const tab = BrowserSurfaceIdSchema.parse("tab_reading");

  it("sends each changed view once, coalescing changes and retrying an unknown outcome", async () => {
    let view: { threadId: string | null; tabId: string | null } = { threadId: chat, tabId: null };
    const f = setup({ input: { currentView: () => view } });
    await f.controller.start();
    expect(f.call.view).toHaveBeenCalledExactlyOnceWith({ threadId: chat, tabId: null });
    await settle();
    f.controller.refreshContext();
    f.controller.refreshContext(true);
    await settle();
    expect(f.call.view, "an unchanged view was sent again").toHaveBeenCalledTimes(1);

    view = { threadId: null, tabId: tab };
    f.controller.refreshContext();
    view = { threadId: chat, tabId: tab };
    f.controller.refreshContext();
    await vi.advanceTimersByTimeAsync(250);
    expect(f.call.view).toHaveBeenCalledTimes(2);
    expect(f.call.view).toHaveBeenLastCalledWith({ threadId: chat, tabId: tab });

    // A change made while one is in flight follows it; an unknown outcome is sent again.
    let finish!: () => void;
    f.call.view.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    view = { threadId: chat, tabId: null };
    f.controller.refreshContext(true);
    view = { threadId: null, tabId: null };
    f.controller.refreshContext(true);
    expect(f.call.view).toHaveBeenCalledTimes(3);
    f.call.view.mockRejectedValueOnce(new TypeError("offline"));
    finish();
    await settle();
    expect(f.call.view).toHaveBeenCalledTimes(4);
    expect(f.call.view).toHaveBeenLastCalledWith({ threadId: null, tabId: null });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.call.view).toHaveBeenCalledTimes(5);
    expect(f.call.view).toHaveBeenLastCalledWith({ threadId: null, tabId: null });

    // A refusal already ended the call, so nothing is retried.
    view = { threadId: chat, tabId: null };
    f.call.view.mockRejectedValueOnce(new VoiceStartError("connection-failed"));
    f.controller.refreshContext(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.call.view).toHaveBeenCalledTimes(6);

    // A route parameter that is not an id names nothing, the view last accepted.
    view = { threadId: "settings", tabId: "" };
    f.controller.refreshContext(true);
    await settle();
    expect(f.call.view).toHaveBeenCalledTimes(6);
    f.dispose();
  });

  it("acknowledges a screen change only from the live call, never one it replaced", async () => {
    const f = setup();
    const shown = vi.fn();
    f.controller.subscribeShown(shown);
    await f.controller.start();
    const first = f.call.identity;
    const message = (call: typeof first) =>
      PersonShowMessageSchema.parse({
        type: "host.show",
        ...call,
        target: { threadId: chat },
      });
    f.controller.showed(message(first));
    expect(shown).toHaveBeenCalledTimes(1);
    f.controller.showed(message({ ...first, runId: createId("run") }));
    expect(shown).toHaveBeenCalledTimes(1);

    await f.controller.stop();
    f.controller.showed(message(first));
    f.call.identity = voiceIdentity(first.workspaceId);
    await f.controller.start();
    f.controller.showed(message(first));
    expect(shown, "a replaced call still changed the screen").toHaveBeenCalledTimes(1);
    f.controller.showed(message(f.call.identity));
    expect(shown).toHaveBeenCalledTimes(2);
    f.dispose();
  });
});
