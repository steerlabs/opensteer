import type { PersonShowMessage } from "@opensteer/protocol";
import { BrowserSurfaceIdSchema, ThreadIdSchema } from "@opensteer/core";
import { VoiceSessionIdSchema, type VoiceView } from "@opensteer/protocol/voice";
import {
  callPasswordsOffer,
  toolPresentation,
  type ActivityIcon,
} from "../host/agent-activity-model.js";
import type { HostClient, HostSnapshot } from "../host/client.js";
import { requestsWaitingOn } from "../host/waiting-requests.js";
import { createCodexVoiceProvider, type CodexVoiceProviderInput } from "./codex-provider.js";
import {
  VoiceStartError,
  idleVoiceSnapshot,
  type VoiceAsk,
  type VoiceCall,
  type VoiceCallEvent,
  type VoiceCallIdentity,
  type VoiceLevels,
  type VoiceMediaPort,
  type VoiceNotice,
  type VoiceNoticeKind,
  type VoiceProvider,
  type VoiceSnapshot,
} from "./contract.js";
import { VoiceSpeaker } from "./speaker.js";
import { voiceTimers, type VoiceTimer, type VoiceTimers } from "./timers.js";

export interface VoiceAccount {
  readonly environmentId: string;
  readonly harnessInstanceId: string;
}

function voiceAccounts(snapshot: HostSnapshot): readonly VoiceAccount[] {
  return snapshot.environments.flatMap((environment) =>
    environment.harnessCatalogs
      .filter(
        (catalog) =>
          catalog.driverKind === "codex" &&
          catalog.status === "ready" &&
          catalog.connections.some(
            (connection) =>
              connection.status === "connected" && connection.authKind === "subscription",
          ) &&
          snapshot.harnesses.some(
            (harness) =>
              harness.id === catalog.harnessInstanceId &&
              harness.environmentId === environment.id &&
              harness.driverKind === "codex" &&
              harness.enabled,
          ),
      )
      .map((catalog) => ({
        environmentId: environment.id,
        harnessInstanceId: catalog.harnessInstanceId,
      })),
  );
}

export function voiceAccount(snapshot: HostSnapshot): VoiceAccount | null {
  const eligible = voiceAccounts(snapshot);
  const selection = snapshot.threads.find((thread) => thread.id === snapshot.voiceThreadId);
  return (
    eligible.find(
      (account) =>
        account.environmentId === selection?.environmentId &&
        account.harnessInstanceId === selection.harnessInstanceId,
    ) ??
    eligible[0] ??
    null
  );
}

function holdsAccount(snapshot: HostSnapshot, account: VoiceAccount): boolean {
  return voiceAccounts(snapshot).some(
    ({ environmentId, harnessInstanceId }) =>
      environmentId === account.environmentId && harnessInstanceId === account.harnessInstanceId,
  );
}

const noticeCopy: Record<VoiceNoticeKind, string> = {
  "permission-denied": "Allow microphone access to talk to Opensteer.",
  "microphone-unavailable": "No microphone is available.",
  "insecure-context":
    "Voice needs a secure connection. Open Opensteer over https or on this computer.",
  "no-account": "Voice needs a ChatGPT account signed in to Codex on one of your computers.",
  "update-computer": "Update Opensteer on that computer to use voice.",
  "update-codex": "Update Codex to use voice.",
  refused: "OpenAI didn't start the call. Your ChatGPT plan may not include voice.",
  "connection-failed": "Couldn't connect the voice call. Try again.",
  // Another device's call, the computer losing it or the two-hour cap: the Host says only that it ended.
  ended: "The voice call ended.",
  idle: "Voice turned off after 10 minutes of quiet.",
  "connection-lost": "Voice disconnected.",
};
function notice(kind: VoiceNoticeKind): VoiceNotice {
  return {
    kind,
    message: noticeCopy[kind],
    action: kind === "permission-denied" ? "open-settings" : null,
  };
}

