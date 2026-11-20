import { DeviceAccessRefusal } from "../../administration/device-access.js";
import { utf8Prefix, OpensteerError } from "@opensteer/core";
import { systemClock, type Clock } from "@opensteer/shared/clock";
import { delay } from "@opensteer/shared/delay";
import type { z } from "zod";
import {
  browserJsonShapeFits,
  browserReplLimits,
  decodedBase64Bytes,
} from "../../browser-use/browser-repl-messages.js";
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { hostWorkerUrl } from "../../process-entries.js";
import {
  computerReplLimits as limits,
  boundedReplFailure,
  FromWorkerSchema,
  ReplRequestSchema,
  type AnyReplRequest,
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
export type ComputerReplInvocation = ReplInvocation<ReplRequest>;
export type ReplInvocation<Request> = Request & {
  readonly context: ComputerReplContext;
  readonly signal: AbortSignal;
  readonly deadline: number;
};
export type ComputerReplResult = ReplResult;
export type ReplResult = {
  content: ReplContent[];
  isError?: true;
  structuredContent?: { error: ReplFailure };
};
interface Call<Request> {
  readonly id: string;
  readonly context: ComputerReplContext;
  readonly key: string;
  readonly code: string;
  readonly invoke: (request: ReplInvocation<Request>) => Promise<ReplReply>;
  readonly deadline: number;
  readonly cancellation: AbortController;
  readonly content: ReplContent[];
  readonly resolve: (result: ReplResult) => void;
  readonly cleanup: () => void;
  started: boolean;
  mutationsInFlight: number;
  operationsInFlight: number;
  abandoned: "outcome-unknown" | "operation-pending" | undefined;
  requests: number;
  requestBytes: number;
  ready: boolean;
  eventsPending: boolean;
  textBytes: number;
  imageBytes: number;
  images: number;
}
interface Resident<Request> {
  context: ComputerReplContext;
  usedAt: number;
  call: Call<Request> | undefined;
}
const failure = (message: string): ReplResult => ({
  isError: true,
  content: [{ type: "text", text: message }],
});

type ReplOptions<Request> = {
  readonly invoke: (request: ReplInvocation<Request>) => Promise<ReplReply>;
  readonly clock?: Clock;
  readonly wait?: typeof delay;
};
type ReplEvents = {
  batch: (context: ComputerReplContext) => string | undefined;
  acknowledge: (context: ComputerReplContext) => void;
  dispose: (context: ComputerReplContext) => void;
  error: (error: unknown) => ReplFailure;
};

export class ReplService<Request extends AnyReplRequest> {
  readonly #request: z.ZodType<Request>;
  readonly #events: ReplEvents | undefined;
  readonly #label: "Browser" | "Computer";
  readonly #invoke: (request: ReplInvocation<Request>) => Promise<ReplReply>;
  readonly #clock: Clock;
  readonly #wait: typeof delay;
  readonly #contexts = new Map<string, Resident<Request>>();
  readonly #ended = new Set<string>();
  readonly #revoked = new Set<string>();
  readonly #generations = new Map<string, number>();
  readonly #queue = new Map<string, Call<Request>>();
  #expiry: NodeJS.Timeout | undefined;
  #expiryAt = Infinity;
  #worker: Worker | undefined;
  #executing = 0;
  #browserPending = 0;
  readonly #browserPendingByContext = new Map<string, number>();
  #closed = false;
  constructor(
    options: ReplOptions<Request> & {
      readonly request: z.ZodType<Request>;
      readonly browser?: ReplEvents;
    },
  ) {
    this.#invoke = options.invoke;
    this.#request = options.request;
    this.#events = options.browser;
    this.#label = options.browser ? "Browser" : "Computer";
    this.#clock = options.clock ?? systemClock;
    this.#wait = options.wait ?? delay;
  }

  #scheduleExpiry(): void {
    let next = Infinity;
    if (!this.#closed) {
      for (const resident of this.#contexts.values())
        if (!resident.call) next = Math.min(next, resident.usedAt + limits.idleMs);
    }
    if (next === this.#expiryAt) return;
    clearTimeout(this.#expiry);
    this.#expiry = undefined;
    this.#expiryAt = next;
    if (!Number.isFinite(next)) return;
    this.#expiry = setTimeout(
      () => {
        this.#expiryAt = Infinity;
        this.#expiry = undefined;
        const now = Date.now();
        for (const [key, resident] of this.#contexts)
          if (!resident.call && now - resident.usedAt >= limits.idleMs) this.#dispose(key);
        this.#scheduleExpiry();
      },
      Math.max(0, next - Date.now()),
    );
    this.#expiry.unref();
  }

  execute(
    context: ComputerReplContext,
    code: string,
    signal?: AbortSignal,
    invoke: (request: ReplInvocation<Request>) => Promise<ReplReply> = this.#invoke,
  ): Promise<ReplResult> {
    if (this.#closed || this.#ended.has(context.runId))
      return Promise.resolve(
        failure(
          this.#events
            ? "This browser context has ended."
            : "This Run's computer context has ended.",
        ),
      );
    if (
      !code.length ||
      code.length > limits.codeBytes ||
      Buffer.byteLength(code) > limits.codeBytes
    )
      return Promise.resolve(failure(`${this.#label} code must contain 1 to 65536 bytes.`));
    if (signal?.aborted) return Promise.resolve(failure(`${this.#label} code was cancelled.`));
    const key = `${context.runId}:${context.generation}`;
    if (
      this.#revoked.has(key) ||
      (this.#generations.get(context.runId) ?? context.generation) > context.generation
    )
      return Promise.resolve(failure("This computer attempt has ended."));
    if (!this.#events) this.#generations.set(context.runId, context.generation);
    for (const [other, resident] of this.#contexts)
      if (resident.context.runId === context.runId && other !== key) this.#dispose(other);
    let resident = this.#contexts.get(key);
    if (resident?.call)
      return Promise.resolve(
        failure(
          this.#events
            ? "Browser code is already running for this context. Wait for that call to finish."
            : "Computer code is already running for this Run. Wait for that call to finish.",
        ),
      );
    if (!resident) {
      if (this.#contexts.size >= limits.contexts) {
        const oldest = [...this.#contexts]
          .filter(([, entry]) => !entry.call)
          .sort((a, b) => a[1].usedAt - b[1].usedAt)[0];
        if (!oldest)
          return Promise.resolve(
            failure(
              `All 16 ${this.#label.toLowerCase()} contexts are in use. Try after one finishes.`,
            ),
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
          code: call.mutationsInFlight ? "outcome-unknown" : "cancelled",
          message: `${this.#label} code was cancelled. A dispatched action may already have happened; observe before deciding what to do next.`,
          performed: [],
        });
      const cancelDeadline = this.#clock.schedule(
        () =>
          this.#finish(call, {
            code: call.mutationsInFlight ? "outcome-unknown" : "deadline",
            message: `${this.#label} code reached its 100 second deadline. A dispatched action may already have happened; observe before deciding what to do next.`,
            performed: [],
          }),
        limits.wallMs,
      );
      const call: Call<Request> = {
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
        mutationsInFlight: 0,
        operationsInFlight: 0,
        abandoned: undefined,
        requests: 0,
        requestBytes: 0,
        ready: false,
        eventsPending: false,
        textBytes: 0,
        imageBytes: 0,
        images: 0,
      };
      resident.call = call;
      this.#scheduleExpiry();
      signal?.addEventListener("abort", cancel, { once: true });
      this.#queue.set(call.id, call);
      this.#drain();
    });
  }
  #post(message: ToWorker): void {
    this.#worker?.postMessage(message);
  }
  #ensureWorker(): void {
    if (this.#worker) return;
    const source = import.meta.url.endsWith(".ts");
    const worker = new Worker(hostWorkerUrl("computer-repl-worker", import.meta.url), {
      ...(this.#events ? { workerData: "browser" } : {}),
      resourceLimits: { maxOldGenerationSizeMb: 512 },
      ...(source ? { execArgv: ["--import", "tsx"] } : {}),
    });
    this.#worker = worker;
    worker.on("message", (message: unknown) => {
      if (this.#worker === worker)
        void this.#message(message).catch((error) => {
          if (this.#worker === worker) this.#failWorker(error);
        });
    });
    worker.on("error", (error) => {
      if (this.#worker === worker) this.#failWorker(error);
    });
    worker.on("exit", (code) => {
      if (this.#worker === worker) {
        this.#worker = undefined;
        if (!this.#closed) this.#failWorker(new Error(`${this.#label} worker exited (${code})`));
      }
    });
  }
  #drain(): void {
    if (this.#closed) return;
    while (this.#executing < limits.executing) {
      const call = this.#queue.values().next().value;
      if (!call) return;
      this.#queue.delete(call.id);
      if (this.#contexts.get(call.key)?.call !== call) continue;
      this.#ensureWorker();
      call.started = true;
      this.#executing++;
      const events = this.#events?.batch(call.context);
      this.#post({
        type: "execute",
        context: call.key,
        callId: call.id,
        code: call.code,
        ...(events === undefined ? {} : { events }),
      });
    }
  }
  eventsAvailable(context: ComputerReplContext): void {
    const call = this.#contexts.get(`${context.runId}:${context.generation}`)?.call;
    if (!call?.ready || call.eventsPending) return;
    const events = this.#events?.batch(context);
    if (events === undefined) return;
    call.eventsPending = true;
    this.#post({ type: "events", context: call.key, callId: call.id, events });
  }

  async #message(input: unknown): Promise<void> {
    const message = FromWorkerSchema.parse(input);
    const call = this.#contexts.get(message.context)?.call;
    if (!call || call.id !== message.callId) return;
    if (message.type === "done") {
      this.#finish(call, message.error, message.reset ?? false);
      return;
    }
    if (message.type === "text") {
      this.#emit(call, { type: "text", text: message.text });
      return;
    }
    if (message.type === "settled") {
      call.ready = false;
      call.abandoned = call.mutationsInFlight
        ? "outcome-unknown"
        : call.operationsInFlight
          ? "operation-pending"
          : undefined;
      call.cancellation.abort();
      return;
    }
    if (message.type === "ready" || message.type === "events-read") {
      this.#events?.acknowledge(call.context);
      call.ready = true;
      call.eventsPending = false;
      this.eventsAvailable(call.context);
      return;
    }
    if (message.type === "browser-request") {
      if (this.#events) await this.#browserRequest(call, message);
      return;
    }
    if (this.#events) return;
    const request = this.#request.parse(message.request);
    const mutation = ["click", "type", "key", "setValue", "scroll", "act"].includes(
      request.operation,
    );
    if (mutation) call.mutationsInFlight++;
    try {
      const result =
        request.operation === "sleep"
          ? await this.#sleep("ms" in request.args ? request.args.ms : undefined, call)
          : ReplReplySchema.parse(
              await call.invoke({
                ...request,
                context: call.context,
                signal: call.cancellation.signal,
                deadline: call.deadline,
              }),
            );
      if (this.#contexts.get(call.key)?.call !== call) return;
      const json = JSON.stringify(result.value);
      if (Buffer.byteLength(json) > limits.bridgeBytes)
        throw Object.assign(new Error(`${this.#label} result exceeds 1 MiB.`), {
          code: "failed",
        });
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
        code:
          error instanceof DeviceAccessRefusal
            ? error.reason
            : error instanceof OpensteerError && error.reason
              ? error.reason
              : "code" in record && typeof record.code === "string"
                ? record.code
                : "failed",
        ...(error instanceof DeviceAccessRefusal
          ? { machineId: error.machineId, capability: error.capability }
          : {}),
        message:
          error instanceof DeviceAccessRefusal
            ? `${error.message} ${error.next ?? ""}`
            : error instanceof Error
              ? error.message
              : `${this.#label} operation failed.`,
        ...("next" in record && typeof record.next === "string" ? { next: record.next } : {}),
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
        failure.message = `${this.#label} result exceeds 1 MiB.`;
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
      if (mutation) call.mutationsInFlight--;
    }
  }
  async #browserRequest(call: Call<Request>, message: { id: number; json: string }): Promise<void> {
    const address = { context: call.key, callId: call.id, id: message.id };
    const reject = (code: string, message: string) =>
      this.#post({ type: "reply", ...address, error: { code, message, performed: [] } });
    const remaining = Math.min(
      limits.bridgeBytes,
      browserReplLimits.requestBytes - call.requestBytes,
    );
    if (++call.requests > browserReplLimits.requests || message.json.length > remaining) {
      reject("bridge-limit", "Browser request budget exceeded.");
      return;
    }
    const bytes = Buffer.byteLength(message.json);
    call.requestBytes += bytes;
    if (bytes > remaining || !browserJsonShapeFits(message.json)) {
      reject("bridge-limit", "Browser request exceeds its byte or nesting limit.");
      return;
    }
    if (call.cancellation.signal.aborted) return;
    const parsed = this.#request.safeParse(JSON.parse(message.json));
    if (!parsed.success) {
      reject("invalid-request", "Invalid browser request.");
      return;
    }
    const request = parsed.data;
    const mutation =
      request.operation === "browser.open" ||
      request.operation === "browser.new" ||
      request.operation === "browser.command";
    const portOperation = mutation || request.operation === "browser.pages";
    const pending = this.#browserPendingByContext.get(call.key) ?? 0;
    if (
      portOperation &&
      (pending >= browserReplLimits.pending ||
        this.#browserPending >= browserReplLimits.totalPending)
    ) {
      reject("bridge-limit", "Too many browser operations are still pending.");
      return;
    }
    if (portOperation) {
      this.#browserPendingByContext.set(call.key, pending + 1);
      this.#browserPending++;
      call.operationsInFlight++;
      if (mutation) call.mutationsInFlight++;
    }
    let result: ReplReply;
    try {
      try {
        result = await call.invoke({
          ...request,
          context: call.context,
          signal: call.cancellation.signal,
          deadline: call.deadline,
        });
      } finally {
        // The port promise is the completion acknowledgement, including after abort.
        if (portOperation) {
          const count = this.#browserPendingByContext.get(call.key)!;
          if (count === 1) this.#browserPendingByContext.delete(call.key);
          else this.#browserPendingByContext.set(call.key, count - 1);
          this.#browserPending--;
          call.operationsInFlight--;
          if (mutation) call.mutationsInFlight--;
        }
      }
      if (this.#contexts.get(call.key)?.call !== call || call.cancellation.signal.aborted) return;
      for (const block of result.content ?? []) if (!this.#emit(call, block)) return;
      this.#post({ type: "reply", ...address, value: result.value });
    } catch (error) {
      if (call.cancellation.signal.aborted && error === call.cancellation.signal.reason) return;
      const failure = this.#events!.error(error);
      if (this.#contexts.get(call.key)?.call === call && !call.cancellation.signal.aborted)
        this.#post({ type: "reply", ...address, error: boundedReplFailure(failure) });
    }
  }

  async #sleep(ms: unknown, call: Call<Request>): Promise<ReplReply> {
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0 || ms > limits.wallMs)
      throw new Error("sleep requires a duration from 0 to 100000 ms.");
    await this.#wait(ms, call.cancellation.signal);
    return { value: null };
  }
  #emit(call: Call<Request>, block: ReplContent): boolean {
    const textBytes = call.textBytes + (block.type === "text" ? Buffer.byteLength(block.text) : 0);
    const images = call.images + (block.type === "image" ? 1 : 0);
    const imageBytes =
      call.imageBytes +
      (block.type === "image"
        ? this.#events
          ? decodedBase64Bytes(block.data)
          : Buffer.from(block.data, "base64").byteLength
        : 0);
    if (textBytes > limits.textBytes || images > limits.images || imageBytes > limits.imageBytes) {
      this.#finish(call, {
        code: "output-limit",
        message: `${this.#label} output exceeded its limit (512 KiB text, 8 images, 4 MiB image bytes).`,
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
  #finish(call: Call<Request>, error?: ReplFailure, reset = true): void {
    const resident = this.#contexts.get(call.key);
    if (resident?.call !== call) return;
    if (this.#events && (call.mutationsInFlight || call.abandoned === "outcome-unknown"))
      error = {
        code: "outcome-unknown",
        message:
          "Browser code ended while an action was still pending. Observe the page before deciding what to do next.",
        performed: [],
      };
    else if (
      this.#events &&
      (call.operationsInFlight || call.abandoned === "operation-pending") &&
      !error
    )
      error = {
        code: "operation-pending",
        message:
          "Browser code ended while a browser operation was still pending. Await each operation before returning.",
        performed: [],
      };
    if (!call.started) this.#queue.delete(call.id);
    resident.call = undefined;
    resident.usedAt = Date.now();
    this.#scheduleExpiry();
    call.cleanup();
    if (reset && call.started) this.#events?.dispose(call.context);
    if (this.#events) call.cancellation.abort();
    if (error) {
      if (call.started) this.#post({ type: "cancel", context: call.key, callId: call.id });
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
    const failure = error ? boundedReplFailure(error) : undefined;
    call.resolve({
      content: call.content,
      ...(failure
        ? {
            isError: true as const,
            structuredContent: {
              error: failure,
            },
          }
        : {}),
    });
    this.#drain();
  }
  #dispose(key: string): void {
    const resident = this.#contexts.get(key);
    if (!resident) return;
    if (resident.call)
      this.#finish(resident.call, {
        code: "cancelled",
        message: `This ${this.#label.toLowerCase()} context has ended.`,
        performed: [],
      });
    this.#post({ type: "dispose", context: key });
    this.#events?.dispose(resident.context);
    this.#contexts.delete(key);
    this.#scheduleExpiry();
  }
  #failWorker(error: unknown): void {
    const worker = this.#worker;
    this.#worker = undefined;
    if (this.#events) console.error("browser.repl.worker.failed", error);
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
        message:
          !this.#events && error instanceof Error ? error.message : `${this.#label} worker failed.`,
        performed: [],
      });
    for (const resident of this.#contexts.values()) this.#events?.dispose(resident.context);
    this.#contexts.clear();
    this.#queue.clear();
    this.#closed = closed;
    this.#scheduleExpiry();
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
    this.#scheduleExpiry();
    for (const key of this.#contexts.keys()) this.#dispose(key);
    const worker = this.#worker;
    this.#worker = undefined;
    if (worker) await worker.terminate();
  }
}

/** One isolated worker for the Host; each Run attempt has its own bounded VM. */
export class ComputerReplService extends ReplService<ReplRequest> {
  constructor(options: ReplOptions<ReplRequest>) {
    super({ ...options, request: ReplRequestSchema });
  }
}
