import { VoiceSessionIdSchema } from "@opensteer/protocol/voice";
import { classifyClientFailure } from "../connections/operation-error.js";
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
import { routeUtterance, voiceTargets } from "./router.js";
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
  readonly onStart?: () => void | Promise<void>;
  /** Semantic provider seam, also usable by offline implementations and tests. */
  readonly createProvider?: (input: CodexVoiceProviderInput) => VoiceProvider;
}

interface VoiceSession {
  readonly id: string;
  readonly abort: AbortController;
  readonly account: VoiceAccount;
  readonly baseline: HostSnapshot;
  readonly turns: Set<string>;
  readonly pending: Map<string, { messageId: string | null; runId: string | null }>;
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
    const media = this.#input.media;
    if (!media || !baseline.voiceAvailable) return;
    const session: VoiceSession = {
      id: VoiceSessionIdSchema.parse(this.#input.createId()),
      abort: new AbortController(),
      account,
      baseline,
      turns: new Set(),
      pending: new Map(),
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
      !snapshot.voiceAvailable
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
    this.#settlePhase(session);
  }
  #settlePhase(session: VoiceSession): void {
    if (this.#session !== session || !session.call) return;
    this.#publish({
      phase: session.hearing
        ? "hearing"
        : session.speaking
          ? "speaking"
          : session.pending.size
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
        this.#publish({ heard: event.text });
        this.#settlePhase(session);
        break;
      case "heard": {
        if (session.turns.has(event.turnId)) return;
        session.turns.add(event.turnId);
        this.#touch(session);
        session.hearing = false;
        this.#publish({ heard: event.text });
        this.#settlePhase(session);
        if (!event.text.trim()) return;
        const target = routeUtterance(
          event.text,
          voiceTargets(this.#input.hostClient.getSnapshot()),
        );
        if (target) this.#input.navigate(target);
        else {
          session.pending.set(event.turnId, { messageId: null, runId: null });
          this.#settlePhase(session);
          session.sends = session.sends
            .then(() => this.#send(session, event.turnId, event.text))
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
  async #send(session: VoiceSession, turnId: string, text: string): Promise<void> {
    if (this.#session !== session) return;
    const host = this.#input.hostClient;
    const snapshot = host.getSnapshot();
    let threadId = snapshot.homeThreadId;
    if (!threadId) {
      const placement = threadPlacementOptions(snapshot.environments, snapshot.harnesses).find(
        (option) =>
          option.environmentId === session.account.environmentId &&
          option.harnessInstanceId === session.account.harnessInstanceId,
      );
      const workspaceId = snapshot.homeWorkspaceId;
      if (!workspaceId || !placement) throw new Error("Chat is unavailable.");
      const home = await this.#attempt(session, () =>
        host.createHome({
          ...session.account,
          workspaceId,
          accessMode: snapshot.executionPreferences.accessMode,
          modelSelection: placement.modelSelection,
          idempotencyKey: `voice:${session.id}:home`,
        }),
      );
      threadId = home.id;
    }
    if (this.#session !== session) return;
    const command: PendingSendCommand = {
      type: "thread.sendMessage",
      threadId,
      delivery: "queue",
      content: [{ type: "text", text }],
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
  async #attempt<T>(session: VoiceSession, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (this.#session !== session || classifyClientFailure(error).classification !== "transient")
        throw error;
      // An unknown transport outcome repeats the exact command and key once.
      return action();
    }
  }
  #end(session: VoiceSession, kind?: VoiceNoticeKind): Promise<void> {
    if (this.#session !== session) return Promise.resolve();
    this.#session = null;
    session.abort.abort();
    session.speaker?.dispose();
    this.#timers.clear(session.idleTimer);
    this.#input.media?.keepAwake?.(false);
    this.#publish({ phase: "idle", since: null, muted: false, notice: kind ? notice(kind) : null });
    for (const listener of this.#levels) listener({ input: 0, output: 0 });
    return session.call?.close().catch(() => {}) ?? Promise.resolve();
  }
}
