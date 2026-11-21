import { DeviceRefusalContextSchema } from "@opensteer/protocol";
/// <reference lib="dom" />
import { parentPort, workerData } from "node:worker_threads";
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
import { browserGuestLibrary } from "../../browser-use/browser-guest-library.js";
import { browserGuestModules } from "../../browser-use/browser-guest-source.js";
import { browserReplLimits } from "../../browser-use/browser-repl-messages.js";
import { computerFailureLibrary, computerGuestLibrary } from "./guest-library.js";
import { guestStringFits, readGuestString } from "./guest-strings.js";
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
const browser = workerData === "browser";
const label = browser ? "Browser" : "Computer";
const ended = `This ${label.toLowerCase()} call has ended.`;
interface HostCall {
  id: number;
  request?: ReplRequest;
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
  dispatched: Map<number, HostCall>;
  timers: Map<number, { timeout: NodeJS.Timeout; callback: QuickJSHandle }>;
  settled: boolean;
  returned: string | undefined;
  pumping: boolean;
  textBytes: number;
  messageBytes: number;
  requests: number;
  requestBytes: number;
}
interface Context {
  vm: QuickJSContext;
  runtime: QuickJSRuntime;
  call: Call | undefined;
  nextId: number;
  snapshots: Map<string, string>;
  phones: Map<string, string>;
  receiveEvents: QuickJSHandle | undefined;
  endBrowserCall: QuickJSHandle | undefined;
  browserCodec: QuickJSHandle | undefined;
  computerFailure: QuickJSHandle | undefined;
}
const contexts = new Map<string, Context>();
const creations = new Map<string, { callId: string }>();
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
function outputExceeded(call: Call): void {
  call.failure ??= failure(`${label} output exceeded its byte limit.`, "output-limit");
  call.poisoned = true;
}
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
  )
    return outputExceeded(call);
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
      `The code held the shared ${label.toLowerCase()} worker for 1 second without awaiting; split the work.`,
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
  if (context.call) clearTimers(context.call);
  // An interrupted/OOM VM can retain engine jobs that JS_FreeRuntime refuses
  // to free. Nothing outside this context shares its WASM module: dropping
  // the complete island lets V8 collect it without executing guest cleanup.
  if (discard || context.call) return;
  context.receiveEvents?.dispose();
  context.endBrowserCall?.dispose();
  context.browserCodec?.dispose();
  context.computerFailure?.dispose();
  context.vm.dispose();
  context.runtime.dispose();
}
let guestModules: ReturnType<typeof browserGuestModules> | undefined;
async function create(key: string, connection: boolean): Promise<Context> {
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
    receiveEvents: undefined,
    endBrowserCall: undefined,
    browserCodec: undefined,
    computerFailure: undefined,
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
    if (!call || call.settled) throw new Error(ended);
    if (browser) {
      if (++call.requests > browserReplLimits.requests)
        return bridgeLimit(vm, "Browser request count exceeded.");
      if (call.dispatched.size >= browserReplLimits.pending)
        return bridgeLimit(vm, "At most 32 browser operations may be pending at once.");
      const remaining = Math.min(
        limits.bridgeBytes,
        browserReplLimits.requestBytes - call.requestBytes,
      );
      const input = readGuestString(context.vm, json, remaining);
      if (input === undefined) {
        call.requestBytes = browserReplLimits.requestBytes;
        return bridgeLimit(vm, "Browser request byte budget exceeded.");
      }
      call.requestBytes += Buffer.byteLength(input);
      const promise = vm.newPromise();
      const id = ++context.nextId;
      call.dispatched.set(id, { id, promise });
      send({ type: "browser-request", context: key, callId: call.id, id, json: input });
      return promise.handle;
    }
    // Only a measured string primitive leaves the guest; anything else is refused uncoerced.
    const input = readGuestString(vm, json, limits.bridgeBytes);
    if (input === undefined) throw new Error(`${label} arguments exceed 1 MiB.`);
    const request = ReplRequestSchema.parse(JSON.parse(input));
    const promise = vm.newPromise();
    call.queue.push({ id: ++context.nextId, request, promise });
    return promise.handle;
  });
  const print = vm.newFunction("computerPrint", (value, encoded = vm.undefined) => {
    const call = context.call;
    if (!call || call.settled) throw new Error(ended);
    if (!call.poisoned) {
      if (browser) emitBrowserText(key, context, call, value, encoded);
      else {
        const text = readGuestString(vm, value, limits.textBytes - call.textBytes);
        if (text === undefined) outputExceeded(call);
        else emitText(key, call, text);
      }
    }
    return vm.undefined;
  });
  vm.setProp(vm.global, "__computerCall", bridge);
  bridge.dispose();
  vm.setProp(vm.global, "__computerPrint", print);
  print.dispose();
  if (browser) {
    installBrowserTimers(key, context);
    const modules = (guestModules ??= browserGuestModules());
    runtime.setModuleLoader((name) => {
      if (!Object.hasOwn(modules, name)) throw new Error(`Unknown guest module: ${name}`);
      return modules[name]!;
    });
    try {
      vm.unwrapResult(
        vm.evalCode(browserGuestLibrary, "browser-guest.mjs", { type: "module" }),
      ).dispose();
    } finally {
      runtime.removeModuleLoader();
    }
    context.receiveEvents = vm.getProp(vm.global, "__browserReceiveEvents");
    context.endBrowserCall = vm.getProp(vm.global, "__browserEndCall");
    context.browserCodec = vm.getProp(vm.global, "__browserCodec");
    vm.unwrapResult(
      vm.evalCode("delete globalThis.__browserReceiveEvents; delete globalThis.__browserEndCall;"),
    ).dispose();
  } else {
    if (connection) vm.setProp(vm.global, "__computerConnection", vm.true);
    vm.unwrapResult(vm.evalCode(computerFailureLibrary)).dispose();
    context.computerFailure = vm.getProp(vm.global, "__computerFailure");
    vm.unwrapResult(vm.evalCode("delete globalThis.__computerFailure;")).dispose();
    vm.unwrapResult(vm.evalCode(computerGuestLibrary)).dispose();
  }
  return context;
}
function dispatch(key: string, context: Context, call: Call) {
  if (call.settled || call.dispatched.size) return;
  const item = call.queue.shift();
  if (!item) return;
  const request = ReplRequestSchema.parse(item.request);
  const window = request.args.window;
  if (typeof window === "string" && Array.isArray(request.args.actions))
    request.args.snapshot = context.snapshots.get(`${request.target}:${window}`) ?? null;
  if (window === undefined && Array.isArray(request.args.actions))
    request.args.observationId = context.phones.get(request.target ?? "") ?? null;
  dispatchItem(key, call, { ...item, request });
}
function dispatchItem(key: string, call: Call, item: HostCall) {
  call.dispatched.set(item.id, item);
  if (item.request)
    send({ type: "request", context: key, callId: call.id, id: item.id, request: item.request });
}

