import {
  BrowserSessionIdSchema,
  BrowserSurfaceIdSchema,
  type PlaceContentPart,
} from "@opensteer/core";
import type { VoiceToolCall } from "@opensteer/protocol/voice";
import { EnvironmentIdSchema, HarnessInstanceIdSchema } from "@opensteer/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserPagePart } from "../host/pending-send.js";
import { threadPlacementOptions } from "../host/thread-placement.js";
import type { RunEntry } from "../host/client.js";
import { VoiceStartError, type VoiceCall, type VoiceSnapshot as Snapshot } from "./contract.js";
import { VoiceController, voiceAccount, type VoiceControllerInput } from "./controller.js";
import {
  settle,
  semanticVoice,
  voiceHost,
  voiceReply,
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
  const navigate = vi.fn();
  const onStart = vi.fn();
  const controller = new VoiceController({
    hostClient: f.host,
    media: voice.media,
    createProvider: () => voice.provider,
    createId: () => voiceTestId,
    navigate,
    onStart,
    ...options.input,
  });
  return {
    ...f,
    ...voice,
    controller,
    navigate,
    onStart,
    dispose: () => {
      controller.dispose();
      f.host.dispose();
    },
  };
}

describe("VoiceController", () => {
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
    const withoutHome = { ...snapshot, homeThreadId: null };
    expect(voiceAccount(withoutHome)).not.toBeNull();
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

  it("runs the phase machine from recognition through Chat dispatch and durable speech", async () => {
    const f = setup();
    const history: Snapshot["phase"][] = [];
    f.controller.subscribe(() => history.push(f.controller.getSnapshot().phase));
    await f.controller.start();
    expect(f.onStart).toHaveBeenCalledTimes(1);
    expect(f.controller.getSnapshot()).toMatchObject({ phase: "listening", since: voiceTestNow });
    expect(f.media.keepAwake).toHaveBeenCalledWith(true);
    const id = f.host.getSnapshot().homeThreadId!;
    const dispatch = vi.spyOn(f.host, "dispatch");
    f.emit({ type: "hearing", text: "Help" });
    expect(f.controller.getSnapshot()).toMatchObject({ phase: "hearing", heard: "Help" });
    f.emit({ type: "heard", turnId: "one", text: "  Help me plan.  " });
    expect(f.controller.getSnapshot().phase).toBe("thinking");
    await settle();
    expect(dispatch, "voice utterance never reached Chat").toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({
      type: "thread.sendMessage",
      threadId: id,
      delivery: "queue",
      content: [{ type: "text", text: "  Help me plan.  " }],
      idempotencyKey: `voice:${voiceTestId}:one`,
    });
    await settle();
    expect(dispatch.mock.settledResults[0]?.type, "Chat send never settled").toBe("fulfilled");
    const receipt = await dispatch.mock.results[0]!.value;
    expect(receipt.type).toBe("thread.sendMessage");
    if (receipt.type !== "thread.sendMessage") throw new Error("Wrong send receipt");
    f.publish({
      transcripts: {
        [id]: [
          {
            ...voiceReply("answer", "# A **plan**"),
            runId: receipt.run?.id ?? receipt.input.runId,
          },
        ],
      },
    });
    expect(f.call.say).toHaveBeenCalledExactlyOnceWith("A plan");
    f.emit({ type: "speaking", text: "A plan" });
    expect(f.controller.getSnapshot()).toMatchObject({ phase: "speaking", spoken: "A plan" });
    f.emit({ type: "spoke" });
    expect(f.controller.getSnapshot().phase).toBe("listening");
    expect(history).toContain("connecting");
    f.controller.setMuted(true);
    expect(f.call.setMuted).toHaveBeenLastCalledWith(true);
    await f.controller.stop();
    expect(f.controller.getSnapshot()).toMatchObject({ phase: "idle", since: null, muted: false });
    expect(f.call.close).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.media.keepAwake).toHaveBeenLastCalledWith(false);
    f.dispose();
  });

  it("repeats unknown send outcomes with the exact same key and dedupes heard turns", async () => {
    const f = setup();
    const realDispatch = f.host.dispatch.bind(f.host);
    let first = true;
    const dispatch = vi.spyOn(f.host, "dispatch").mockImplementation(async (command) => {
      const receipt = await realDispatch(command);
      if (first) {
        first = false;
        throw new TypeError("lost response");
      }
      return receipt;
    });
    await f.controller.start();
    f.emit({ type: "heard", turnId: "one", text: "open a PR" });
    f.emit({ type: "heard", turnId: "one", text: "open a PR" });
    await settle();
    expect(dispatch, "unknown send was not retried").toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0]).toEqual(dispatch.mock.calls[1]);
    const result = await dispatch.mock.results[1]!.value;
    expect(result.type === "thread.sendMessage" && result.wasDuplicate).toBe(true);
    f.dispose();
  });

  it("forwards navigation words verbatim and creates Chat through the legacy send path", async () => {
    const f = setup({ home: "absent" });
    const snapshot = f.host.getSnapshot();
    const account = voiceAccount(snapshot)!;
    f.publish({
      harnesses: snapshot.harnesses.filter((h) => h.id === account.harnessInstanceId),
      executionPreferences: { ...snapshot.executionPreferences, history: [] },
    });
    const createHome = vi.spyOn(f.host, "createHome");
    const dispatch = vi.spyOn(f.host, "dispatch");
    await f.controller.start();
    f.emit({ type: "heard", turnId: "nav", text: "show me chat" });
    expect(f.navigate).not.toHaveBeenCalled();
    await settle();
    expect(createHome, "first utterance never created Chat").toHaveBeenCalledTimes(1);
    expect(createHome).toHaveBeenCalledWith(
      expect.objectContaining({
        ...voiceAccount(f.host.getSnapshot()),
        workspaceId: f.host.getSnapshot().homeWorkspaceId,
        idempotencyKey: `voice:${voiceTestId}:home`,
      }),
    );
    await settle();
    expect(
      dispatch.mock.calls.filter(([command]) => command.type === "thread.sendMessage"),
      "first utterance was not sent to the created Chat",
    ).toHaveLength(1);
    const home = await createHome.mock.results[0]!.value;
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: home.id,
        content: [{ type: "text", text: "show me chat" }],
      }),
    );
    f.dispose();
  });

  it("uses the remembered AI independently of the voice account", async () => {
    const f = setup({ home: "absent" });
    const snapshot = f.host.getSnapshot();
    const placement = threadPlacementOptions(snapshot.environments, snapshot.harnesses).find(
      (p) => p.available && p.harnessInstanceId !== voiceAccount(snapshot)!.harnessInstanceId,
    )!;
    expect(placement).toBeDefined();
    f.publish({
      executionPreferences: {
        ...snapshot.executionPreferences,
        accessMode: "approval-required",
        history: [
          {
            environmentId: EnvironmentIdSchema.parse(placement.environmentId),
            harnessInstanceId: HarnessInstanceIdSchema.parse(placement.harnessInstanceId),
            modelSelection: placement.modelSelection,
          },
        ],
      },
    });
    const createHome = vi
      .spyOn(f.host, "createHome")
      .mockRejectedValue(new Error("stop before send"));
    await f.controller.start();
    f.emit({ type: "heard", turnId: "ask", text: "Help me" });
    await settle();
    expect(createHome).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: placement.environmentId,
        harnessInstanceId: placement.harnessInstanceId,
        modelSelection: placement.modelSelection,
        accessMode: "approval-required",
      }),
    );
    f.dispose();
  });

  it.each([false, true])(
    "refuses before opening a call when Chat needs an AI (stale=%s)",
    async (stale) => {
      const f = setup({ home: "absent" });
      const snapshot = f.host.getSnapshot();
      f.publish({
        executionPreferences: {
          ...snapshot.executionPreferences,
          history: stale
            ? [
                {
                  environmentId: EnvironmentIdSchema.parse(
                    "env_12345678-1234-4123-8123-123456789abc",
                  ),
                  harnessInstanceId: HarnessInstanceIdSchema.parse(
                    "hin_12345678-1234-4123-8123-123456789abc",
                  ),
                  modelSelection: threadPlacementOptions(
                    snapshot.environments,
                    snapshot.harnesses,
                  )[0]!.modelSelection,
                },
              ]
            : [],
        },
      });
      const createHome = vi.spyOn(f.host, "createHome");
      await f.controller.start();
      expect(f.controller.getSnapshot().notice).toEqual({
        kind: "choose-ai",
        message: "Choose an AI for Chat, then talk to Opensteer.",
        action: null,
      });
      expect(f.provider.open).not.toHaveBeenCalled();
      expect(createHome).not.toHaveBeenCalled();
      f.dispose();
    },
  );

  it("rechecks the AI choice before creating Chat during a call", async () => {
    const f = setup({ home: "absent" });
    const snapshot = f.host.getSnapshot();
    const account = voiceAccount(snapshot)!;
    f.publish({
      harnesses: snapshot.harnesses.filter((h) => h.id === account.harnessInstanceId),
      executionPreferences: { ...snapshot.executionPreferences, history: [] },
    });
    await f.controller.start();
    expect(f.provider.open).toHaveBeenCalledTimes(1);
    f.publish({ harnesses: snapshot.harnesses });
    const createHome = vi.spyOn(f.host, "createHome");
    f.emit({ type: "heard", turnId: "ask", text: "Help me" });
    await settle();
    expect(f.controller.getSnapshot().notice?.kind).toBe("choose-ai");
    expect(createHome).not.toHaveBeenCalled();
    expect(f.call.close).toHaveBeenCalledTimes(1);
    f.dispose();
  });

  it.each(["ready", "reject", "timeout"])(
    "sends text with best-effort places (%s)",
    async (mode) => {
      const page = browserPagePart({
        auto: true,
        sessionId: "bsn_12345678-1234-4123-8123-123456789abc",
        tabId: "tab:test",
        title: "Page",
        url: "https://example.com",
      });
      const places = vi.fn(() =>
        mode === "ready"
          ? Promise.resolve([page])
          : mode === "reject"
            ? Promise.reject(new Error("unavailable"))
            : new Promise<readonly (typeof page)[]>(() => {}),
      );
      const f = setup({ input: { places } });
      const dispatch = vi.spyOn(f.host, "dispatch");
      await f.controller.start();
      f.emit({ type: "heard", turnId: "ask", text: "Explain this" });
      await vi.advanceTimersByTimeAsync(0);
      expect(places).toHaveBeenCalledTimes(1);
      if (mode === "timeout") expect(dispatch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(mode === "timeout" ? 1500 : 0);
      await settle();
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          content: [{ type: "text", text: "Explain this" }, ...(mode === "ready" ? [page] : [])],
        }),
      );
      f.dispose();
    },
  );

  it("returns to listening when Chat's Run ends without a spoken reply", async () => {
    const f = setup();
    const dispatch = vi.spyOn(f.host, "dispatch");
    await f.controller.start();
    f.emit({ type: "heard", turnId: "one", text: "Help" });
    await settle();
    expect(dispatch.mock.settledResults[0]?.type, "Chat send never settled").toBe("fulfilled");
    const receipt = await dispatch.mock.results[0]!.value;
    if (receipt.type !== "thread.sendMessage") throw new Error("Wrong send receipt");
    const run: RunEntry = {
      kind: "run",
      id: "run-row",
      runId: receipt.run?.id ?? receipt.input.runId,
      createdAt: new Date(voiceTestNow + 1).toISOString(),
      error: null,
      replyMessageId: null,
      status: "failed",
    };
    f.publish({ transcripts: { [f.host.getSnapshot().homeThreadId!]: [run] } });
    expect(f.controller.getSnapshot().phase).toBe("listening");
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
    f.emit({ type: "heard", turnId: "late", text: "send after stop" });
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

  it("shows actionable plain notices, dismisses them and maps replacement separately", async () => {
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
    await f.controller.start();
    f.emit({ type: "closed", reason: "replaced" });
    expect(f.controller.getSnapshot().notice?.message).toBe("Voice moved to another device.");
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
    f.emit({ type: "heard", text: "go back", turnId: "nav" });
    expect(f.controller.getSnapshot().phase).toBe("thinking");
    f.dispose();
  });

  it("releases the speaking phase when the bounded speech fallback fires", async () => {
    const f = setup();
    await f.controller.start();
    const id = f.host.getSnapshot().homeThreadId!;
    f.publish({ transcripts: { [id]: [voiceReply("answer", "Hi")] } });
    f.emit({ type: "speaking", text: "Hi" });
    await vi.advanceTimersByTimeAsync(15_000 + 2 * 80);
    expect(f.controller.getSnapshot().phase).toBe("listening");
    f.dispose();
  });
});

