import {
  DictationAvailabilitySchema,
  DictationEventSchema,
  DictationSessionIdSchema,
  type DictationAvailability,
  type DictationEndReason,
  type DictationError,
  type DictationPort,
} from "@opensteer/protocol/dictation";
import { dictationNoticeMessage, type DictationNoticeKind } from "./presentation.js";
import { insertDictationText, joinDictationText, type DictationSelection } from "./text.js";

export type DictationPhase = "idle" | "downloading" | "starting" | "listening" | "finishing";
export interface DictationNotice {
  owner: string;
  kind: DictationNoticeKind;
  message: string;
  action: "open-settings" | null;
}
export interface DictationSnapshot {
  availability: DictationAvailability | null;
  phase: DictationPhase;
  owner: string | null;
  /**
   * The active session's language, captured when it started, so a refresh
   * that lands mid-session cannot relabel what is already being dictated.
   */
  language: string | null;
  /** Apply this selection only when preview.text changes; selection moves are not edits. */
  preview: { text: string; selection: DictationSelection } | null;
  progress: number | null;
  /**
   * When the person pressed to dictate. The recording bar counts from here
   * and shows at once, before native capture reports that it is listening.
   */
  startedAt: number | null;
  listeningSince: number | null;
  notice: DictationNotice | null;
}

/** What one composer renders: its own session, or why its microphone is unusable. */
export interface DictationView {
  /** Show the microphone at all. */
  visible: boolean;
  /** Another composer owns the session or download, so this microphone is disabled. */
  blocked: boolean;
  /** This composer's phase; `idle` while another composer owns the session. */
  phase: DictationPhase;
  /** For labels: the active session's language, else the available one. */
  languageName: string | null;
  preview: DictationSnapshot["preview"];
  progress: number | null;
  startedAt: number | null;
  listeningSince: number | null;
  notice: DictationNotice | null;
}

export function dictationView(snapshot: DictationSnapshot, owner: string): DictationView {
  const mine = snapshot.owner === owner;
  const availability = snapshot.availability;
  return {
    visible: availability?.available === true,
    blocked: snapshot.owner !== null && !mine,
    phase: mine ? snapshot.phase : "idle",
    languageName:
      (mine ? snapshot.language : null) ??
      (availability?.available === true ? availability.languageName : null),
    preview: mine ? snapshot.preview : null,
    progress: mine ? snapshot.progress : null,
    startedAt: mine ? snapshot.startedAt : null,
    listeningSince: mine ? snapshot.listeningSince : null,
    notice: snapshot.notice?.owner === owner ? snapshot.notice : null,
  };
}
export interface DictationTarget {
  /** Include deployment, user, thread and instance when composers coexist. */
  owner: string;
  /** Read the latest draft, not the rendered preview or a captured React closure. */
  read(): { text: string; selection: DictationSelection };
  commit(text: string, selection: DictationSelection): void;
}
export type DictationFinish =
  | { kind: "idle" }
  | { kind: "empty" }
  | { kind: "failed" }
  | { kind: "aborted" }
  | { kind: "committed"; text: string };

// Browsers and React Native return numeric handles; Node returns an object.
type Timer = ReturnType<typeof globalThis.setTimeout> | number;
export interface DictationControllerInput {
  port: DictationPort | null;
  /** Fresh lowercase UUID v4; native code echoes the identifier unchanged. */
  createId: () => string;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}
interface Session {
  id: string;
  target: DictationTarget;
  base: ReturnType<DictationTarget["read"]>;
  language: string;
  download: boolean;
  seq: number;
  finalized: string[];
  volatile: string[];
  finish: Promise<DictationFinish>;
  resolve: (finish: DictationFinish) => void;
  left: boolean;
  limit: boolean;
  timer: Timer | null;
}