function clearTimers(call: Call) {
  for (const { timeout, callback } of call.timers.values()) {
    clearTimeout(timeout);
    if (!call.poisoned) callback.dispose();
  }
  call.timers.clear();
}

function installBrowserTimers(key: string, context: Context) {
  const { vm } = context;
  const install = (name: string, fn: (...args: QuickJSHandle[]) => QuickJSHandle) => {
    const handle = vm.newFunction(name, fn);
    vm.setProp(vm.global, name, handle);
    handle.dispose();
  };
  install("__browserNow", () => vm.newNumber(performance.now()));
  install("setTimeout", (fn, delay = vm.undefined) => {
    const call = context.call;
    if (!call || call.settled) throw new Error(ended);
    if (fn === undefined || vm.typeof(fn) !== "function")
      throw new TypeError("setTimeout requires a callback");
    if (call.timers.size >= browserReplLimits.timers)
      throw new Error("At most 128 browser timers may be pending at once.");
    const ms = vm.typeof(delay) === "number" ? vm.getNumber(delay) : 0;
    const clamped = Number.isNaN(ms) ? 0 : Math.max(0, Math.min(limits.wallMs, Math.ceil(ms)));
    const id = ++context.nextId;
    const callback = fn.dup();
    const timeout = setTimeout(() => {
      call.timers.delete(id);
      try {
        const result = slice(context, () => vm.callFunction(callback, vm.undefined));
        if (result.error) {
          call.failure ??= readFailure(context, result.error);
          result.error.dispose();
        } else result.value.dispose();
      } catch (error) {
        console.error("browser.repl.timer.failed", error);
        call.failure ??= failure("Browser timer failed.");
      } finally {
        callback.dispose();
      }
      void pump(key, context).catch(() => {
        dispose(key, true);
        send({
          type: "done",
          context: key,
          callId: call.id,
          error: failure("Browser timer failed."),
          reset: true,
        });
      });
    }, clamped);
    call.timers.set(id, { timeout, callback });
    return vm.newNumber(id);
  });
  install("clearTimeout", (value) => {
    const call = context.call;
    if (value === undefined || vm.typeof(value) !== "number" || !call) return vm.undefined;
    const id = vm.getNumber(value);
    const timer = call.timers.get(id);
    if (timer) {
      call.timers.delete(id);
      clearTimeout(timer.timeout);
      timer.callback.dispose();
    }
    return vm.undefined;
  });
}