function agentSetup(input?: Partial<VoiceControllerInput>) {
  const f = setup({ input: input ?? {} });
  Object.assign(f.call, { agent: true });
  const queue: VoiceToolCall[] = [];
  let deliver: ((value: { ok: true; data: { call: VoiceToolCall | null } }) => void) | undefined;
  const next = vi.fn<(typeof f.host.rpc)["voice.next"]>(async () => {
    const call = queue.shift();
    if (call) return { ok: true, data: { call } };
    return new Promise((resolve) => {
      deliver = resolve;
    });
  });
  const answer = vi
    .fn<(typeof f.host.rpc)["voice.answer"]>()
    .mockResolvedValue({ ok: true, data: {} });
  const context = vi
    .fn<(typeof f.host.rpc)["voice.context"]>()
    .mockResolvedValue({ ok: true, data: {} });
  Object.assign(f.host.rpc, {
    "voice.next": next,
    "voice.answer": answer,
    "voice.context": context,
  });
  const dispatch = vi.spyOn(f.host, "dispatch");
  return {
    ...f,
    next,
    answer,
    context,
    dispatch,
    tool(call: VoiceToolCall) {
      if (deliver) {
        const resolve = deliver;
        deliver = undefined;
        resolve({ ok: true, data: { call } });
      } else queue.push(call);
    },
  };
}

