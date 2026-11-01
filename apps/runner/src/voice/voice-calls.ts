import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { OpensteerError, type UserId, type HarnessInstanceId } from "@opensteer/core";
import {
  VoiceRefusalReasonSchema,
  voiceLeaseMs,
  voiceMaxCallMs,
  type VoiceToolCall,
  type RunnerVoiceCommand,
  type RunnerVoiceResult,
} from "@opensteer/protocol";

export interface RunnerVoiceCall {
  readonly answer: string;
  readonly closed: Promise<void>;
  next?(signal: AbortSignal): Promise<VoiceToolCall | null>;
  answerCall?(callId: string, ok: boolean, text: string): Promise<void>;
  context?(text: string): Promise<void>;
  say(text: string): Promise<void>;
  stop(): Promise<void>;
}
interface Entry {
  readonly agent: boolean;
  readonly ownerUserId: UserId;
  readonly harnessInstanceId: HarnessInstanceId;
  readonly abort: AbortController;
  readonly startedAt: number;
  leaseExpiresAt: number;
  readonly starting: Promise<RunnerVoiceCall>;
  call?: RunnerVoiceCall;
  timer?: ReturnType<typeof setTimeout>;
}
const ended = () =>
  new OpensteerError({
    code: "conflict",
    reason: "voice-ended",
    message: "This voice call has ended.",
  });