function receiveEvents(context: Context, events: string) {
  const call = context.call;
  if (!call || !context.receiveEvents || events.length > browserReplLimits.eventBytes + 4096)
    return;
  const { vm } = context;
  const input = vm.newString(events);
  try {
    const result = slice(context, () =>
      vm.callFunction(context.receiveEvents!, vm.undefined, input),
    );
    if (result.error) {
      call.failure ??= readFailure(context, result.error);
      result.error.dispose();
    } else result.value.dispose();
  } finally {
    input.dispose();
  }
}

function bridgeLimit(vm: QuickJSContext, message: string): QuickJSHandle {
  return vm.newString(JSON.stringify({ error: { code: "bridge-limit", message } }));
}

function emitBrowserText(
  key: string,
  context: Context,
  call: Call,
  value: QuickJSHandle,
  json: QuickJSHandle,
): void {
  const encoded = guestStringFits(context.vm, value, limits.textBytes - call.textBytes)
    ? readGuestString(context.vm, json, limits.bridgeBytes - call.messageBytes)
    : undefined;
  if (encoded === undefined) {
    call.failure ??= failure("Browser output exceeded its byte limit.", "output-limit");
    call.poisoned = true;
  } else emitText(key, call, JSON.parse(encoded) as string);
}

function readBrowserFailure(context: Context, error: QuickJSHandle): ReplFailure {
  const { vm } = context;
  const result = vm.callFunction(context.browserCodec!, vm.undefined, vm.false, error);
  if (result.error) {
    result.error.dispose();
    return failure("Browser script failed.");
  }
  using fields = result.value;
  using code = vm.getProp(fields, 0);
  using message = vm.getProp(fields, 1);
  using next = vm.getProp(fields, 2);
  using cdp = vm.getProp(fields, 3);
  const cdpCode = vm.typeof(cdp) === "number" ? vm.getNumber(cdp) : undefined;
  const nextText = readGuestString(context.vm, next, 2000);
  return {
    ...failure(
      readGuestString(context.vm, message, 8192) ?? "Browser script failed.",
      readGuestString(context.vm, code, 128) ?? "failed",
    ),
    ...(nextText === undefined ? {} : { next: nextText }),
    ...(cdpCode === undefined ? {} : { cdpCode }),
  };
}

function readFailure(context: Context, error: QuickJSHandle): ReplFailure {
  const { call } = context;
  if (call?.failure) return call.failure;
  return slice(context, () => {
    if (browser) return readBrowserFailure(context, error);
    return readComputerFailure(context, error);
  });
}

function readComputerFailure(context: Context, error: QuickJSHandle): ReplFailure {
  const { vm } = context;
  const fields = vm.callFunction(context.computerFailure!, vm.undefined, error);
  if (fields.error) {
    fields.error.dispose();
    return failure("Computer script failed.");
  }
  using list = fields.value;
  // Every field is a string the guest already cut to `units`, so its worst case fits.
  const read = (from: QuickJSHandle, index: number, units: number) => {
    using item = vm.getProp(from, index);
    return readGuestString(vm, item, units * 9);
  };
  const result = failure(read(list, 0, 8192) ?? "Computer script failed.");
  using length = vm.getProp(list, "length");
  if (vm.getNumber(length) === 1) return result;
  const code = read(list, 1, 128);
  const next = read(list, 2, 2000);
  if (code !== undefined) result.code = code;
  if (next !== undefined) result.next = next;
  using receipts = vm.getProp(list, 3);
  using count = vm.getProp(receipts, "length");
  const receiptCount = vm.getNumber(count);
  for (let index = 0; index < Math.min(receiptCount, 160); index++) {
    const receipt = read(receipts, index, 2048);
    if (receipt !== undefined) result.performed.push(receipt);
  }
  const machineId = read(list, 4, 257);
  const capability = read(list, 5, 257);
  const machineName = read(list, 6, 257);
  const deviceContext = DeviceRefusalContextSchema.safeParse({
    ...(machineId === undefined ? {} : { machineId }),
    ...(capability === undefined ? {} : { capability }),
    ...(machineName === undefined ? {} : { machineName }),
  });
  if (deviceContext.success) Object.assign(result, deviceContext.data);
  return result;
}