it("agent captions never auto-send; redelivered back executes once and unknown tools fail", async () => {
  const f = agentSetup();
  await f.controller.start();
  f.emit({ type: "heard", turnId: "one", text: "go back" });
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.controller.getSnapshot()).toMatchObject({ heard: "go back", phase: "thinking" });
  f.tool({ id: "back", tool: "show", input: { link: "opensteer://back" }, heard: ["go back"] });
  await settle();
  expect(f.answer).toHaveBeenCalledTimes(1);
  f.tool({ id: "back", tool: "show", input: { link: "opensteer://back" }, heard: ["go back"] });
  await settle();
  expect(f.answer).toHaveBeenCalledTimes(2);
  expect(f.navigate).toHaveBeenCalledExactlyOnceWith({ kind: "back" });
  f.tool({ id: "unknown", tool: "future", input: {}, heard: [] });
  await settle();
  expect(f.answer).toHaveBeenCalledTimes(3);
  expect(f.answer.mock.calls[2]![0]).toMatchObject({
    ok: false,
    text: "This device can't do that yet.",
  });
  await f.controller.stop();
  f.tool({ id: "late", tool: "show", input: { link: "opensteer://back" }, heard: [] });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.navigate).toHaveBeenCalledTimes(1);
  f.dispose();
});

