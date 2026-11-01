import type { PlaceContentPart } from "@opensteer/core";
import { lastExecutionSelection } from "../host/execution-preferences.js";
import { composerExecutionSelection } from "../host/model-catalog.js";
import { VoiceSessionIdSchema, type VoiceToolCall } from "@opensteer/protocol/voice";
import { ClientOperationError, classifyClientFailure } from "../connections/operation-error.js";
import type { HostClient, HostSnapshot } from "../host/client.js";
import type { PendingSendCommand } from "../host/pending-send.js";
import { heldThread } from "../host/task-list.js";
import { threadPlacementOptions } from "../host/thread-placement.js";
import { createCodexVoiceProvider, type CodexVoiceProviderInput } from "./codex-provider.js";
import {
  VoiceStartError,
  type VoiceCall,
  type VoiceCallEvent,
  type VoiceLevels,
  type VoiceMediaPort,
  type VoiceNotice,
  type VoiceNoticeKind,
  type VoiceProvider,
  type VoiceSnapshot,
  type VoiceTarget,
} from "./contract.js";
import { VoiceContextLinks, type VoiceView } from "./context.js";
import { VoiceSpeaker } from "./speaker.js";
import { voiceTimers, type VoiceTimer, type VoiceTimers } from "./timers.js";

export interface VoiceAccount {
  readonly environmentId: string;
  readonly harnessInstanceId: string;
}

