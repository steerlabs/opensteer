import { utf8Prefix } from "@opensteer/core";
import { systemClock, type Clock } from "@opensteer/shared/clock";
import { delay } from "@opensteer/shared/delay";
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import {
  computerReplLimits as limits,
  boundedReplFailure,
  FromWorkerSchema,
  ReplReplySchema,
  type ToWorker,
  type ReplContent,
  type ReplFailure,
  type ReplRequest,
  type ReplReply,
} from "./messages.js";

export interface ComputerReplContext {
  readonly runId: string;
  readonly generation: number;
}
export interface ComputerReplInvocation extends ReplRequest {
  readonly context: ComputerReplContext;
  readonly signal: AbortSignal;
  readonly deadline: number;
}
export type ComputerReplResult = { content: ReplContent[]; isError?: true };
interface Call {
  readonly id: string;
  readonly context: ComputerReplContext;
  readonly key: string;
  readonly code: string;
  readonly invoke: (request: ComputerReplInvocation) => Promise<ReplReply>;
  readonly deadline: number;
  readonly cancellation: AbortController;
  readonly content: ReplContent[];
  readonly resolve: (result: ComputerReplResult) => void;
  readonly cleanup: () => void;
  started: boolean;
  mutationInFlight: boolean;
  textBytes: number;
  imageBytes: number;
  images: number;
}
interface Resident {
  context: ComputerReplContext;
  usedAt: number;
  call: Call | undefined;
}
const failure = (message: string): ComputerReplResult => ({
  isError: true,
  content: [{ type: "text", text: message }],
});