it("hands off the person's words anchored on the turn that asked, keeping unsent ones", async () => {
  const f = agentSetup();
  await f.controller.start();
  for (let i = 0; i < 7; i++) f.emit({ type: "heard", turnId: String(i), text: `  Words ${i}!  ` });
  // Words 5 and 6 overtook the delayed tool call for the turn that heard Words 4.
  f.tool({
    id: "send",
    tool: "send_to_chat",
    input: { messages: 2, text: "injected agent words" },
    heard: ["Words 4."],
  });
  await settle();
  expect(f.answer).toHaveBeenCalledTimes(1);
  expect(f.dispatch).toHaveBeenCalledWith(
    expect.objectContaining({
      idempotencyKey: `voice:${voiceTestId}:send`,
      content: [{ type: "text", text: "  Words 3!  \n  Words 4!  " }],
    }),
  );
  // Chat keeps working after the agent's acknowledgement is spoken.
  f.emit({ type: "speaking", text: "Sent to Chat." });
  f.emit({ type: "spoke" });
  await vi.advanceTimersByTimeAsync(9_000);
  expect(f.controller.getSnapshot().phase).toBe("thinking");
  // Only what was sent leaves the buffer; Words 5 stays unsent.
  f.tool({ id: "again", tool: "send_to_chat", input: { messages: 1 }, heard: ["words 6"] });
  await settle();
  expect(f.answer).toHaveBeenCalledTimes(2);
  expect(f.dispatch).toHaveBeenLastCalledWith(
    expect.objectContaining({ content: [{ type: "text", text: "  Words 6!  " }] }),
  );
  f.tool({ id: "older", tool: "send_to_chat", input: { messages: 1 }, heard: ["Words 5"] });
  await settle();
  expect(f.answer).toHaveBeenCalledTimes(3);
  expect(f.dispatch).toHaveBeenLastCalledWith(
    expect.objectContaining({ content: [{ type: "text", text: "  Words 5!  " }] }),
  );
  f.dispose();
});