/** How long the orb keeps working after the person speaks, before the agent shows any step. */
const heardWorkingMs = 8_000;
/** Bridges the gap between one tool finishing and the next starting. */
const stepGapMs = 1_500;
const viewDebounceMs = 250;

export interface VoiceControllerInput extends VoiceTimers {
  readonly hostClient: HostClient;
  readonly media: VoiceMediaPort | null;
  readonly createId: () => string;
  /** The conversation and tab on screen now, from the route; read when `refreshContext` is called. */
  readonly currentView?: () => {
    readonly threadId: string | null;
    readonly tabId: string | null;
  };
  readonly authorize?: () => Promise<boolean>;
  readonly onStart?: () => void | Promise<void>;
  /** Semantic provider seam, also usable by offline implementations and tests. */
  readonly createProvider?: (input: CodexVoiceProviderInput) => VoiceProvider;
}

interface VoiceSession {
  readonly id: string;
  readonly abort: AbortController;
  readonly baseline: HostSnapshot;

  account: VoiceAccount | null;
  call: VoiceCall | null;
  speaker: VoiceSpeaker | null;
  releaseThread: (() => void) | null;
  hearing: boolean;
  speaking: boolean;
  /** The person just finished speaking and the agent has not shown a step yet. */
  heardTimer: VoiceTimer | null;
  /** The agent has a step in flight, or finished one moments ago. */
  stepping: boolean;
  stepTimer: VoiceTimer | null;
  activity: ActivityIcon | null;
  idleTimer: VoiceTimer | null;
  view: { key: string; view: VoiceView } | null;
  viewSent: string | null;
  viewSending: boolean;
  viewTimer: VoiceTimer | null;
}

/** One per app runtime; meters bypass the React snapshot subscription. */
export class VoiceController {
  readonly #input: VoiceControllerInput;
  readonly #timers;
  readonly #listeners = new Set<() => void>();
  readonly #levels = new Set<(level: VoiceLevels) => void>();
  readonly #shown = new Set<() => void>();
  readonly #unsubscribe: () => void;
  #session: VoiceSession | null = null;
  #disposed = false;
  #snapshot: VoiceSnapshot;

  constructor(input: VoiceControllerInput) {
    this.#input = input;
    this.#timers = voiceTimers(input);
    this.#snapshot = { ...idleVoiceSnapshot, available: this.#available() };
    this.#unsubscribe = input.hostClient.subscribe(() => this.#hostChanged());
  }

