import type { BrowserClientMessage } from "@opensteer/protocol";

type Message = BrowserClientMessage;
interface Entry {
  message: Message;
  hover?: Extract<Message, { type: "input.pointer" }>;
  readonly admitted: number;
  readonly first: number;
  last: number;
  count: number;
  readonly bytes: number;
  readonly cleanup: boolean;
  readonly wheelGesture: number;
  readonly done: Promise<void>;
  readonly finish: () => void;
}
export interface InputLaneDiagnostic {
  readonly producerId?: string;
  readonly generation?: number;
  readonly surfaceId?: string;
  readonly type: string;
  readonly first: number;
  readonly last: number;
  readonly count: number;
  readonly queuedMs: number;
  readonly serviceMs: number;
  readonly pending: number;
  readonly outcome: "completed" | "rejected" | "canceled";
}

/** Unsent runs can change; a dispatched operation always completes before the next one. */
export class BrowserInputLane {
  readonly #pending: Entry[] = [];
  #executing: Entry | null = null;
  #bytes = 0;
  #sequence = 0;
  #wheelSequence = 0;
  #wheel: {
    readonly message: Extract<Message, { type: "input.wheel" }>;
    readonly id: number;
    at: number;
  } | null = null;
  readonly #idle = new Set<() => void>();
  readonly diagnostics: InputLaneDiagnostic[] = [];
  readonly limit: number;
  readonly surfaceId: string | undefined;
  readonly execute: (message: Message) => Promise<void>;
  readonly refuse: (message: Message, reason: string) => Promise<void>;
  constructor(
    limit: number,
    execute: (message: Message) => Promise<void>,
    refuse: (message: Message, reason: string) => Promise<void>,
    surfaceId?: string,
  ) {
    this.surfaceId = surfaceId;
    this.limit = limit;
    this.execute = execute;
    this.refuse = refuse;
  }

  enqueue(message: Message, cleanup = false): Promise<void> {
    const now = performance.now();
    const sequence = message.inputSequence ?? ++this.#sequence;
    const wheelGesture = this.#latch(message, now);
    if (message.type === "input.wheel" && this.#wheel)
      message = { ...message, x: this.#wheel.message.x, y: this.#wheel.message.y };
    if (cleanup) {
      const waiting = this.#pending.find(
        (entry) =>
          entry.cleanup &&
          entry.message.type === message.type &&
          entry.message.producerId === message.producerId &&
          (message.type === "input.cancel" ||
            entry.message.inputGeneration === message.inputGeneration) &&
          (message.type === "input.cancel" ||
            (entry.message.type === "input.pointer" &&
              message.type === "input.pointer" &&
              entry.message.button === message.button) ||
            (entry.message.type === "input.key" &&
              message.type === "input.key" &&
              entry.message.code === message.code)),
      );
      if (waiting) return waiting.done;
    }
    const previous = this.#pending.at(-1);
    if (previous && previous.wheelGesture === wheelGesture && merge(previous, message)) {
      previous.last = sequence;
      previous.count++;
      return previous.done;
    }
    const bytes = Buffer.byteLength(JSON.stringify(message));
    // Cleanup has its own capacity, reserved by the controller for admitted presses.
    if (
      !cleanup &&
      (this.#pending.length >= this.limit ||
        this.#bytes + bytes > 2_097_152 ||
        (this.#pending[0] && now - this.#pending[0].admitted > 250))
    ) {
      this.#record(
        {
          type: message.type,
          first: sequence,
          last: sequence,
          count: 1,
          queuedMs: 0,
          serviceMs: 0,
          pending: this.#pending.length,
          outcome: "rejected",
        },
        message,
      );
      return this.refuse(message, "browser-input-overload");
    }
    let finish = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const entry: Entry = {
      message,
      admitted: now,
      first: sequence,
      last: sequence,
      count: 1,
      bytes,
      cleanup,
      wheelGesture,
      done,
      finish,
    };
    this.#pending.push(entry);
    this.#bytes += bytes;
    this.#pump();
    return done;
  }

  #latch(message: Message, now: number): number {
    const before = this.#wheel;
    if (message.type === "input.wheel" && !message.modifiers?.includes("control")) {
      // DOM/CDP supplies no native phases. A bounded wheel transaction keeps
      // its initial hit-test anchor, including when the pointer drifts. CDP
      // emits a fresh began/ended pair per dispatch, so preserve it explicitly.
      if (!before || now - before.at > 200 || !sameInputContext(before.message, message))
        this.#wheel = { message, at: now, id: ++this.#wheelSequence };
      else before.at = now;
      return this.#wheel!.id;
    }
    // Hover movement changes the cursor, not the scroll transaction's target.
    // A drag, key/button transition, or any page/geometry operation is a barrier.
    if (
      !before ||
      message.type !== "input.pointer" ||
      message.action !== "move" ||
      message.buttons !== 0 ||
      !sameInputContext(before.message, message)
    )
      this.#wheel = null;
    return this.#wheel?.id ?? 0;
  }

  cancel(matches: (message: Message) => boolean): void {
    if (this.#wheel && matches(this.#wheel.message)) this.#wheel = null;
    for (let i = this.#pending.length - 1; i >= 0; i--) {
      const entry = this.#pending[i]!;
      if (!matches(entry.message) || entry.cleanup) continue;
      this.#pending.splice(i, 1);
      this.#bytes -= entry.bytes;
      this.#record(
        {
          type: entry.message.type,
          first: entry.first,
          last: entry.last,
          count: entry.count,
          queuedMs: performance.now() - entry.admitted,
          serviceMs: 0,
          pending: this.#pending.length,
          outcome: "canceled",
        },
        entry.message,
      );
      // Follow is a replaceable sizing hint; dropping it on selection/close
      // is normal lifecycle behavior, not a refused person action.
      void (
        entry.message.type === "viewport.follow"
          ? Promise.resolve()
          : this.refuse(entry.message, "browser-input-canceled")
      )
        .catch(() => undefined)
        .finally(entry.finish);
    }
  }

  contains(matches: (message: Message) => boolean): boolean {
    return (
      Boolean(this.#executing && matches(this.#executing.message)) ||
      this.#pending.some((entry) => matches(entry.message))
    );
  }
  idle(): Promise<void> {
    return !this.#executing && !this.#pending.length
      ? Promise.resolve()
      : new Promise((resolve) => this.#idle.add(resolve));
  }

  #record(record: InputLaneDiagnostic, message: Message): void {
    record = {
      ...record,
      ...(message.producerId ? { producerId: message.producerId } : {}),
      generation: message.inputGeneration ?? 0,
      ...(this.surfaceId ? { surfaceId: this.surfaceId } : {}),
    };
    if (this.diagnostics.length === 256) this.diagnostics.shift();
    this.diagnostics.push(record);
    if (process.env.OPENSTEER_BROWSER_DIAGNOSTICS === "1")
      console.info(JSON.stringify({ browserInput: true, ...record }));
  }

  #pump(): void {
    if (this.#executing) return;
    const entry = this.#pending.shift();
    if (!entry) {
      for (const resolve of this.#idle) resolve();
      this.#idle.clear();
      return;
    }
    this.#bytes -= entry.bytes;
    this.#executing = entry;
    const started = performance.now();
    void this.execute(entry.message)
      .then(() => entry.hover && this.execute(entry.hover))
      .catch(() => undefined)
      .finally(() => {
        this.#record(
          {
            type: entry.message.type,
            first: entry.first,
            last: entry.last,
            count: entry.count,
            queuedMs: started - entry.admitted,
            serviceMs: performance.now() - started,
            pending: this.#pending.length,
            outcome: "completed",
          },
          entry.message,
        );
        this.#executing = null;
        entry.finish();
        this.#pump();
      });
  }
}

function merge(entry: Entry, next: Message): boolean {
  const before = entry.message;
  if (before.producerId !== next.producerId || before.inputGeneration !== next.inputGeneration)
    return false;
  if (
    before.type === "input.wheel" &&
    next.type === "input.pointer" &&
    next.action === "move" &&
    next.buttons === 0 &&
    !before.modifiers?.includes("control") &&
    sameInputContext(before, next)
  ) {
    // A latched scroll target is independent of bare hover hit-testing. A
    // waiting continuous run keeps its wheel sum and final cursor endpoint;
    // every button/key/page boundary still starts a separate ordered entry.
    entry.hover = next;
    entry.message = {
      ...before,
      inputSequence: next.inputSequence,
      inputSequenceStart: before.inputSequenceStart ?? before.inputSequence,
    };
    return true;
  }
  if (before.type !== next.type) return false;
  if (
    before.type === "viewport.follow" &&
    next.type === "viewport.follow" &&
    before.surfaceId === next.surfaceId
  ) {
    entry.message = {
      ...next,
      inputSequenceStart: before.inputSequenceStart ?? before.inputSequence,
    };
    return true;
  }
  if (
    (before.type !== "input.wheel" || next.type !== "input.wheel") &&
    (before.type !== "input.pointer" ||
      next.type !== "input.pointer" ||
      before.action !== "move" ||
      next.action !== "move")
  )
    return false;
  if (!sameInputContext(before, next)) return false;
  if (before.type === "input.pointer" && next.type === "input.pointer") {
    if (before.buttons !== next.buttons) return false;
    entry.message = {
      ...next,
      inputSequenceStart: before.inputSequenceStart ?? before.inputSequence,
    };
    return true;
  }
  if (before.type === "input.wheel" && next.type === "input.wheel") {
    // Native phases are unavailable here. Reversals and ctrl-wheel remain separate operations.
    if (
      before.modifiers?.includes("control") ||
      Math.sign(before.deltaX) !== Math.sign(next.deltaX) ||
      Math.sign(before.deltaY) !== Math.sign(next.deltaY)
    )
      return false;
    const deltaX = before.deltaX + next.deltaX;
    const deltaY = before.deltaY + next.deltaY;
    // Split large representable runs into adjacent entries; never clamp away displacement.
    if (
      !Number.isFinite(deltaX) ||
      !Number.isFinite(deltaY) ||
      Math.abs(deltaX) > 100_000 ||
      Math.abs(deltaY) > 100_000
    )
      return false;
    entry.message = {
      ...next,
      x: before.x,
      y: before.y,
      deltaX,
      deltaY,
      inputSequenceStart: before.inputSequenceStart ?? before.inputSequence,
    };
    return true;
  }
  return false;
}

function sameInputContext(before: Message, next: Message): boolean {
  return (
    "geometryRevision" in before &&
    "geometryRevision" in next &&
    before.producerId === next.producerId &&
    before.inputGeneration === next.inputGeneration &&
    before.surfaceId === next.surfaceId &&
    before.geometryRevision === next.geometryRevision &&
    before.viewportWidth === next.viewportWidth &&
    before.viewportHeight === next.viewportHeight &&
    (before.modifiers ?? []).join() === (next.modifiers ?? []).join()
  );
}