export function voiceAccount(snapshot: HostSnapshot): VoiceAccount | null {
  const eligible = snapshot.environments.flatMap((environment) =>
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
  const home = snapshot.homeThreadId ? heldThread(snapshot, snapshot.homeThreadId) : null;
  return (
    eligible.find(
      (account) =>
        account.environmentId === home?.environmentId &&
        account.harnessInstanceId === home.harnessInstanceId,
    ) ??
    eligible[0] ??
    null
  );
}

function chatSelection(snapshot: HostSnapshot) {
  const placements = threadPlacementOptions(snapshot.environments, snapshot.harnesses);
  const runnable = placements.filter((placement) => placement.available);
  return composerExecutionSelection({
    chosen: null,
    remembered: lastExecutionSelection(snapshot.executionPreferences),
    defaultPlacement: runnable.length === 1 ? runnable[0] : null,
    placements,
  });
}

const noticeCopy: Record<VoiceNoticeKind, string> = {
  "permission-denied": "Allow microphone access to talk to Opensteer.",
  "microphone-unavailable": "No microphone is available.",
  "insecure-context":
    "Voice needs a secure connection. Open Opensteer over https or on this computer.",
  "choose-ai": "Choose an AI for Chat, then talk to Opensteer.",
  "no-account": "Voice needs a ChatGPT account signed in to Codex on one of your computers.",
  "update-computer": "Update Opensteer on that computer to use voice.",
  "update-codex": "Update Codex to use voice.",
  refused: "OpenAI didn't start the call. Your ChatGPT plan may not include voice.",
  "connection-failed": "Couldn't connect the voice call. Try again.",
  ended: "Voice moved to another device.",
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

export interface VoiceControllerInput extends VoiceTimers {
  readonly hostClient: HostClient;
  readonly media: VoiceMediaPort | null;
  readonly navigate: (target: VoiceTarget) => void;
  readonly createId: () => string;
  readonly currentView?: () => VoiceView;
  readonly places?: () => Promise<readonly PlaceContentPart[]>;
  readonly onStart?: () => void | Promise<void>;
  /** Semantic provider seam, also usable by offline implementations and tests. */
  readonly createProvider?: (input: CodexVoiceProviderInput) => VoiceProvider;
}

interface VoiceSession {
  readonly id: string;
  readonly abort: AbortController;
  readonly baseline: HostSnapshot;
  readonly turns: Set<string>;
  readonly earlyUtterances: Extract<VoiceCallEvent, { type: "heard" }>[];
  readonly pending: Map<string, { messageId: string | null; runId: string | null }>;
  readonly links: VoiceContextLinks;
  readonly answers: Map<string, Promise<{ ok: boolean; text: string }>>;
  /** The person's utterances not yet handed to Chat, oldest first. */
  utterances: { turnId: string; text: string }[];
  readonly heardWaiters: Set<() => void>;
  /** Page context captured as each utterance was heard, by turn. */
  readonly pages: Map<string, Promise<readonly PlaceContentPart[]>>;
  contextDesired: string | null;
  contextTimer: VoiceTimer | null;
  contextSends: Promise<void>;
  thinkingTimer: VoiceTimer | null;
  thinking: boolean;
  toolRunning: boolean;
  hearing: boolean;
  speaking: boolean;
  call: VoiceCall | null;
  speaker: VoiceSpeaker | null;
  idleTimer: VoiceTimer | null;
  sends: Promise<void>;
}

/** One per app runtime; meters bypass the React snapshot subscription. */
export class VoiceController {
  readonly #input: VoiceControllerInput;
  readonly #timers;
  readonly #listeners = new Set<() => void>();
  readonly #levels = new Set<(level: VoiceLevels) => void>();
  readonly #unsubscribe: () => void;
  #session: VoiceSession | null = null;
  #disposed = false;
  #snapshot: VoiceSnapshot;

  constructor(input: VoiceControllerInput) {
    this.#input = input;
    this.#timers = voiceTimers(input);
    this.#snapshot = {
      available: this.#available(),
      phase: "idle",
      muted: false,
      heard: null,
      spoken: null,
      since: null,
      notice: null,
    };
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

  async start(): Promise<void> {
    if (this.#disposed || this.#session) return;
    this.dismissNotice();
    const baseline = this.#input.hostClient.getSnapshot();
    const account = voiceAccount(baseline);
    if (!account) {
      this.#publish({ notice: notice("no-account") });
      return;
    }
    if (!baseline.homeThreadId && !chatSelection(baseline)) {
      this.#publish({ notice: notice("choose-ai") });
      return;
    }
    const media = this.#input.media;
    if (!media || !baseline.voiceAvailable) return;
    const session: VoiceSession = {
      id: VoiceSessionIdSchema.parse(this.#input.createId()),
      abort: new AbortController(),
      baseline,
      turns: new Set(),
      earlyUtterances: [],
      pending: new Map(),
      links: new VoiceContextLinks(),
      answers: new Map(),
      utterances: [],
      heardWaiters: new Set(),
      pages: new Map(),
      contextDesired: null,
      contextTimer: null,
      contextSends: Promise.resolve(),
      thinkingTimer: null,
      thinking: false,
      toolRunning: false,
      hearing: false,
      speaking: false,
      call: null,
      speaker: null,
      idleTimer: null,
      sends: Promise.resolve(),
    };
    this.#session = session;
    this.#publish({ phase: "connecting", muted: false, heard: null, spoken: null, since: null });
    try {
      await this.#input.onStart?.();
      if (this.#session !== session) return;
      const provider = (this.#input.createProvider ?? createCodexVoiceProvider)({
        ...this.#input,
        ...account,
        rpc: this.#input.hostClient.rpc,
        agent: baseline.voiceAgentAvailable === true,
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
      for (const event of session.earlyUtterances.splice(0)) this.#receive(session, event);
      call.setMuted(this.#snapshot.muted);
      media.keepAwake?.(true);
      this.#publish({ since: this.#timers.now() });
      this.#settlePhase(session);
      session.speaker = new VoiceSpeaker({
        ...this.#input,
        baseline,
        say: (text) => call.say(text),
        onReplySpoken: (runId) => {
          for (const [key, pending] of session.pending)
            if (pending.runId === runId) session.pending.delete(key);
          this.#settlePhase(session);
        },
        onSettled: () => {
          session.speaking = false;
          this.#settlePhase(session);
        },
        onError: () => {
          void this.#end(session, "connection-lost");
        },
      });
      this.#touch(session);
      if (call.agent) {
        this.refreshContext(true);
        void this.#tools(session, account);
      }
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
      JSON.stringify(voiceAccount(snapshot)) !== JSON.stringify(voiceAccount(session.baseline))
    ) {
      void this.#end(session);
      return;
    }
    const entries = snapshot.transcripts[snapshot.homeThreadId ?? ""] ?? [];
    for (const [key, pending] of session.pending) {
      if (!pending.runId && pending.messageId) {
        const message = entries.find(
          (entry) => entry.id === pending.messageId && entry.kind === "message",
        );
        if (message?.kind === "message") pending.runId = message.runId;
      }
      if (
        pending.runId &&
        entries.some(
          (entry) =>
            entry.kind === "run" &&
            entry.runId === pending.runId &&
            (entry.status === "completed" ||
              entry.status === "failed" ||
              entry.status === "interrupted"),
        )
      )
        session.pending.delete(key);
    }
    this.refreshContext();
    this.#settlePhase(session);
  }
  #settlePhase(session: VoiceSession): void {
    if (this.#session !== session || !session.call) return;
    this.#publish({
      phase: session.hearing
        ? "hearing"
        : session.speaking
          ? "speaking"
          : session.pending.size || session.thinking || session.toolRunning
            ? "thinking"
            : "listening",
    });
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
        this.refreshContext(true);
        this.#publish({ heard: event.text });
        this.#settlePhase(session);
        break;
      case "heard": {
        // What the person was looking at when they spoke, not when a send runs.
        if (event.text.trim() && !session.pages.has(event.turnId)) {
          session.pages.set(event.turnId, this.#places());
          if (session.pages.size > 10) session.pages.delete(session.pages.keys().next().value!);
        }
        if (!session.call) {
          this.#publish({ heard: event.text });
          session.earlyUtterances.push(event);
          return;
        }
        if (session.turns.has(event.turnId)) return;
        session.turns.add(event.turnId);
        this.#touch(session);
        session.hearing = false;
        this.#publish({ heard: event.text });
        this.#settlePhase(session);
        if (!event.text.trim()) return;
        if (session.call?.agent) {
          session.utterances = [
            ...session.utterances,
            { turnId: event.turnId, text: event.text },
          ].slice(-10);
          for (const notify of session.heardWaiters) notify();
          session.thinking = true;
          this.#timers.clear(session.thinkingTimer);
          session.thinkingTimer = this.#timers.set(() => {
            session.thinking = false;
            this.#settlePhase(session);
          }, 8_000);
          this.#settlePhase(session);
        } else {
          session.pending.set(event.turnId, { messageId: null, runId: null });
          this.#settlePhase(session);
          session.sends = session.sends
            .then(() => this.#send(session, event.turnId, event.text, event.turnId))
            .catch(() => {
              if (this.#session !== session) return;
              session.pending.delete(event.turnId);
              this.#publish({ notice: notice("connection-failed") });
              this.#settlePhase(session);
            });
        }
        break;
      }
      case "speaking":
        if (!session.speaking) session.speaker?.speaking();
        session.thinking = false;
        this.#timers.clear(session.thinkingTimer);
        session.speaking = true;
        this.#publish({ spoken: event.text });
        this.#settlePhase(session);
        break;
      case "spoke":
        session.speaking = false;
        this.#settlePhase(session);
        session.speaker?.spoke();
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
  /** Platforms call this after their visible route changes. */
  refreshContext(immediate = false): void {
    const session = this.#session;
    if (!session?.call?.agent) return;
    // Host snapshots change many times a second while Chat streams; build at most once per window.
    if (!immediate) {
      session.contextTimer ??= this.#timers.set(() => {
        session.contextTimer = null;
        this.refreshContext(true);
      }, 250);
      return;
    }
    this.#timers.clear(session.contextTimer);
    session.contextTimer = null;
    const text = session.links.build(
      this.#input.hostClient.getSnapshot(),
      this.#input.currentView?.(),
    );
    if (text === session.contextDesired) return;
    session.contextDesired = text;
    session.contextSends = session.contextSends
      .then(async () => {
        // A newer description supersedes one still waiting to go out.
        if (this.#session !== session || session.contextDesired !== text) return;
        const account = voiceAccount(session.baseline);
        if (!account) return;
        const result = await this.#input.hostClient.rpc["voice.context"](
          { ...account, sessionId: session.id, text },
          { signal: session.abort.signal },
        );
        if (result.ok) return;
        if (result.error.reason === "voice-ended") void this.#end(session);
        else if (session.contextDesired === text) session.contextDesired = null;
      })
      .catch(() => {
        if (session.contextDesired === text) session.contextDesired = null;
      });
  }

  async #pause(session: VoiceSession, ms: number): Promise<void> {
    if (session.abort.signal.aborted) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        this.#timers.clear(timer);
        session.abort.signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = this.#timers.set(done, ms);
      session.abort.signal.addEventListener("abort", done, { once: true });
    });
  }

  async #tools(session: VoiceSession, account: VoiceAccount): Promise<void> {
    const rpc = this.#input.hostClient.rpc;
    const address = { ...account, sessionId: session.id };
    let failures = 0;
    while (this.#session === session) {
      try {
        const result = await rpc["voice.next"](address, { signal: session.abort.signal });
        if (this.#session !== session) return;
        if (!result.ok) {
          if (result.error.reason === "voice-ended") {
            void this.#end(session);
            return;
          }
          throw result.error;
        }
        failures = 0;
        const call = result.data.call;
        if (!call) {
          await this.#pause(session, 100);
          continue;
        }
        let answer = session.answers.get(call.id);
        if (!answer) {
          answer = this.#execute(session, call).catch(() => ({
            ok: false,
            text: "Couldn't do that. Try again.",
          }));
          session.answers.set(call.id, answer);
        }
        const body = { ...address, callId: call.id, ...(await answer) };
        if (this.#session !== session) return;
        await this.#attempt(session, async () => {
          const value = await rpc["voice.answer"](body, { signal: session.abort.signal });
          if (!value.ok) {
            if (value.error.reason === "voice-ended") throw value.error;
            if (value.error.retryable)
              throw new ClientOperationError("Voice answer unavailable", "transient");
            throw value.error;
          }
          return value;
        });
      } catch (error) {
        if (this.#session !== session) return;
        if (classifyClientFailure(error).reason === "voice-ended") {
          void this.#end(session);
          return;
        }
        await this.#pause(session, Math.min(4_000, 250 * 2 ** Math.min(failures++, 4)));
      }
    }
  }

  /**
   * The utterances a hand-off names: its turn's last input, located in this
   * device's own transcript, and up to `count - 1` unsent ones before it.
   * Speech and tool calls travel separately, so wait briefly for the
   * transcript; never substitute whatever was said most recently.
   */
  async #utterancesFor(
    session: VoiceSession,
    heard: readonly string[],
    count: number,
  ): Promise<VoiceSession["utterances"] | null> {
    const said = normalizedSpeech(heard.at(-1) ?? "");
    if (!said) return null;
    const find = () => {
      // Exact words only: "book a flight" must never match "don't book a flight".
      const index = session.utterances.findLastIndex(
        (item) => normalizedSpeech(item.text) === said,
      );
      return index < 0 ? null : session.utterances.slice(Math.max(0, index + 1 - count), index + 1);
    };
    const found = find();
    if (found || session.abort.signal.aborted) return found;
    await new Promise<void>((resolve) => {
      const done = () => {
        this.#timers.clear(timer);
        session.heardWaiters.delete(check);
        session.abort.signal.removeEventListener("abort", done);
        resolve();
      };
      const check = () => {
        if (find()) done();
      };
      const timer = this.#timers.set(done, 3_000);
      session.heardWaiters.add(check);
      session.abort.signal.addEventListener("abort", done, { once: true });
    });
    return this.#session === session ? find() : null;
  }

  async #execute(
    session: VoiceSession,
    call: VoiceToolCall,
  ): Promise<{ ok: boolean; text: string }> {
    if (this.#session !== session) return { ok: false, text: "The call ended." };
    session.toolRunning = true;
    this.#settlePhase(session);
    try {
      if (call.tool === "show" && typeof call.input.link === "string") {
        const resolved = session.links.resolve(
          call.input.link,
          this.#input.hostClient.getSnapshot(),
        );
        if (!resolved) return { ok: false, text: "That isn't open any more." };
        this.#input.navigate(resolved.target);
        this.refreshContext(true);
        return { ok: true, text: `Showing ${resolved.title.slice(0, 180)}.` };
      }
      if (call.tool === "send_to_chat") {
        const count = call.input.messages;
        if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 5)
          return { ok: false, text: "Choose between 1 and 5 messages." };
        const chosen = await this.#utterancesFor(session, call.heard, count);
        if (this.#session !== session) return { ok: false, text: "The call ended." };
        if (!chosen)
          return {
            ok: false,
            text: "Nothing was sent: I couldn't find those words in what the person said. Ask them to say it again.",
          };
        const text = chosen.map((item) => item.text).join("\n");
        session.pending.set(call.id, { messageId: null, runId: null });
        try {
          await this.#send(session, call.id, text, chosen.at(-1)!.turnId);
        } catch (error) {
          session.pending.delete(call.id);
          return classifyClientFailure(error).classification === "transient"
            ? {
                ok: false,
                text: "Chat may or may not have received this; the outcome is unknown. Don't send it again unless the person asks.",
              }
            : { ok: false, text: "Chat didn't accept this, so nothing was sent." };
        }
        session.utterances = session.utterances.filter((item) => !chosen.includes(item));
        return { ok: true, text: `Sent to Chat: “${text.slice(0, 3900)}”.` };
      }
      return { ok: false, text: "This device can't do that yet." };
    } finally {
      session.toolRunning = false;
      this.#settlePhase(session);
    }
  }

  async #send(
    session: VoiceSession,
    turnId: string,
    text: string,
    spokenTurnId: string,
  ): Promise<void> {
    if (this.#session !== session) return;
    const host = this.#input.hostClient;
    const snapshot = host.getSnapshot();
    let threadId = snapshot.homeThreadId;
    if (!threadId) {
      const placement = chatSelection(snapshot);
      if (!placement) {
        await this.#end(session, "choose-ai");
        return;
      }
      const workspaceId = snapshot.homeWorkspaceId;
      if (!workspaceId) throw new Error("Chat is unavailable.");
      const home = await this.#attempt(session, () =>
        host.createHome({
          environmentId: placement.environmentId,
          harnessInstanceId: placement.harnessInstanceId,
          workspaceId,
          accessMode: snapshot.executionPreferences.accessMode,
          modelSelection: placement.modelSelection,
          idempotencyKey: `voice:${session.id}:home`,
        }),
      );
      threadId = home.id;
    }
    if (this.#session !== session) return;
    const places = (await session.pages.get(spokenTurnId)) ?? [];
    if (this.#session !== session) return;
    const command: PendingSendCommand = {
      type: "thread.sendMessage",
      threadId,
      delivery: "queue",
      content: [{ type: "text", text }, ...places],
      idempotencyKey: `voice:${session.id}:${turnId}`,
    };
    const result = await this.#attempt(session, () => host.dispatch(command));
    if (this.#session !== session || result.type !== "thread.sendMessage") return;
    const pending = session.pending.get(turnId);
    if (pending) {
      pending.messageId = result.message.id;
      pending.runId = result.run?.id ?? result.input.runId;
    }
    this.#hostChanged();
  }
  async #places(): Promise<readonly PlaceContentPart[]> {
    if (!this.#input.places) return [];
    let timer: VoiceTimer | null = null;
    try {
      return await Promise.race([
        // Read the platform now: the caller is capturing what is showing this instant.
        this.#input.places(),
        new Promise<readonly PlaceContentPart[]>((resolve) => {
          timer = this.#timers.set(() => resolve([]), 1_500);
        }),
      ]);
    } catch {
      return [];
    } finally {
      this.#timers.clear(timer);
    }
  }
  async #attempt<T>(session: VoiceSession, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (this.#session !== session || classifyClientFailure(error).classification !== "transient")
        throw error;
      // An unknown transport outcome repeats the exact command and key once.
      if (this.#session !== session) throw error;
      return action();
    }
  }
  #end(session: VoiceSession, kind?: VoiceNoticeKind): Promise<void> {
    if (this.#session !== session) return Promise.resolve();
    this.#session = null;
    session.abort.abort();
    session.speaker?.dispose();
    this.#timers.clear(session.idleTimer);
    this.#timers.clear(session.contextTimer);
    this.#timers.clear(session.thinkingTimer);
    this.#input.media?.keepAwake?.(false);
    this.#publish({ phase: "idle", since: null, muted: false, notice: kind ? notice(kind) : null });
    for (const listener of this.#levels) listener({ input: 0, output: 0 });
    return session.call?.close().catch(() => {}) ?? Promise.resolve();
  }
}

function normalizedSpeech(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