it("waits briefly for a hand-off's transcript and never substitutes other words", async () => {
  const f = agentSetup();
  await f.controller.start();
  f.emit({ type: "heard", turnId: "old", text: "Something earlier." });
  f.tool({ id: "early", tool: "send_to_chat", input: { messages: 1 }, heard: ["Book a flight"] });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(f.dispatch).not.toHaveBeenCalled();
  f.emit({ type: "heard", turnId: "late", text: "Book a flight." });
  await settle();
  expect(f.answer).toHaveBeenCalledTimes(1);
  expect(f.dispatch).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ content: [{ type: "text", text: "Book a flight." }] }),
  );
  f.tool({ id: "missing", tool: "send_to_chat", input: { messages: 1 }, heard: ["Never said"] });
  await vi.advanceTimersByTimeAsync(3_000);
  await settle();
  expect(f.answer).toHaveBeenCalledTimes(2);
  expect(f.answer.mock.calls[1]![0]).toMatchObject({ ok: false });
  expect(f.dispatch).toHaveBeenCalledTimes(1);
  f.dispose();
});

it("reports a hand-off whose delivery is unknown without inviting a resend", async () => {
  const f = agentSetup();
  await f.controller.start();
  f.dispatch.mockRejectedValue(new TypeError("connection lost"));
  f.emit({ type: "heard", turnId: "one", text: "Book a flight." });
  f.tool({ id: "send", tool: "send_to_chat", input: { messages: 1 }, heard: ["Book a flight."] });
  await settle();
  expect(f.answer).toHaveBeenCalledTimes(1);
  expect(f.dispatch).toHaveBeenCalledTimes(2);
  expect(new Set(f.dispatch.mock.calls.map(([command]) => command.idempotencyKey))).toEqual(
    new Set([`voice:${voiceTestId}:send`]),
  );
  expect(f.answer.mock.calls[0]![0]).toMatchObject({
    ok: false,
    text: expect.stringContaining("outcome is unknown"),
  });
  f.dispose();
});