/** One owner per call and one call per person, independent of Host reconnects. */
export class VoiceCalls {
  readonly #entries = new Map<string, Entry>();
  readonly #ended = new Set<string>();
  readonly #stopping = new Set<Promise<void>>();
  readonly #ready: Promise<void>;
  #closed = false;
  readonly directory: string;
  readonly open: (input: {
    harnessInstanceId: HarnessInstanceId;
    agent: boolean;
    offer: string;
    signal: AbortSignal;
    directory: string;
  }) => Promise<RunnerVoiceCall>;
  constructor(
    directory: string,
    open: (input: {
      harnessInstanceId: HarnessInstanceId;
      agent: boolean;
      offer: string;
      signal: AbortSignal;
      directory: string;
    }) => Promise<RunnerVoiceCall>,
  ) {
    this.directory = directory;
    this.open = open;
    this.#ready = this.#sweep();
    void this.#ready.catch(() => undefined);
  }
  async #sweep(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.directory, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.name.startsWith("call-"))
        .map((entry) => rm(join(this.directory, entry.name), { recursive: true, force: true })),
    );
  }
  async handle(userId: UserId, command: RunnerVoiceCommand): Promise<RunnerVoiceResult> {
    try {
      if (command.action === "start")
        return {
          ok: true,
          answer: (await this.#start(userId, command)).answer,
          ...(command.agent ? { agent: true } : {}),
        };
      const entry = this.#entries.get(command.sessionId);
      if (
        entry &&
        (entry.ownerUserId !== userId || entry.harnessInstanceId !== command.harnessInstanceId)
      )
        throw ended();
      if (command.action === "stop") {
        if (entry) await this.#end(command.sessionId, entry);
        else this.#rememberEnded(command.sessionId);
        return { ok: true };
      }
      if (this.#closed || !entry || !entry.call) throw ended();
      if (Date.now() >= entry.leaseExpiresAt) {
        await this.#end(command.sessionId, entry);
        throw ended();
      }
      if (command.action === "renew") this.#lease(command.sessionId, entry);
      else if (command.action === "say") await entry.call.say(command.text);
      else {
        if (!entry.agent) throw ended();
        if (command.action === "next") {
          if (!entry.call.next) throw ended();
          return { ok: true, call: await entry.call.next(entry.abort.signal) };
        }
        if (command.action === "answer") {
          if (!entry.call.answerCall) throw ended();
          await entry.call.answerCall(command.callId, command.ok, command.text);
        } else {
          if (!entry.call.context) throw ended();
          await entry.call.context(command.text);
        }
      }
      return { ok: true };
    } catch (error) {
      const parsed = VoiceRefusalReasonSchema.safeParse(
        error instanceof OpensteerError ? error.reason : undefined,
      );
      const reason = parsed.success ? parsed.data : "voice-refused";
      return {
        ok: false,
        reason,
        message:
          reason === "voice-ended"
            ? "This voice call has ended."
            : reason === "voice-account-unavailable"
              ? "A signed-in Codex account is required for voice."
              : reason === "voice-engine-unsupported"
                ? "Update Codex on this computer to use voice."
                : "Codex could not open or continue this voice call.",
      };
    }
  }
  #start(
    userId: UserId,
    command: Extract<RunnerVoiceCommand, { action: "start" }>,
  ): Promise<RunnerVoiceCall> {
    if (this.#closed || this.#ended.has(command.sessionId)) return Promise.reject(ended());
    const existing = this.#entries.get(command.sessionId);
    if (existing && Date.now() >= existing.leaseExpiresAt) {
      void this.#end(command.sessionId, existing).catch(() => undefined);
      return Promise.reject(ended());
    }
    if (existing)
      return existing.ownerUserId === userId &&
        existing.harnessInstanceId === command.harnessInstanceId &&
        existing.agent === (command.agent === true)
        ? existing.starting
        : Promise.reject(ended());
    const previous = [...this.#entries]
      .filter(([, entry]) => entry.ownerUserId === userId)
      .map(([id, entry]) => this.#end(id, entry));
    const abort = new AbortController();
    const entry: Entry = {
      agent: command.agent === true,
      ownerUserId: userId,
      harnessInstanceId: command.harnessInstanceId,
      abort,
      startedAt: Date.now(),
      leaseExpiresAt: 0,
      starting: Promise.resolve().then(async () => {
        try {
          await this.#ready;
          await Promise.all(previous);
          abort.signal.throwIfAborted();
          const call = await this.open({
            harnessInstanceId: command.harnessInstanceId,
            agent: command.agent === true,
            offer: command.offer,
            signal: abort.signal,
            directory: this.directory,
          });
          if (
            this.#entries.get(command.sessionId) !== entry ||
            Date.now() >= entry.leaseExpiresAt
          ) {
            await call.stop();
            throw ended();
          }
          entry.call = call;
          void call.closed.then(() => this.#end(command.sessionId, entry)).catch(() => undefined);
          return call;
        } catch (error) {
          if (this.#entries.get(command.sessionId) === entry) {
            this.#entries.delete(command.sessionId);
            if (entry.timer) clearTimeout(entry.timer);
            this.#rememberEnded(command.sessionId);
          }
          throw error;
        }
      }),
    };
    this.#entries.set(command.sessionId, entry);
    this.#lease(command.sessionId, entry);
    return entry.starting;
  }
  #lease(id: string, entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.leaseExpiresAt = Math.min(Date.now() + voiceLeaseMs, entry.startedAt + voiceMaxCallMs);
    entry.timer = setTimeout(
      () => {
        void this.#end(id, entry).catch(() => undefined);
      },
      Math.max(0, entry.leaseExpiresAt - Date.now()),
    );
    entry.timer.unref?.();
  }
  #rememberEnded(id: string): void {
    this.#ended.add(id);
    if (this.#ended.size > 1_000) {
      const oldest = this.#ended.values().next().value;
      if (oldest) this.#ended.delete(oldest);
    }
  }
  #end(id: string, entry: Entry): Promise<void> {
    if (this.#entries.get(id) !== entry) return Promise.resolve();
    this.#entries.delete(id);
    this.#rememberEnded(id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.abort.abort(ended());
    const stopping = entry.starting.then(
      (call) => call.stop(),
      () => undefined,
    );
    this.#stopping.add(stopping);
    void stopping.finally(() => this.#stopping.delete(stopping)).catch(() => undefined);
    return stopping;
  }
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#entries].map(([id, entry]) => this.#end(id, entry)));
    await Promise.all(this.#stopping);
    await this.#ready.catch(() => undefined);
  }
}
