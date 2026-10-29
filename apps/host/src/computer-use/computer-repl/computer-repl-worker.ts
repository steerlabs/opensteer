/// <reference lib="dom" />
import { parentPort } from "node:worker_threads";
import { setImmediate as yieldTurn } from "node:timers/promises";
import variant from "@jitl/quickjs-singlefile-mjs-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSContext,
  type QuickJSRuntime,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
} from "quickjs-emscripten-core";
import { computerGuestLibrary } from "./guest-library.js";
import {
  computerReplLimits as limits,
  boundedReplFailure,
  ToWorkerSchema,
  ReplRequestSchema,
  type ReplRequest,
  type FromWorker,
  type ReplFailure,
} from "./messages.js";

if (!parentPort) throw new Error("The computer REPL requires a worker");
const port = parentPort;
interface HostCall {
  id: number;
  request: ReplRequest;
  promise: QuickJSDeferredPromise;
}
interface Call {
  id: string;
  cpu: number;
  sliceStart: number;
  sliceHeldSince: number;
  failure: ReplFailure | undefined;
  poisoned: boolean;
  body: QuickJSHandle;
  queue: HostCall[];
  dispatched: HostCall | undefined;
  settled: boolean;
  returned: string | undefined;
  pumping: boolean;
  textBytes: number;
  messageBytes: number;
}
interface Context {
  vm: QuickJSContext;
  runtime: QuickJSRuntime;
  call: Call | undefined;
  nextId: number;
  snapshots: Map<string, string>;
  phones: Map<string, string>;
}
const contexts = new Map<string, Context>();
const cancelled = new Set<string>();
const creations = new Map<string, Promise<Context>>();
const send = (message: FromWorker) =>
  port.postMessage(
    message.type === "done" && message.error
      ? { ...message, error: boundedReplFailure(message.error) }
      : message,
  );