it("deduplicates context, debounces changes, and pushes changed context on hearing", async () => {
  let title = "First";
  const f = agentSetup({ currentView: () => ({ title }) });
  await f.controller.start();
  await settle();
  expect(f.context).toHaveBeenCalledTimes(1);
  f.controller.refreshContext();
  await vi.advanceTimersByTimeAsync(250);
  expect(f.context).toHaveBeenCalledTimes(1);
  title = "Second";
  f.controller.refreshContext();
  await vi.advanceTimersByTimeAsync(249);
  expect(f.context).toHaveBeenCalledTimes(1);

  f.emit({ type: "hearing", text: "hello" });
  await vi.advanceTimersByTimeAsync(1);
  expect(f.context).toHaveBeenCalledTimes(2);
  f.dispose();
});

it("backs off transient polls, retries the same answer body, and cancels a pending backoff", async () => {
  const f = agentSetup();
  f.next.mockRejectedValueOnce(new TypeError("offline"));
  f.answer.mockRejectedValueOnce(new TypeError("lost answer"));
  await f.controller.start();
  await vi.advanceTimersByTimeAsync(249);
  expect(f.next).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.next).toHaveBeenCalledTimes(2);
  f.tool({ id: "one", tool: "show", input: { link: "opensteer://back" }, heard: [] });
  await settle();
  expect(f.answer).toHaveBeenCalledTimes(2);
  expect(f.answer.mock.calls[0]![0]).toEqual(f.answer.mock.calls[1]![0]);
  expect(f.navigate).toHaveBeenCalledTimes(1);
  f.next.mockRejectedValue(new TypeError("offline"));
  f.tool({ id: "two", tool: "future", input: {}, heard: [] });
  await settle();
  expect(f.answer).toHaveBeenCalledTimes(3);
  await f.controller.stop();
  const polls = f.next.mock.calls.length;
  await vi.advanceTimersByTimeAsync(20_000);
  expect(f.next).toHaveBeenCalledTimes(polls);
  f.dispose();
});

it("waits for negotiation before handling an utterance received while opening", async () => {
  const f = agentSetup();
  const opening = f.controller.start();
  // onStart yields before the provider opens; emit from within provider admission.
  vi.mocked(f.provider.open).mockImplementationOnce(async (input) => {
    input.onEvent({ type: "heard", turnId: "early", text: "do this" });
    return f.call;
  });
  await opening;
  expect(f.dispatch).not.toHaveBeenCalled();
  f.tool({ id: "handoff", tool: "send_to_chat", input: { messages: 1 }, heard: ["Do this."] });
  await settle();
  expect(f.answer).toHaveBeenCalledTimes(1);
  expect(f.dispatch).toHaveBeenCalledWith(
    expect.objectContaining({ content: [{ type: "text", text: "do this" }] }),
  );
  f.dispose();
});

it("hands off exactly the words that were said and the page shown while saying them", async () => {
  const page = (title: string): PlaceContentPart => ({
    type: "browser-page",
    auto: true,
    sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000001"),
    tabId: BrowserSurfaceIdSchema.parse(`tab_${title}`),
    title,
    url: `https://example.com/${title}`,
  });
  let showing = page("A");
  const f = agentSetup({ places: async () => [showing] });
  await f.controller.start();
  f.emit({ type: "heard", turnId: "ask", text: "Book a flight." });
  showing = page("B");
  f.emit({ type: "heard", turnId: "unsay", text: "Don't book a flight." });
  f.tool({ id: "send", tool: "send_to_chat", input: { messages: 1 }, heard: ["Book a flight"] });
  await settle();
  expect(f.dispatch).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ content: [{ type: "text", text: "Book a flight." }, page("A")] }),
  );
  f.dispose();
});