/** One isolated worker for the Host; each Run attempt has its own bounded VM. */
export class ComputerReplService {
  readonly #invoke: (request: ComputerReplInvocation) => Promise<ReplReply>;
  readonly #clock: Clock;
  readonly #wait: typeof delay;
  readonly #contexts = new Map<string, Resident>();
  readonly #ended = new Set<string>();
  readonly #revoked = new Set<string>();
  readonly #generations = new Map<string, number>();
  readonly #queue: Call[] = [];
  readonly #sweep: NodeJS.Timeout;
  #worker: Worker | undefined;
  #executing = 0;
  #closed = false;
  constructor(options: {
    readonly invoke: (request: ComputerReplInvocation) => Promise<ReplReply>;
    /** Domain time for the wall deadline and script `sleep`; invocation deadlines stay real. */
    readonly clock?: Clock;
    readonly wait?: typeof delay;
  }) {
    this.#invoke = options.invoke;
    this.#clock = options.clock ?? systemClock;
    this.#wait = options.wait ?? delay;
    this.#sweep = setInterval(() => {
      for (const [key, resident] of this.#contexts)
        if (!resident.call && Date.now() - resident.usedAt >= limits.idleMs) this.#dispose(key);
    }, 60_000);
    this.#sweep.unref();
  }
  execute(
    context: ComputerReplContext,
    code: string,
    signal?: AbortSignal,
    invoke: (request: ComputerReplInvocation) => Promise<ReplReply> = this.#invoke,
  ): Promise<ComputerReplResult> {
    if (this.#closed || this.#ended.has(context.runId))
      return Promise.resolve(failure("This Run's computer context has ended."));
    if (!code.length || Buffer.byteLength(code) > limits.codeBytes)
      return Promise.resolve(failure("Computer code must contain 1 to 65536 bytes."));
    if (signal?.aborted) return Promise.resolve(failure("Computer code was cancelled."));
    const key = `${context.runId}:${context.generation}`;
    if (
      this.#revoked.has(key) ||
      (this.#generations.get(context.runId) ?? context.generation) > context.generation
    )
      return Promise.resolve(failure("This computer attempt has ended."));
    this.#generations.set(context.runId, context.generation);
    for (const [other, resident] of this.#contexts)
      if (resident.context.runId === context.runId && other !== key) this.#dispose(other);
    let resident = this.#contexts.get(key);
    if (resident?.call)
      return Promise.resolve(
        failure("Computer code is already running for this Run. Wait for that call to finish."),
      );
    if (!resident) {
      if (this.#contexts.size >= limits.contexts) {
        const oldest = [...this.#contexts]
          .filter(([, entry]) => !entry.call)
          .sort((a, b) => a[1].usedAt - b[1].usedAt)[0];
        if (!oldest)
          return Promise.resolve(
            failure("All 16 computer contexts are in use. Try after one finishes."),
          );
        this.#dispose(oldest[0]);
      }
      resident = { context, usedAt: Date.now(), call: undefined };
      this.#contexts.set(key, resident);
    }
    const cancellation = new AbortController();
    return new Promise((resolve) => {
      const cancel = () =>
        this.#finish(call, {
          code: call.mutationInFlight ? "outcome-unknown" : "cancelled",
          message:
            "Computer code was cancelled. A dispatched action may already have happened; observe before deciding what to do next.",
          performed: [],
        });
      const cancelDeadline = this.#clock.schedule(
        () =>
          this.#finish(call, {
            code: call.mutationInFlight ? "outcome-unknown" : "deadline",
            message:
              "Computer code reached its 100 second deadline. A dispatched action may already have happened; observe before deciding what to do next.",
            performed: [],
          }),
        limits.wallMs,
      );
      const call: Call = {
        id: randomUUID(),
        key,
        context,
        code,
        invoke,
        deadline: Date.now() + limits.wallMs,
        cancellation,
        content: [],
        resolve,
        cleanup: () => {
          cancelDeadline();
          signal?.removeEventListener("abort", cancel);
        },
        started: false,
        mutationInFlight: false,
        textBytes: 0,
        imageBytes: 0,
        images: 0,
      };
      resident.call = call;
      signal?.addEventListener("abort", cancel, { once: true });
      this.#queue.push(call);
      this.#drain();
    });
  }
  #post(message: ToWorker): void {
    this.#worker?.postMessage(message);
  }
  #ensureWorker(): void {
    if (this.#worker) return;
    const source = import.meta.url.endsWith(".ts");
    const worker = new Worker(
      new URL(source ? "./computer-repl-worker.ts" : "./computer-repl-worker.js", import.meta.url),
      {
        resourceLimits: { maxOldGenerationSizeMb: 512 },
        ...(source ? { execArgv: ["--import", "tsx"] } : {}),
      },
    );
    this.#worker = worker;
    worker.on("message", (message: unknown) => {
      void this.#message(message).catch((error) => this.#failWorker(error));
    });
    worker.on("error", (error) => this.#failWorker(error));
    worker.on("exit", (code) => {
      if (this.#worker === worker) {
        this.#worker = undefined;
        if (!this.#closed) this.#failWorker(new Error(`Computer worker exited (${code})`));
      }
    });
  }
  #drain(): void {
    if (this.#closed) return;
    while (this.#executing < limits.executing) {
      const call = this.#queue.shift();
      if (!call) return;
      if (this.#contexts.get(call.key)?.call !== call) continue;
      this.#ensureWorker();
      call.started = true;
      this.#executing++;
      this.#post({ type: "execute", context: call.key, callId: call.id, code: call.code });
    }
  }
  async #message(input: unknown): Promise<void> {
    const message = FromWorkerSchema.parse(input);
    const call = this.#contexts.get(message.context)?.call;
    if (!call || call.id !== message.callId) return;
    if (message.type === "done") {
      this.#finish(call, message.error);
      return;
    }
    if (message.type === "text") {
      this.#emit(call, { type: "text", text: message.text });
      return;
    }
    call.mutationInFlight = ["click", "type", "key", "setValue", "scroll", "act"].includes(
      message.request.operation,
    );
    try {
      const result =
        message.request.operation === "sleep"
          ? await this.#sleep(message.request.args.ms, call)
          : ReplReplySchema.parse(
              await call.invoke({
                ...message.request,
                context: call.context,
                signal: call.cancellation.signal,
                deadline: call.deadline,
              }),
            );
      if (this.#contexts.get(call.key)?.call !== call) return;
      const json = JSON.stringify(result.value);
      if (Buffer.byteLength(json) > limits.bridgeBytes)
        throw new Error("Computer result exceeds 1 MiB.");
      for (const block of result.content ?? []) if (!this.#emit(call, block)) return;
      this.#post({
        type: "reply",
        context: call.key,
        callId: call.id,
        id: message.id,
        value: result.value,
      });
    } catch (error) {
      if (this.#contexts.get(call.key)?.call !== call) return;
      const record = typeof error === "object" && error !== null ? error : {};
      const failure: ReplFailure = {
        code: "code" in record && typeof record.code === "string" ? record.code : "failed",
        message: error instanceof Error ? error.message : "Computer operation failed.",
        performed:
          "performed" in record && Array.isArray(record.performed)
            ? record.performed.filter((value): value is string => typeof value === "string")
            : [],
      };
      if ("content" in record && Array.isArray(record.content)) {
        const parsed = ReplReplySchema.shape.content.safeParse(record.content);
        if (parsed.success)
          for (const block of parsed.data ?? []) if (!this.#emit(call, block)) return;
      } else
        for (const text of failure.performed) if (!this.#emit(call, { type: "text", text })) return;
      let value =
        "value" in record ? ReplReplySchema.shape.value.safeParse(record.value) : undefined;
      if (value?.success && Buffer.byteLength(JSON.stringify(value.data)) > limits.bridgeBytes) {
        value = undefined;
        failure.message = "Computer result exceeds 1 MiB.";
      }
      this.#post({
        type: "reply",
        context: call.key,
        callId: call.id,
        id: message.id,
        error: boundedReplFailure(failure),
        ...(value?.success ? { value: value.data } : {}),
      });
    } finally {
      call.mutationInFlight = false;
    }
  }
  async #sleep(ms: unknown, call: Call): Promise<ReplReply> {
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0 || ms > limits.wallMs)
      throw new Error("sleep requires a duration from 0 to 100000 ms.");
    await this.#wait(ms, call.cancellation.signal);
    return { value: null };
  }
  #emit(call: Call, block: ReplContent): boolean {
    const textBytes = call.textBytes + (block.type === "text" ? Buffer.byteLength(block.text) : 0);
    const images = call.images + (block.type === "image" ? 1 : 0);
    const imageBytes =
      call.imageBytes + (block.type === "image" ? Buffer.from(block.data, "base64").byteLength : 0);
    if (textBytes > limits.textBytes || images > limits.images || imageBytes > limits.imageBytes) {
      this.#finish(call, {
        code: "output-limit",
        message: "Computer output exceeded its limit (512 KiB text, 8 images, 4 MiB image bytes).",
        performed: [],
      });
      return false;
    }
    call.textBytes = textBytes;
    call.images = images;
    call.imageBytes = imageBytes;
    call.content.push(
      block.type === "image" ? { ...block, _meta: { "codex/imageDetail": "original" } } : block,
    );
    return true;
  }
  #finish(call: Call, error?: ReplFailure): void {
    const resident = this.#contexts.get(call.key);
    if (resident?.call !== call) return;
    resident.call = undefined;
    resident.usedAt = Date.now();
    call.cleanup();
    if (error) {
      this.#post({ type: "cancel", context: call.key, callId: call.id });
      call.cancellation.abort();
      const bounded = boundedReplFailure(error);
      // Accepted receipts keep their order; only the final error uses the remainder.
      const text = utf8Prefix(
        `${bounded.code}: ${bounded.message}`,
        Math.max(0, limits.textBytes - call.textBytes),
      );
      if (text) {
        call.content.push({ type: "text", text });
        call.textBytes += Buffer.byteLength(text);
      }
    }
    if (call.started) this.#executing--;
    call.resolve({ content: call.content, ...(error ? { isError: true as const } : {}) });
    this.#drain();
  }
  #dispose(key: string): void {
    const resident = this.#contexts.get(key);
    if (!resident) return;
    if (resident.call)
      this.#finish(resident.call, {
        code: "cancelled",
        message: "This computer context has ended.",
        performed: [],
      });
    this.#post({ type: "dispose", context: key });
    this.#contexts.delete(key);
  }
  #failWorker(error: unknown): void {
    const worker = this.#worker;
    this.#worker = undefined;
    if (worker) void worker.terminate();
    const calls = [...this.#contexts.values()].flatMap((resident) =>
      resident.call ? [resident.call] : [],
    );
    // Suppress draining until every affected generation has been invalidated.
    const closed = this.#closed;
    this.#closed = true;
    for (const call of calls)
      this.#finish(call, {
        code: "worker-failed",
        message: error instanceof Error ? error.message : "Computer worker failed.",
        performed: [],
      });
    this.#contexts.clear();
    this.#queue.length = 0;
    this.#closed = closed;
  }
  async endRun(runId: string): Promise<void> {
    this.#ended.add(runId);
    for (const [key, resident] of this.#contexts)
      if (resident.context.runId === runId) this.#dispose(key);
  }
  resetGeneration(runId: string, generation: number): void {
    this.#dispose(`${runId}:${generation}`);
  }
  endGeneration(runId: string, generation: number): void {
    const key = `${runId}:${generation}`;
    this.#revoked.add(key);
    this.#dispose(key);
  }
  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#sweep);
    for (const key of this.#contexts.keys()) this.#dispose(key);
    const worker = this.#worker;
    this.#worker = undefined;
    if (worker) await worker.terminate();
  }
}