const failure = (message: string, code = "failed"): ReplFailure => ({
  code,
  message,
  performed: [],
});
function emitText(key: string, call: Call, text: string): void {
  if (call.poisoned) return;
  const textBytes = Buffer.byteLength(text);
  const message = { type: "text" as const, context: key, callId: call.id, text };
  // Charge framing too: zero-byte and tiny prints must not flood the channel.
  const messageBytes =
    textBytes <= limits.textBytes
      ? Buffer.byteLength(JSON.stringify(message))
      : limits.bridgeBytes + 1;
  if (
    call.textBytes + textBytes > limits.textBytes ||
    call.messageBytes + messageBytes > limits.bridgeBytes
  ) {
    call.failure ??= failure("Computer output exceeded its byte limit.", "output-limit");
    call.poisoned = true;
    return;
  }
  call.textBytes += textBytes;
  call.messageBytes += messageBytes;
  send(message);
}
// The slice and CPU budgets charge this thread's CPU time: a thread preempted
// on a busy machine has not run the guest's code meanwhile. Every Run shares
// this thread, so a slice also ends once it has held it for the wall bound.
function threadCpuMs(): number {
  const { user, system } = process.threadCpuUsage();
  return (user + system) / 1000;
}
function sliceFailure(cpu: number, held: number): ReplFailure | undefined {
  if (cpu > limits.sliceMs)
    return failure(
      "The code ran for 100 ms of CPU time without awaiting; split the work.",
      "slice-limit",
    );
  if (held > limits.sliceWallMs)
    return failure(
      "The code held the shared computer worker for 1 second without awaiting; split the work.",
      "slice-limit",
    );
  return undefined;
}
function slice<T>(context: Context, fn: () => T): T {
  const call = context.call;
  const start = threadCpuMs();
  const heldSince = performance.now();
  if (call) {
    call.sliceStart = start;
    call.sliceHeldSince = heldSince;
  }
  try {
    return fn();
  } finally {
    if (call) {
      const elapsed = threadCpuMs() - start;
      call.cpu += elapsed;
      const exceeded = sliceFailure(elapsed, performance.now() - heldSince);
      if (exceeded) {
        call.poisoned = true;
        call.failure ??= exceeded;
      }
      if (call.cpu > limits.cpuMs) {
        call.poisoned = true;
        call.failure ??= failure("The code exceeded 5 seconds of CPU time.", "cpu-limit");
      }
    }
  }
}
function dispose(key: string, discard = false) {
  const context = contexts.get(key);
  if (!context) return;
  contexts.delete(key);
  // An interrupted/OOM VM can retain engine jobs that JS_FreeRuntime refuses
  // to free. Nothing outside this context shares its WASM module: dropping
  // the complete island lets V8 collect it without executing guest cleanup.
  if (discard || context.call) return;
  context.vm.dispose();
  context.runtime.dispose();
}
async function create(key: string): Promise<Context> {
  // This release's malloc accounting does not accumulate ArrayBuffer memory.
  // A per-context WASM memory maximum is the hard bound for every allocation.
  const module = await newQuickJSWASMModuleFromVariant(
    newVariant(variant, {
      wasmMemory: new WebAssembly.Memory({ initial: 256, maximum: limits.memoryBytes / 65536 }),
    }),
  );
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(limits.stackBytes);
  const vm = runtime.newContext();
  const context: Context = {
    vm,
    runtime,
    call: undefined,
    nextId: 0,
    snapshots: new Map(),
    phones: new Map(),
  };
  runtime.setInterruptHandler(() => {
    const call = context.call;
    if (!call) return false;
    const used = threadCpuMs() - call.sliceStart;
    if (!call.failure) call.failure = sliceFailure(used, performance.now() - call.sliceHeldSince);
    if (!call.failure && call.cpu + used > limits.cpuMs)
      call.failure = failure("The code exceeded 5 seconds of CPU time.", "cpu-limit");
    if (call.failure?.code === "slice-limit" || call.failure?.code === "cpu-limit")
      call.poisoned = true;
    return call.poisoned;
  });
  const bridge = vm.newFunction("computerCall", (json) => {
    const call = context.call;
    if (!call || call.settled) throw new Error("This computer call has ended.");
    const input = vm.getString(json);
    if (Buffer.byteLength(input) > limits.bridgeBytes)
      throw new Error("Computer arguments exceed 1 MiB.");
    const request = ReplRequestSchema.parse(JSON.parse(input));
    const promise = vm.newPromise();
    call.queue.push({ id: ++context.nextId, request, promise });
    return promise.handle;
  });
  const print = vm.newFunction("computerPrint", (value) => {
    const call = context.call;
    if (!call || call.settled) throw new Error("This computer call has ended.");
    if (!call.poisoned) emitText(key, call, vm.getString(value));
    return vm.undefined;
  });
  vm.setProp(vm.global, "__computerCall", bridge);
  bridge.dispose();
  vm.setProp(vm.global, "__computerPrint", print);
  print.dispose();
  const initialized = vm.evalCode(computerGuestLibrary);
  vm.unwrapResult(initialized).dispose();
  contexts.set(key, context);
  return context;
}
function dispatch(key: string, context: Context, call: Call) {
  if (call.settled || call.dispatched) return;
  const item = call.queue.shift();
  if (!item) return;
  call.dispatched = item;
  const request = item.request;
  const window = request.args.window;
  if (typeof window === "string" && Array.isArray(request.args.actions))
    request.args.snapshot = context.snapshots.get(`${request.target}:${window}`) ?? null;
  if (window === undefined && Array.isArray(request.args.actions))
    request.args.observationId = context.phones.get(request.target ?? "") ?? null;
  send({ type: "request", context: key, callId: call.id, id: item.id, request });
}
function cancelQueued(context: Context, call: Call) {
  const queue = call.queue;
  call.queue = [];
  if (call.poisoned) return;
  const cancelled = context.vm.newString(
    JSON.stringify({
      error: { code: "cancelled", message: "This computer call has ended.", performed: [] },
    }),
  );
  try {
    for (const item of queue) {
      item.promise.resolve(cancelled);
      item.promise.dispose();
    }
  } finally {
    cancelled.dispose();
  }
}
async function pump(key: string, context: Context) {
  const call = context.call;
  if (!call || call.pumping) return;
  call.pumping = true;
  try {
    do {
      const jobs = slice(context, () => context.runtime.executePendingJobs(64));
      if (jobs.error) {
        call.failure ??= failure(String(context.vm.dump(jobs.error)));
        jobs.error.dispose();
      }
      const state = call.settled
        ? undefined
        : slice(context, () => context.vm.getPromiseState(call.body));
      if (state && state.type !== "pending") {
        call.settled = true;
        if (state.type === "rejected") {
          const value: unknown = context.vm.dump(state.error);
          call.failure ??= failure(
            typeof value === "object" && value !== null && "message" in value
              ? String(value.message)
              : String(value),
          );
          if (context.vm.typeof(state.error) === "object" && value !== null) {
            const code = context.vm.getProp(state.error, "code");
            const performed = context.vm.getProp(state.error, "performed");
            if (context.vm.typeof(code) === "string")
              call.failure.code = context.vm.getString(code);
            const receipts: unknown = context.vm.dump(performed);
            if (Array.isArray(receipts))
              call.failure.performed = receipts.filter(
                (value): value is string => typeof value === "string",
              );
            code.dispose();
            performed.dispose();
          }
          if (/out of memory/iu.test(call.failure.message)) call.poisoned = true;
          state.error.dispose();
        } else {
          if (context.vm.typeof(state.value) !== "undefined")
            call.returned = context.vm.getString(state.value);
          state.value.dispose();
        }
        cancelQueued(context, call);
      }
      if (call.failure) {
        if (/out of memory/iu.test(call.failure.message)) call.poisoned = true;
        call.settled = true;
        cancelQueued(context, call);
      }
      if (call.settled) {
        if (call.dispatched) return;
        if (!call.poisoned && context.runtime.hasPendingJob()) {
          await yieldTurn();
          continue;
        }
        if (!call.failure && call.returned !== undefined) emitText(key, call, call.returned);
        send({
          type: "done",
          context: key,
          callId: call.id,
          ...(call.failure ? { error: call.failure } : {}),
        });
        call.body.dispose();
        context.call = undefined;
        // Interrupted/OOM runtimes are discarded. Ordinary errors keep the
        // Run's globals after all guest jobs and dispatched work have drained.
        if (call.poisoned) dispose(key, true);
        return;
      }
      dispatch(key, context, call);
      if (!context.runtime.hasPendingJob()) return;
      await yieldTurn();
    } while (contexts.get(key) === context && context.call === call);
  } finally {
    call.pumping = false;
  }
}
port.on("message", (input: unknown) => {
  void handle(input).catch((error) => {
    const parsed = ToWorkerSchema.safeParse(input);
    if (parsed.success && (parsed.data.type === "execute" || parsed.data.type === "reply")) {
      dispose(parsed.data.context, true);
      send({
        type: "done",
        context: parsed.data.context,
        callId: parsed.data.callId,
        error: failure(error instanceof Error ? error.message : String(error)),
      });
    }
  });
});
async function handle(input: unknown) {
  const message = ToWorkerSchema.parse(input);
  if (message.type === "dispose") {
    dispose(message.context);
    return;
  }
  if (message.type === "cancel") {
    if (creations.has(message.context)) cancelled.add(message.callId);
    const context = contexts.get(message.context);
    if (context?.call?.id === message.callId) dispose(message.context);
    return;
  }
  if (message.type === "execute") {
    let context = contexts.get(message.context);
    if (!context) {
      let creating = creations.get(message.context);
      if (!creating) {
        creating = create(message.context);
        creations.set(message.context, creating);
      }
      try {
        context = await creating;
      } finally {
        creations.delete(message.context);
      }
    }
    if (cancelled.delete(message.callId)) {
      dispose(message.context);
      return;
    }
    if (context.call) throw new Error("Computer code is already running for this Run.");
    // Install the call before eval so the first synchronous slice is bounded.
    const call: Call = {
      id: message.callId,
      cpu: 0,
      sliceStart: 0,
      sliceHeldSince: 0,
      failure: undefined,
      poisoned: false,
      body: context.vm.undefined,
      queue: [],
      dispatched: undefined,
      settled: false,
      returned: undefined,
      pumping: false,
      textBytes: 0,
      messageBytes: 0,
    };
    context.call = call;
    const result = slice(context, () =>
      context.vm.evalCode(
        `(async () => {\n${message.code}\n})().then(value => value === undefined ? undefined : JSON.stringify(value))`,
        "computer.js",
      ),
    );
    if (result.error) {
      const error: unknown = context.vm.dump(result.error);
      call.failure ??= failure(
        typeof error === "object" && error !== null && "message" in error
          ? String(error.message)
          : String(error),
      );
      result.error.dispose();
      send({ type: "done", context: message.context, callId: call.id, error: call.failure });
      context.call = undefined;
      if (call.poisoned || /out of memory/iu.test(call.failure.message))
        dispose(message.context, true);
      return;
    }
    call.body = result.value;
    await pump(message.context, context);
    return;
  }
  const context = contexts.get(message.context);
  const call = context?.call;
  if (!context || !call || call.id !== message.callId || call.dispatched?.id !== message.id) return;
  const item = call.dispatched;
  call.dispatched = undefined;
  if (message.error && message.value === undefined) {
    if (item.request.target) context.phones.delete(item.request.target);
  }
  {
    const value = message.value;
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      "observation" in value
    ) {
      const observation = value.observation;
      if (typeof observation === "object" && observation !== null && !Array.isArray(observation)) {
        const window = item.request.args.window;
        if (typeof window === "string" && typeof observation.snapshot === "string")
          context.snapshots.set(`${item.request.target}:${window}`, observation.snapshot);
        if (typeof observation.observationId === "string")
          context.phones.set(item.request.target ?? "", observation.observationId);
      }
    }
    if (item.request.operation === "release") context.phones.delete(item.request.target ?? "");
  }
  const json = context.vm.newString(
    JSON.stringify(message.error ? { error: message.error } : { value: message.value }),
  );
  slice(context, () => item.promise.resolve(json));
  json.dispose();
  item.promise.dispose();
  await pump(message.context, context);
}