  getSnapshot = (): VoiceSnapshot => this.#snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  subscribeLevel = (listener: (levels: VoiceLevels) => void): (() => void) => {
    this.#levels.add(listener);
    return () => {
      this.#levels.delete(listener);
    };
  };
  /** Fires each time the call's agent changed the screen, for a moment of acknowledgement. */
  subscribeShown = (listener: () => void): (() => void) => {
    this.#shown.add(listener);
    return () => {
      this.#shown.delete(listener);
    };
  };

  /** The live call's Thread and Run, or null when none is connected. */
  call(): VoiceCallIdentity | null {
    return this.#session?.call?.identity ?? null;
  }

  /** Platforms call this after acting on a `host.show`; only the live call's own counts. */
  showed(message: PersonShowMessage): void {
    const call = this.call();
    if (!call || call.runId !== message.runId || call.threadId !== message.threadId) return;
    for (const listener of this.#shown) listener();
  }

  async start(): Promise<void> {
    if (this.#disposed || this.#session) return;
    this.dismissNotice();
    const baseline = this.#input.hostClient.getSnapshot();
    const account = voiceAccount(baseline);
    if (!account) {
      this.#publish({ notice: notice("no-account") });
      return;
    }
    const media = this.#input.media;
    if (!media || !baseline.voiceAvailable) return;
    const session: VoiceSession = {
      id: VoiceSessionIdSchema.parse(this.#input.createId()),
      abort: new AbortController(),
      baseline,
      account: null,
      call: null,
      speaker: null,
      releaseThread: null,
      hearing: false,
      speaking: false,
      heardTimer: null,
      stepping: false,
      stepTimer: null,
      activity: null,
      idleTimer: null,
      view: null,
      viewSent: null,
      viewSending: false,
      viewTimer: null,
    };
    this.#session = session;
    this.#publish({
      phase: "connecting",
      muted: false,
      heard: null,
      spoken: null,
      since: null,
      activity: null,
      tasks: 0,
      ask: null,
    });
    try {
      if (this.#input.authorize && !(await this.#input.authorize())) {
        await this.#end(session);
        return;
      }
      if (this.#session !== session) return;
      await this.#input.onStart?.();
      if (this.#session !== session) return;
      const opened = await this.#open();
      if (this.#session !== session) return;
      if (!opened) {
        await this.#end(session, "connection-failed");
        return;
      }
      session.account = opened;
      const provider = (this.#input.createProvider ?? createCodexVoiceProvider)({
        ...this.#input,
        environmentId: opened.environmentId,
        harnessInstanceId: opened.harnessInstanceId,
        rpc: this.#input.hostClient.rpc,
        media,
        createId: () => session.id,
      });
      const call = await provider.open({
        signal: session.abort.signal,
        onEvent: (event) => this.#receive(session, event),
      });
      if (this.#session !== session) {
        void call.close().catch(() => {});
        return;
      }
      session.call = call;
      call.setMuted(this.#snapshot.muted);
      media.keepAwake?.(true);

      session.releaseThread = this.#input.hostClient.observeThread(call.identity.threadId);
      session.speaker = new VoiceSpeaker({
        ...this.#input,
        baseline,
        callThreadId: call.identity.threadId,
        say: (id, text) => call.say(id, text),
        onError: () => {
          void this.#end(session, "connection-lost");
        },
      });
      this.#publish({ since: this.#timers.now() });
      this.#touch(session);
      this.#readActivity(session);
      this.#readWork(session, this.#input.hostClient.getSnapshot());
      this.#settlePhase(session);
      this.refreshContext(true);
    } catch (error) {
      if (this.#session === session)
        await this.#end(
          session,
          error instanceof VoiceStartError ? error.failure : "connection-failed",
        );
    }
  }

  stop(): Promise<void> {
    return this.#session ? this.#end(this.#session) : Promise.resolve();
  }

  /** The person's Voice Thread, created the first time anyone needs it. */
  async openThread(): Promise<string | null> {
    const known = this.#input.hostClient.getSnapshot().voiceThreadId;
    return known ?? (await this.#open())?.threadId ?? null;
  }

  /** The Host names the Thread's own account, which may not be the one this client would pick. */
  async #open() {
    const host = this.#input.hostClient;
    const snapshot = host.getSnapshot();
    const account = voiceAccount(snapshot);
    if (!account) return null;
    const result = await host.rpc["voice.open"]({
      ...account,
      accessMode: snapshot.executionPreferences.accessMode,
    });
    return result.ok ? result.data : null;
  }
  setMuted(muted: boolean): void {
    if (!this.#session) return;
    this.#session.call?.setMuted(muted);
    this.#publish({ muted });
  }
  dismissNotice(): void {
    if (this.#snapshot.notice) this.#publish({ notice: null });
  }
  openMicrophoneSettings(): void {
    this.#input.media?.openMicrophoneSettings?.();
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    void this.stop();
    this.#unsubscribe();
    this.#listeners.clear();
    this.#levels.clear();
    this.#shown.clear();
  }

  /**
   * Platforms call this after what is on screen changes. Changes within a
   * moment coalesce, and only a view that differs from the last one the call
   * accepted is sent.
   */
  refreshContext(immediate = false): void {
    const session = this.#session;
    if (!session?.call) return;
    if (!immediate) {
      session.viewTimer ??= this.#timers.set(() => {
        session.viewTimer = null;
        this.refreshContext(true);
      }, viewDebounceMs);
      return;
    }
    this.#timers.clear(session.viewTimer);
    session.viewTimer = null;
    const shown = this.#input.currentView?.();
    // Route parameters are untrusted text; one that is not an id names nothing.
    const view: VoiceView = {
      threadId: ThreadIdSchema.safeParse(shown?.threadId).data ?? null,
      tabId: BrowserSurfaceIdSchema.safeParse(shown?.tabId).data ?? null,
    };
    session.view = { key: `${view.threadId ?? ""}\n${view.tabId ?? ""}`, view };
    this.#sendView(session);
  }

  #sendView(session: VoiceSession): void {
    const call = session.call;
    const desired = session.view;
    if (!call || session.viewSending || session.viewTimer !== null) return;
    if (!desired || desired.key === session.viewSent) return;
    session.viewSending = true;
    call.view(desired.view).then(
      () => {
        session.viewSending = false;
        session.viewSent = desired.key;
        if (this.#session === session) this.#sendView(session);
      },
      (error: unknown) => {
        session.viewSending = false;
        // A refusal already ended the call; an unknown outcome is sent again shortly.
        if (this.#session !== session || error instanceof VoiceStartError) return;
        session.viewTimer = this.#timers.set(() => {
          session.viewTimer = null;
          this.#sendView(session);
        }, 2_000);
      },
    );
  }

  #available(): boolean {
    const snapshot = this.#input.hostClient.getSnapshot();
    return (
      snapshot.voiceAvailable === true &&
      this.#input.media !== null &&
      voiceAccount(snapshot) !== null
    );
  }
  #publish(patch: Partial<VoiceSnapshot>): void {
    if (
      Object.entries(patch).every(
        ([key, value]) => this.#snapshot[key as keyof VoiceSnapshot] === value,
      )
    )
      return;
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
  }
  #hostChanged(): void {
    this.#publish({ available: this.#available() });
    const session = this.#session;
    if (!session) return;
    const snapshot = this.#input.hostClient.getSnapshot();
    if (
      snapshot.deploymentId !== session.baseline.deploymentId ||
      snapshot.user?.id !== session.baseline.user?.id ||
      snapshot.session !== "authenticated" ||
      !snapshot.voiceAvailable ||
      (session.account !== null && !holdsAccount(snapshot, session.account))
    ) {
      void this.#end(session);
      return;
    }
    this.#readActivity(session);
    this.#readWork(session, snapshot);
  }

  /** What rides on the call bar: the work under way, and what it needs from the person. */
  #readWork(session: VoiceSession, snapshot: HostSnapshot): void {
    const threadId = session.call?.identity.threadId;
    if (!threadId) return;
    const tasks = snapshot.activeTasks.filter(
      ({ thread }) => thread.parentThreadId === threadId,
    ).length;
    const ask = this.#ask(snapshot, threadId);
    const held = this.#snapshot.ask;
    // The Host changes many times a second; only a different ask redraws the bar.
    this.#publish({ tasks, ask: JSON.stringify(ask) === JSON.stringify(held) ? held : ask });
  }

  #ask(snapshot: HostSnapshot, threadId: string): VoiceAsk | null {
    const waiting = requestsWaitingOn(snapshot.waitingRequests, threadId);
    const first = waiting[0];
    if (first) {
      const held = this.#snapshot.ask;
      // The person is answering the one on screen: another arriving doesn't replace it.
      const shown =
        held?.kind === "request" && waiting.some(({ request }) => request.id === held.requestId)
          ? held.requestId
          : first.request.id;
      return { kind: "request", requestId: shown, others: waiting.length - 1 };
    }
    const offer = callPasswordsOffer(snapshot.transcripts[threadId] ?? []);
    return offer ? { kind: "passwords", offer } : null;
  }

  /**
   * Reads the agent's live step from its Thread: the running tool's
   * glyph, held across the short gaps between steps so the orb does not
   * flicker. Scans from the newest entry, so a long call stays cheap.
   */
  #readActivity(session: VoiceSession): void {
    const identity = session.call?.identity;
    if (!identity) return;
    const entries = this.#input.hostClient.getSnapshot().transcripts[identity.threadId] ?? [];
    let running: ActivityIcon | null = null;
    let busy = false;
    for (let index = entries.length - 1; index >= Math.max(0, entries.length - 24); index -= 1) {
      const entry = entries[index]!;
      if (!("runId" in entry) || entry.runId !== identity.runId) continue;
      if (entry.kind === "tool" && entry.state === "running") {
        running = toolPresentation(entry).icon;
        busy = true;
        break;
      }
      if (
        (entry.kind === "reasoning" && entry.state === "streaming") ||
        (entry.kind === "message" && entry.messageKind === "assistant" && entry.streaming === true)
      )
        busy = true;
    }
    if (busy) {
      this.#timers.clear(session.stepTimer);
      session.stepTimer = null;
      session.stepping = true;
      this.#timers.clear(session.heardTimer);
      session.heardTimer = null;
      if (running) session.activity = running;
    } else if (session.stepping && session.stepTimer === null) {
      session.stepTimer = this.#timers.set(() => {
        session.stepTimer = null;
        session.stepping = false;
        session.activity = null;
        this.#settlePhase(session);
      }, stepGapMs);
    }
    this.#settlePhase(session);
  }

  #settlePhase(session: VoiceSession): void {
    if (this.#session !== session || !session.call) return;
    const phase = session.hearing
      ? "hearing"
      : session.speaking
        ? "speaking"
        : session.stepping || session.heardTimer !== null
          ? "thinking"
          : "listening";
    this.#publish({ phase, activity: phase === "thinking" ? session.activity : null });
  }

  #touch(session: VoiceSession): void {
    this.#timers.clear(session.idleTimer);
    session.idleTimer = this.#timers.set(() => {
      void this.#end(session, "idle");
    }, 600_000);
  }
  #receive(session: VoiceSession, event: VoiceCallEvent): void {
    if (this.#session !== session) return;
    switch (event.type) {
      case "level":
        for (const listener of this.#levels) listener({ input: event.input, output: event.output });
        break;
      case "hearing":
        this.#touch(session);
        session.hearing = true;
        this.#publish({ heard: event.text });
        this.#settlePhase(session);
        break;
      case "heard":
        this.#touch(session);
        session.hearing = false;
        this.#publish({ heard: event.text });
        if (event.text.trim() && !session.stepping) {
          this.#timers.clear(session.heardTimer);
          session.heardTimer = this.#timers.set(() => {
            session.heardTimer = null;
            this.#settlePhase(session);
          }, heardWorkingMs);
        }
        this.#settlePhase(session);
        break;
      case "speaking":
        this.#timers.clear(session.heardTimer);
        session.heardTimer = null;
        session.speaking = true;
        this.#publish({ spoken: event.text });
        this.#settlePhase(session);
        break;
      case "spoke":
        session.speaking = false;
        this.#settlePhase(session);
        break;
      case "closed":
        void this.#end(
          session,
          event.reason === "stopped"
            ? undefined
            : event.reason === "replaced"
              ? "ended"
              : "connection-lost",
        );
        break;
    }
  }

  #end(session: VoiceSession, kind?: VoiceNoticeKind): Promise<void> {
    if (this.#session !== session) return Promise.resolve();
    this.#session = null;
    session.abort.abort();
    session.speaker?.dispose();
    session.releaseThread?.();
    for (const timer of [
      session.idleTimer,
      session.viewTimer,
      session.heardTimer,
      session.stepTimer,
    ])
      this.#timers.clear(timer);
    this.#input.media?.keepAwake?.(false);
    this.#publish({
      phase: "idle",
      since: null,
      muted: false,
      activity: null,
      tasks: 0,
      ask: null,
      notice: kind ? notice(kind) : null,
    });
    for (const listener of this.#levels) listener({ input: 0, output: 0 });
    return session.call?.close().catch(() => {}) ?? Promise.resolve();
  }
}