function cancelQueued(context: Context, call: Call) {
  const queue = call.queue;
  call.queue = [];
  if (browser) {
    queue.push(...call.dispatched.values());
    call.dispatched.clear();
    clearTimers(call);
  }
  if (!queue.length) return;
  if (call.poisoned) return;
  const cancelled = context.vm.newString(
    JSON.stringify({
      error: { code: "cancelled", message: ended, performed: [] },
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
function settleBrowserCall(key: string, context: Context, call: Call): void {
  if (!browser || call.settled) return;
  send({ type: "settled", context: key, callId: call.id });
  if (call.poisoned || !context.endBrowserCall) return;
  const result = slice(context, () =>
    context.vm.callFunction(context.endBrowserCall!, context.vm.undefined),
  );
  if (result.error) {
    call.failure ??= readFailure(context, result.error);
    call.poisoned = true;
    result.error.dispose();
  } else result.value.dispose();
}

async function pump(key: string, context: Context) {
  const call = context.call;
  if (!call || call.pumping) return;
  call.pumping = true;
  try {
    let jobsThisTurn = 0;
    let turnStarted = performance.now();
    let first = true;
    do {
      if (!call.poisoned && (!browser || !first)) {
        const jobs = slice(context, () => context.runtime.executePendingJobs(browser ? 1 : 64));
        if (jobs.error) {
          call.failure ??= readFailure(context, jobs.error);
          jobs.error.dispose();
        }
      }
      first = false;
      const state = call.settled
        ? undefined
        : slice(context, () => context.vm.getPromiseState(call.body));
      if (state && state.type !== "pending") {
        settleBrowserCall(key, context, call);
        call.settled = true;
        if (state.type === "rejected") {
          const rejected = readFailure(context, state.error);
          call.failure ??= rejected;
          if (/out of memory/iu.test(call.failure.message)) call.poisoned = true;
          state.error.dispose();
        } else {
          if (context.vm.typeof(state.value) !== "undefined") {
            if (browser) {
              const { vm } = context;
              const encoded = slice(context, () =>
                vm.callFunction(context.browserCodec!, vm.undefined, vm.true, state.value),
              );
              if (encoded.error) {
                call.failure ??= readFailure(context, encoded.error);
                encoded.error.dispose();
              } else {
                if (vm.typeof(encoded.value) !== "undefined") {
                  call.returned = slice(context, () =>
                    readGuestString(context.vm, encoded.value, limits.textBytes - call.textBytes),
                  );
                  if (call.returned === undefined)
                    call.failure ??= failure(
                      "Browser output exceeded its byte limit.",
                      "output-limit",
                    );
                }
                encoded.value.dispose();
              }
            } else {
              // The wrapper's JSON.stringify is the guest's and may return anything.
              const returned = readGuestString(
                context.vm,
                state.value,
                limits.textBytes - call.textBytes,
              );
              if (returned === undefined) outputExceeded(call);
              else call.returned = returned;
            }
          }
          state.value.dispose();
        }
        cancelQueued(context, call);
      }
      if (call.failure) {
        if (/out of memory/iu.test(call.failure.message)) call.poisoned = true;
        settleBrowserCall(key, context, call);
        call.settled = true;
        cancelQueued(context, call);
      }
      if (call.settled) {
        if (call.dispatched.size) return;
        if (!call.poisoned && context.runtime.hasPendingJob()) {
          if (!browser || ++jobsThisTurn >= 64 || performance.now() - turnStarted >= 10) {
            await yieldTurn();
            jobsThisTurn = 0;
            turnStarted = performance.now();
          }
          continue;
        }
        if (!call.failure && call.returned !== undefined) emitText(key, call, call.returned);
        send({
          type: "done",
          context: key,
          callId: call.id,
          ...(call.failure ? { error: call.failure } : {}),
          ...(browser && call.poisoned ? { reset: true } : {}),
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
      if (!browser || ++jobsThisTurn >= 64 || performance.now() - turnStarted >= 10) {
        await yieldTurn();
        jobsThisTurn = 0;
        turnStarted = performance.now();
      }
    } while (contexts.get(key) === context && context.call === call);
  } finally {
    call.pumping = false;
  }
}
port.on("message", (input: unknown) => {
  void handle(input).catch((error) => {
    const parsed = ToWorkerSchema.safeParse(input);
    if (
      parsed.success &&
      (parsed.data.type === "execute" ||
        parsed.data.type === "reply" ||
        parsed.data.type === "events")
    ) {
      if (browser) console.error("browser.repl.worker.failed", error);
      dispose(parsed.data.context, true);
      send({
        type: "done",
        context: parsed.data.context,
        callId: parsed.data.callId,
        error: failure(
          browser
            ? "Browser worker failed."
            : error instanceof Error
              ? error.message
              : String(error),
        ),
        ...(browser ? { reset: true } : {}),
      });
    }
  });
});
async function handle(input: unknown) {
  const message = ToWorkerSchema.parse(input);
  if (message.type === "dispose") {
    creations.delete(message.context);
    dispose(message.context);
    return;
  }
  if (message.type === "cancel") {
    const creating = creations.get(message.context);
    if (creating?.callId === message.callId) creations.delete(message.context);
    const context = contexts.get(message.context);
    if (context?.call?.id === message.callId) dispose(message.context);
    return;
  }
  if (message.type === "execute") {
    let context = contexts.get(message.context);
    if (!context) {
      const creating = { callId: message.callId };
      creations.set(message.context, creating);
      try {
        context = await create(message.context, message.connection === true);
      } catch (error) {
        if (creations.get(message.context) !== creating) return;
        creations.delete(message.context);
        throw error;
      }
      if (creations.get(message.context) !== creating) {
        context.receiveEvents?.dispose();
        context.endBrowserCall?.dispose();
        context.browserCodec?.dispose();
        context.computerFailure?.dispose();
        context.vm.dispose();
        context.runtime.dispose();
        return;
      }
      creations.delete(message.context);
      contexts.set(message.context, context);
    }
    if (context.call) throw new Error(`${label} code is already running for this context.`);
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
      dispatched: new Map(),
      timers: new Map(),
      settled: false,
      returned: undefined,
      pumping: false,
      textBytes: 0,
      messageBytes: 0,
      requests: 0,
      requestBytes: 0,
    };
    context.call = call;
    if (browser) {
      if (message.events) receiveEvents(context, message.events);
      send({ type: "ready", context: message.context, callId: call.id });
    }
    const result = slice(context, () =>
      context.vm.evalCode(
        `(async () => {\n${message.code}\n})()${browser ? "" : ".then(value => value === undefined ? undefined : JSON.stringify(value))"}`,
        browser ? "browser.js" : "computer.js",
      ),
    );
    if (result.error) {
      const rejected = readFailure(context, result.error);
      call.failure ??= rejected;
      result.error.dispose();
      if (/out of memory/iu.test(call.failure.message)) call.poisoned = true;
      await pump(message.context, context);
      return;
    }
    call.body = result.value;
    await pump(message.context, context);
    return;
  }
  const context = contexts.get(message.context);
  const call = context?.call;
  if (!context || !call || call.id !== message.callId) return;
  if (message.type === "events") {
    if (call.settled || call.failure) return;
    receiveEvents(context, message.events);
    send({ type: "events-read", context: message.context, callId: call.id });
    await pump(message.context, context);
    return;
  }
  const item = call.dispatched.get(message.id);
  if (!item) return;
  call.dispatched.delete(message.id);
  if (!browser && item.request) {
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
        if (
          typeof observation === "object" &&
          observation !== null &&
          !Array.isArray(observation)
        ) {
          const window = "window" in item.request.args ? item.request.args.window : undefined;
          if (typeof window === "string" && typeof observation.snapshot === "string")
            context.snapshots.set(`${item.request.target}:${window}`, observation.snapshot);
          if (typeof observation.observationId === "string")
            context.phones.set(item.request.target ?? "", observation.observationId);
        } else if (observation === null && item.request.target) {
          context.phones.delete(item.request.target);
        }
      }
      if (
        !message.error &&
        (item.request.operation === "bind" || item.request.operation === "tab") &&
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
      ) {
        const connection =
          typeof value.connectionId === "string" ? value.connectionId : item.request.target;
        const window = value.window;
        if (
          typeof window === "object" &&
          window !== null &&
          !Array.isArray(window) &&
          typeof window.ref === "string"
        )
          context.snapshots.delete(`${connection}:${window.ref}`);
        else context.phones.delete(connection ?? "");
      }
      if (item.request.operation === "release") context.phones.delete(item.request.target ?? "");
    }
  }
  const json = context.vm.newString(
    JSON.stringify(message.error ? { error: message.error } : { value: message.value }),
  );
  slice(context, () => item.promise.resolve(json));
  json.dispose();
  item.promise.dispose();
  await pump(message.context, context);
}