/** One instance per app runtime, shared by every composer. No platform APIs are needed. */
export class DictationController {
  #input: DictationControllerInput;
  #listeners = new Set<() => void>();
  #levels = new Set<(level: number) => void>();
  #session: Session | null = null;
  #noticeTimer: Timer | null = null;
  #refreshGeneration = 0;
  #disposed = false;
  #unsubscribe: () => void;
  #snapshot: DictationSnapshot = {
    availability: null,
    phase: "idle",
    owner: null,
    language: null,
    preview: null,
    progress: null,
    startedAt: null,
    listeningSince: null,
    notice: null,
  };

  constructor(input: DictationControllerInput) {
    this.#input = input;
    this.#unsubscribe = input.port?.subscribe((event) => this.#receive(event)) ?? (() => {});
  }

  getSnapshot = (): DictationSnapshot => this.#snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  subscribeLevel = (listener: (level: number) => void): (() => void) => {
    this.#levels.add(listener);
    return () => {
      this.#levels.delete(listener);
    };
  };

  async refresh(): Promise<void> {
    const generation = ++this.#refreshGeneration;
    let availability: DictationAvailability | null;
    try {
      availability = DictationAvailabilitySchema.parse(
        await (this.#input.port?.availability() ?? { available: false, reason: "platform" }),
      );
    } catch {
      availability = null;
    }
    // Focus refreshes can overlap; an older answer must not undo a Settings change.
    if (
      !this.#disposed &&
      generation === this.#refreshGeneration &&
      JSON.stringify(availability) !== JSON.stringify(this.#snapshot.availability)
    ) {
      this.#publish({ availability });
    }
  }

  start(target: DictationTarget): void {
    if (this.#disposed || this.#session || this.#snapshot.phase !== "idle") return;
    this.dismissNotice();
    const availability = this.#snapshot.availability;
    if (!this.#input.port || !availability?.available) return;
    if (availability.microphone === "denied") {
      this.#notice(target.owner, "permission-denied", availability.languageName, false);
      void this.refresh();
      return;
    }
    let resolve!: Session["resolve"];
    const finish = new Promise<DictationFinish>((done) => {
      resolve = done;
    });
    const base = target.read();
    const session: Session = {
      id: DictationSessionIdSchema.parse(this.#input.createId()),
      target,
      base: { text: base.text, selection: { ...base.selection } },
      language: availability.languageName,
      download: availability.model === "download",
      seq: 0,
      finalized: [],
      volatile: [],
      finish,
      resolve,
      left: false,
      limit: false,
      timer: null,
    };
    this.#session = session;
    this.#publish({
      phase: session.download ? "downloading" : "starting",
      owner: target.owner,
      language: session.language,
      startedAt: session.download ? null : (this.#input.now ?? Date.now)(),
    });
    this.#command(session, session.download ? "download" : "start");
  }

  /**
   * Finishes this owner's dictation. Owner-scoped because two composers can
   * be mounted at once: another composer's Send must never finish, and then
   * send, this one's words. Do not make this async: callers share the exact
   * promise, even during finalization.
   */
  stop(owner: string): Promise<DictationFinish> {
    const session = this.#session;
    if (!session || session.target.owner !== owner) return Promise.resolve({ kind: "idle" });
    return this.#stop(session);
  }

  /** Discards this owner's dictation or download; the draft stays exactly as it was. */
  cancel(owner: string): void {
    const session = this.#session;
    if (!session || session.target.owner !== owner) return;
    this.dismissNotice();
    this.#terminate(session, "cancelled", null, true);
  }

  /** The input handler has already adopted the displayed text plus the person's edit. */
  release(owner: string): void {
    if (this.#snapshot.notice?.owner === owner) this.dismissNotice();
    if (this.#session?.target.owner === owner)
      this.#terminate(this.#session, "cancelled", null, true);
  }

  leave(owner: string): void {
    const session = this.#session;
    if (!session || session.target.owner !== owner || session.download) return;
    // Resolve the send waiter now, but retain the original target for the eventual commit.
    session.left = true;
    session.resolve({ kind: "aborted" });
    if (this.#snapshot.phase === "starting") this.cancel(owner);
    else if (this.#snapshot.phase === "listening") void this.#stop(session);
  }

  dismissNotice(): void {
    this.#clear(this.#noticeTimer);
    this.#noticeTimer = null;
    if (this.#snapshot.notice) this.#publish({ notice: null });
  }

  openMicrophoneSettings(): void {
    const notice = this.#snapshot.notice;
    // Only the notice that offered Settings may report that Settings failed to open.
    const failed = () => {
      if (!this.#disposed && notice && this.#snapshot.notice === notice) {
        this.#notice(notice.owner, "service-unavailable", "", false);
      }
    };
    try {
      void this.#input.port?.openMicrophoneSettings().catch(failed);
    } catch {
      failed();
    }
  }

  /** Runtime teardown cancels native work and removes subscriptions and timers. */
  dispose(): void {
    if (this.#disposed) return;
    // Fence first: the idle snapshot published by cancelling must not let a subscriber start anew.
    this.#disposed = true;
    if (this.#session) this.#terminate(this.#session, "cancelled", null, true);
    this.dismissNotice();
    this.#unsubscribe();
    this.#listeners.clear();
    this.#levels.clear();
  }

  #stop(session: Session): Promise<DictationFinish> {
    this.dismissNotice();
    if (session.download) {
      this.#terminate(session, "cancelled", null, true);
    } else if (this.#snapshot.phase !== "finishing") {
      // Finalizing can outlast the limit; a manual stop must not later report the limit.
      this.#clear(session.timer);
      session.timer = null;
      this.#publish({ phase: "finishing" });
      this.#command(session, "stop");
    }
    return session.finish;
  }

  #publish(patch: Partial<DictationSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
  }
  #timer(callback: () => void, ms: number): Timer {
    return (this.#input.setTimer ?? globalThis.setTimeout)(callback, ms);
  }
  #clear(timer: Timer | null): void {
    if (timer !== null) (this.#input.clearTimer ?? globalThis.clearTimeout)(timer);
  }
  #notice(owner: string, kind: DictationNoticeKind, language: string, committed: boolean): void {
    this.dismissNotice();
    this.#publish({
      notice: {
        owner,
        kind,
        message: dictationNoticeMessage(kind, { language, committed }),
        action: kind === "permission-denied" ? "open-settings" : null,
      },
    });
    if (kind === "empty" || kind === "downloaded") {
      this.#noticeTimer = this.#timer(() => this.dismissNotice(), 5000);
    }
  }
  #command(session: Session, command: "start" | "download" | "stop"): void {
    if (this.#session !== session) return;
    try {
      void this.#input.port![command](session.id).catch(() => {
        this.#terminate(session, "failed", "service-unavailable", true);
      });
    } catch {
      this.#terminate(session, "failed", "service-unavailable", true);
    }
  }
  #receive(input: unknown): void {
    const session = this.#session;
    if (!session) return;
    // Stale sessions are fenced before parsing: even their malformed late frames are irrelevant.
    if (
      typeof input === "object" &&
      input !== null &&
      "session" in input &&
      input.session !== session.id
    )
      return;
    const parsed = DictationEventSchema.safeParse(input);
    if (!parsed.success) {
      this.#terminate(session, "failed", "service-unavailable", true);
      return;
    }
    const event = parsed.data;
    if (event.seq <= session.seq) return;
    if (event.seq !== session.seq + 1) {
      this.#terminate(session, "failed", "recognition-failed", true);
      return;
    }
    session.seq = event.seq;
    switch (event.type) {
      case "downloading":
        if (session.download && event.progress !== this.#snapshot.progress)
          this.#publish({ progress: event.progress });
        break;
      case "listening":
        if (session.download || this.#snapshot.listeningSince !== null) break;
        // A stop accepted while starting already decided the end; capture is only draining.
        if (this.#snapshot.phase === "finishing") break;
        session.timer = this.#timer(() => {
          if (this.#session !== session) return;
          session.limit = true;
          void this.#stop(session);
        }, 600_000);
        this.#publish({ listeningSince: (this.#input.now ?? Date.now)(), phase: "listening" });
        break;
      case "text": {
        if (session.download) break;
        session.finalized.push(...event.finalized);
        session.volatile = event.volatile;
        const transcript = joinDictationText([...session.finalized, ...session.volatile]);
        const preview = transcript
          ? insertDictationText(session.base.text, session.base.selection, transcript)
          : null;
        if (preview?.text !== this.#snapshot.preview?.text) this.#publish({ preview });
        break;
      }
      case "level":
        if (!session.download) for (const listener of this.#levels) listener(event.level);
        break;
      case "ended":
        this.#terminate(session, event.reason, event.error);
        break;
    }
  }

  #terminate(
    session: Session,
    reason: DictationEndReason,
    error: DictationError | null,
    cancelNative = false,
  ): void {
    if (this.#session !== session) return;
    this.#session = null;
    this.#clear(session.timer);
    if (cancelNative) {
      // Invalidate first: synchronous callbacks and late command rejections cannot terminate twice.
      try {
        void this.#input.port!.cancel(session.id).catch(() => {});
      } catch {
        /* Already terminal. */
      }
    }
    let finish: DictationFinish = { kind: "aborted" };
    let notice: DictationNoticeKind | null = null;
    let committed = false;
    if (reason !== "cancelled") {
      const failed = reason !== "completed";
      if (session.download) {
        finish = { kind: failed ? "failed" : "empty" };
        notice = failed ? (error ?? (reason as "interrupted" | "device-changed")) : "downloaded";
      } else {
        // Native code finalizes before every ending it controls, so a tentative tail
        // remains only when that was cut short (an iOS background task expiring, a
        // failure): keep it rather than lose words the person already saw.
        const transcript = joinDictationText([...session.finalized, ...session.volatile]);
        if (transcript) {
          const current = session.target.read();
          const insertion =
            current.text === session.base.text
              ? insertDictationText(session.base.text, session.base.selection, transcript)
              : insertDictationText(
                  current.text,
                  { start: current.text.length, end: current.text.length },
                  transcript,
                );
          session.target.commit(insertion.text, insertion.selection);
          committed = true;
          finish = { kind: "committed", text: insertion.text };
        } else finish = { kind: "empty" };
        if (failed) {
          finish = { kind: "failed" };
          notice = error ?? (reason as "interrupted" | "device-changed");
        } else notice = session.limit ? "limit" : transcript ? null : "empty";
      }
    }
    this.#publish({
      phase: "idle",
      owner: null,
      language: null,
      preview: null,
      progress: null,
      startedAt: null,
      listeningSince: null,
    });
    for (const listener of this.#levels) listener(0);
    if (notice && !this.#disposed) {
      this.#notice(session.target.owner, notice, session.language, committed);
    }
    session.resolve(session.left ? { kind: "aborted" } : finish);
    if (session.download || error === "permission-denied" || error === "model-unavailable")
      void this.refresh();
  }
}
