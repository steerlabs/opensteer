import { getDeviceDefinition } from "@opensteer/integration-catalog/devices";
import {
  isComputerAppDefinition,
  type ComputerAppOperation,
} from "@opensteer/integration-core/computer-app";
import { computerAppOperationContract } from "@opensteer/integration-core/computer-app-tools";
import {
  IntegrationsModuleEventSchema,
  ComputerUseSessionIdSchema,
  HostIntegrationsComputerUseSchema,
  type DeviceScreenDriverAssignment,
  type HostIntegrationsComputerUse,
  RunnerAuxiliaryRequestIdSchema,
  RunnerAuxiliaryStreamIdSchema,
  RunnerBootIdSchema,
  RunnerConnectionIdSchema,
  RunnerConnectionLeaseIdSchema,
  type HostIntegrationsInvoke,
  type IntegrationsModuleEvent,
} from "@opensteer/protocol";
import type { RunnerModuleStream } from "@opensteer/runner-client";
import { createId } from "@opensteer/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakePhoneScreenDriver } from "./phone-screen-driver.test-support.js";
import { ComputerUseHandler } from "./computer-use-handler.js";
import { ComputerUseBridgeError } from "./computer-use-bridge-client.js";
import { prepareIntegrationsModule } from "./prepare.js";
import { IphoneScreenDriver } from "./iphone-screen-driver.js";
import { ComputerAppModuleHandler } from "./module-handler.js";
import {
  ComputerAppError,
  type ComputerAppOperationInspection,
  type ComputerAppProvider,
  type ComputerAppValue,
} from "./provider.js";

const definition = getDeviceDefinition("apple-messages");
if (!definition || !isComputerAppDefinition(definition)) {
  throw new Error("The Messages computer app definition is missing");
}
const definitionOperations = definition.config.operations;
const operation = (name: string): ComputerAppOperation => {
  const found = definitionOperations.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing test operation ${name}`);
  return found;
};
const readOperation = operation("query_messages");
const writeOperation = operation("send_message");

const fence = {
  auxiliaryStreamId: RunnerAuxiliaryStreamIdSchema.parse(
    "rax_00000000-0000-4000-8000-000000000001",
  ),
  bootId: RunnerBootIdSchema.parse("rbt_00000000-0000-4000-8000-000000000002"),
  connectionGeneration: 1,
  connectionId: RunnerConnectionIdSchema.parse("rcn_00000000-0000-4000-8000-000000000003"),
  connectionLeaseId: RunnerConnectionLeaseIdSchema.parse(
    "rls_00000000-0000-4000-8000-000000000004",
  ),
  module: "integrations" as const,
  runnerId: createId("runner"),
};

const handlers: ComputerAppModuleHandler[] = [];

afterEach(() => {
  for (const handler of handlers.splice(0)) handler.detach();
  vi.useRealTimers();
});

describe("ComputerAppModuleHandler", () => {
  it("inspects on attach and sends status only when it changes", async () => {
    vi.useFakeTimers();
    let inspection: readonly ComputerAppOperationInspection[] = readyInspection();
    const inspect = vi.fn(async () => inspection);
    const fixture = setup({ inspect });

    await eventually(() => expect(statuses(fixture.events)).toHaveLength(1));
    expect(statuses(fixture.events)[0]?.apps).toEqual([
      { definitionId: "apple-messages", operations: readyInspection() },
    ]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(statuses(fixture.events)).toHaveLength(1);

    inspection = readyInspection().map((entry) =>
      entry.operation === "export_attachment"
        ? {
            ...entry,
            detail: "Messages needs Full access.",
            remedy: "full-disk-access" as const,
            state: "permission-required" as const,
          }
        : entry,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await eventually(() => expect(statuses(fixture.events)).toHaveLength(2));
    expect(inspect).toHaveBeenCalledTimes(3);
  });

  it("re-inspects immediately after a permission failure", async () => {
    const inspect = vi.fn(async () => readyInspection());
    const fixture = setup({
      inspect,
      invoke: async () => {
        throw new ComputerAppError("permission-required", "Automation is disabled.");
      },
    });
    await eventually(() => expect(inspect).toHaveBeenCalledTimes(1));
    await fixture.handle(invoke("permission", readOperation));
    await eventually(() => expect(results(fixture.events)).toHaveLength(1));
    await eventually(() => expect(inspect).toHaveBeenCalledTimes(2));
    expect(results(fixture.events)[0]?.result).toEqual({
      code: "permission-required",
      kind: "error",
      message: "Automation is disabled.",
    });
  });

  it("answers every request to look again made while one waits with that one", async () => {
    const first = deferred<readonly ComputerAppOperationInspection[]>();
    const inspect = vi
      .fn<ComputerAppProvider["inspect"]>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async () => readyInspection());
    const fixture = setup({
      inspect,
      invoke: vi.fn(async () => {
        throw new ComputerAppError("permission-required", "Needs access.");
      }),
    });
    for (const id of ["one", "two", "three"]) await fixture.handle(invoke(id, readOperation));
    await eventually(() => expect(resultFor(fixture.events, "three")).toBeDefined());

    first.resolve(readyInspection());
    await eventually(() => expect(inspect).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("refuses calls to computer apps in a stopped boot but still reports their status", async () => {
    const fixture = setup({ stopped: true });
    await fixture.handle(invoke("stopped", readOperation));
    await eventually(() => expect(statuses(fixture.events)).toHaveLength(1));
    expect(fixture.provider.invoke).not.toHaveBeenCalled();
    expect(resultFor(fixture.events, "stopped")?.result).toEqual({
      code: "failed",
      kind: "error",
      message: "Agents are stopped. Resume them to continue.",
    });
  });

  it("refuses unknown definitions, operations and contracts before touching a provider", async () => {
    const fixture = setup();
    await fixture.handle({
      ...invoke("unknown-definition", readOperation),
      definitionId: "other-app",
    });
    await fixture.handle({ ...invoke("unknown-operation", readOperation), operation: "not_here" });
    await fixture.handle({ ...invoke("contract", readOperation), contract: "a".repeat(43) });

    expect(fixture.provider.invoke).not.toHaveBeenCalled();
    expect(results(fixture.events).map(({ result }) => result)).toEqual([
      expect.objectContaining({ code: "unsupported" }),
      expect.objectContaining({ code: "unsupported" }),
      {
        code: "unsupported",
        kind: "error",
        message: "This operation comes from a different Opensteer version.",
      },
    ]);
  });

  it("refuses write access and invalid arguments before touching a provider", async () => {
    const fixture = setup();
    await fixture.handle({ ...invoke("read-only", writeOperation), access: "read" });
    await fixture.handle({ ...invoke("invalid", readOperation), arguments: { limit: 0 } });

    expect(fixture.provider.invoke).not.toHaveBeenCalled();
    expect(results(fixture.events).map(({ result }) => result)).toEqual([
      { code: "failed", kind: "error", message: "This app is read only." },
      expect.objectContaining({ code: "invalid-arguments" }),
    ]);
  });

  it("refuses a fifth concurrent call and releases a slot when one finishes", async () => {
    const calls = Array.from({ length: 5 }, deferred<ComputerAppValue>);
    let call = 0;
    const fixture = setup({ invoke: vi.fn(() => calls[call++]!.promise) });
    for (let index = 0; index < 4; index += 1) {
      await fixture.handle(invoke(`parallel-${index}`, readOperation));
    }
    await fixture.handle(invoke("busy", readOperation));
    expect(fixture.provider.invoke).toHaveBeenCalledTimes(4);
    expect(resultFor(fixture.events, "busy")?.result).toEqual(
      expect.objectContaining({ code: "busy" }),
    );

    calls[0]!.resolve({ done: true });
    await eventually(() => expect(resultFor(fixture.events, "parallel-0")).toBeDefined());
    await fixture.handle(invoke("after-slot", readOperation));
    expect(fixture.provider.invoke).toHaveBeenCalledTimes(5);
    for (const pending of calls.slice(1)) pending.resolve({ done: true });
  });

  it("holds a cancelled call's slot until the provider it ignored actually stops", async () => {
    // Four providers that never settle and never look at their signal: every
    // cancel below answers the Host, and none of them ends any work.
    const calls = Array.from({ length: 6 }, deferred<ComputerAppValue>);
    let call = 0;
    const fixture = setup({ invoke: vi.fn(() => calls[call++]!.promise) });
    for (let index = 0; index < 4; index += 1) {
      await fixture.handle(invoke(`stuck-${index}`, readOperation));
    }
    for (let index = 0; index < 4; index += 1) {
      await fixture.handle({ requestId: `stuck-${index}`, type: "host.integrations.cancel" });
    }
    await eventually(() => expect(results(fixture.events)).toHaveLength(4));

    await fixture.handle(invoke("fifth", readOperation));
    expect(resultFor(fixture.events, "fifth")?.result).toEqual(
      expect.objectContaining({ code: "busy" }),
    );
    expect(fixture.provider.invoke).toHaveBeenCalledTimes(4);

    calls[0]!.resolve({ done: true });
    await flush();
    await fixture.handle(invoke("sixth", readOperation));
    expect(fixture.provider.invoke).toHaveBeenCalledTimes(5);
    expect(resultFor(fixture.events, "sixth")).toBeUndefined();
    for (const pending of calls) pending.resolve({ done: true });
  });

  it("keeps the slots of running work across a new stream on the same module", async () => {
    const calls = Array.from({ length: 5 }, deferred<ComputerAppValue>);
    let call = 0;
    const fixture = setup({ invoke: vi.fn(() => calls[call++]!.promise) });
    for (let index = 0; index < 4; index += 1) {
      await fixture.handle(invoke(`stuck-${index}`, readOperation));
    }
    const second = fixture.openStream();
    await fixture.handle(invoke("after-restream", readOperation));

    expect(resultFor(second.events, "after-restream")?.result).toEqual(
      expect.objectContaining({ code: "busy" }),
    );
    expect(fixture.provider.invoke).toHaveBeenCalledTimes(4);

    for (const pending of calls.slice(0, 4)) pending.resolve({ done: true });
    await flush();
    await fixture.handle(invoke("after-settle", readOperation));
    expect(fixture.provider.invoke).toHaveBeenCalledTimes(5);
    calls[4]!.resolve({ done: true });
  });

  it("sends nothing more when an abandoned provider resolves after its answer", async () => {
    const pending = deferred<ComputerAppValue>();
    const fixture = setup({ invoke: vi.fn(() => pending.promise) });
    await fixture.handle(invoke("late", readOperation));
    await fixture.handle({ requestId: "late", type: "host.integrations.cancel" });
    await eventually(() => expect(resultFor(fixture.events, "late")).toBeDefined());
    const answered = results(fixture.events).length;

    pending.resolve({ late: true });
    await flush();
    expect(results(fixture.events)).toHaveLength(answered);
  });

  it("ignores a duplicate in-flight request id", async () => {
    const pending = deferred<ComputerAppValue>();
    const info = vi.fn();
    const fixture = setup({ info, invoke: vi.fn(() => pending.promise) });
    const message = invoke("duplicate", readOperation);
    await fixture.handle(message);
    await fixture.handle(message);

    expect(fixture.provider.invoke).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      "Ignoring a duplicate computer app request",
      expect.objectContaining({ requestId: "duplicate" }),
    );
    pending.resolve({ done: true });
  });

  it("aborts a cancelled call", async () => {
    let providerSignal: AbortSignal | undefined;
    const fixture = setup({
      invoke: vi.fn(async (_operation, _args, signal) => {
        providerSignal = signal;
        return await new Promise<ComputerAppValue>(() => undefined);
      }),
    });
    await fixture.handle(invoke("cancelled", readOperation));
    await fixture.handle({ requestId: "cancelled", type: "host.integrations.cancel" });

    expect(providerSignal?.aborted).toBe(true);
    await eventually(() => expect(resultFor(fixture.events, "cancelled")).toBeDefined());
  });

  it("reports read and write deadlines with different certainty", async () => {
    vi.useFakeTimers();
    const fixture = setup({
      invoke: vi.fn(async () => await new Promise<ComputerAppValue>(() => undefined)),
    });
    await fixture.handle({ ...invoke("read-timeout", readOperation), timeoutMs: 10 });
    await fixture.handle({ ...invoke("write-timeout", writeOperation), timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);

    expect(resultFor(fixture.events, "read-timeout")?.result).toEqual({
      code: "failed",
      kind: "error",
      message: "Timed out.",
    });
    expect(resultFor(fixture.events, "write-timeout")?.result).toEqual(
      expect.objectContaining({ code: "outcome-unknown" }),
    );
  });

  it("turns an oversized result into a bounded failure", async () => {
    const fixture = setup({ invoke: vi.fn(async () => "x".repeat(1_024 * 1_024)) });
    await fixture.handle(invoke("oversized", readOperation));
    await eventually(() => expect(resultFor(fixture.events, "oversized")).toBeDefined());

    expect(resultFor(fixture.events, "oversized")?.result).toEqual({
      code: "failed",
      kind: "error",
      message: "Narrow the request.",
    });
  });

  it("does not expose a path from an unexpected provider failure", async () => {
    const fixture = setup({
      invoke: vi.fn(async () => {
        throw new Error("ENOENT: /Users/person/Library/Messages/chat.db");
      }),
    });
    await fixture.handle(invoke("raw-error", readOperation));
    await eventually(() => expect(resultFor(fixture.events, "raw-error")).toBeDefined());
    const result = resultFor(fixture.events, "raw-error")?.result;
    expect(result).toEqual({
      code: "failed",
      kind: "error",
      message: "The app could not complete this request.",
    });
    expect(result?.kind === "error" ? result.message.length : 301).toBeLessThanOrEqual(300);
  });

  it("never calls a write failed when it may already have taken effect", async () => {
    const mayHaveHappened = {
      code: "outcome-unknown",
      kind: "error",
      message: "The request may already have taken effect.",
    };
    const thrown = setup({
      invoke: vi.fn(async () => {
        throw new Error("The reply could not be built");
      }),
    });
    await thrown.handle(invoke("write-threw", writeOperation));
    await eventually(() => expect(resultFor(thrown.events, "write-threw")).toBeDefined());
    expect(resultFor(thrown.events, "write-threw")?.result).toEqual(mayHaveHappened);

    const oversized = setup({ invoke: vi.fn(async () => "x".repeat(1_024 * 1_024)) });
    await oversized.handle(invoke("write-oversized", writeOperation));
    await eventually(() => expect(resultFor(oversized.events, "write-oversized")).toBeDefined());
    expect(resultFor(oversized.events, "write-oversized")?.result).toEqual(mayHaveHappened);

    // A provider's own refusal says what happened, write or not.
    const refused = setup({
      invoke: vi.fn(async () => {
        throw new ComputerAppError("permission-required", "Allow it in System Settings.");
      }),
    });
    await refused.handle(invoke("write-refused", writeOperation));
    await eventually(() => expect(resultFor(refused.events, "write-refused")).toBeDefined());
    expect(resultFor(refused.events, "write-refused")?.result).toEqual({
      code: "permission-required",
      kind: "error",
      message: "Allow it in System Settings.",
    });
  });

  it("aborts every call on detach and sends nothing afterward", async () => {
    const signals: AbortSignal[] = [];
    const fixture = setup({
      invoke: vi.fn(async (_operation, _args, signal) => {
        signals.push(signal);
        return await new Promise<ComputerAppValue>(() => undefined);
      }),
    });
    await eventually(() => expect(statuses(fixture.events)).toHaveLength(1));
    fixture.events.splice(0);
    await fixture.handle(invoke("one", readOperation));
    await fixture.handle(invoke("two", readOperation));
    fixture.handler.detach();
    await Promise.resolve();

    expect(signals).toHaveLength(2);
    expect(signals.every(({ aborted }) => aborted)).toBe(true);
    expect(fixture.events).toEqual([]);
  });

  it("returns from the frame handler before the provider resolves", async () => {
    const pending = deferred<ComputerAppValue>();
    const fixture = setup({ invoke: vi.fn(() => pending.promise) });
    const order: string[] = [];
    const handled = fixture
      .handle(invoke("ordering", readOperation))
      .then(() => order.push("handled"));
    void pending.promise.then(() => order.push("provider"));

    await handled;
    expect(order).toEqual(["handled"]);
    expect(resultFor(fixture.events, "ordering")).toBeUndefined();
    pending.resolve({ done: true });
    await eventually(() => expect(resultFor(fixture.events, "ordering")).toBeDefined());
    expect(order).toEqual(["handled", "provider"]);
  });
});

function setup(
  options: {
    readonly phoneScreens?: FakePhoneScreenDriver;
    readonly computerUse?: ComputerUseHandler;
    readonly screenDrivers?: 1;
    readonly stopped?: true;
    readonly info?: (message: string, details?: Readonly<Record<string, unknown>>) => void;
    readonly inspect?: ComputerAppProvider["inspect"];
    readonly invoke?: ComputerAppProvider["invoke"];
  } = {},
) {
  const first = createStream(options.screenDrivers);
  const provider = {
    definitionId: "apple-messages",
    inspect:
      options.inspect ?? (vi.fn(async () => readyInspection()) as ComputerAppProvider["inspect"]),
    invoke: options.invoke ?? vi.fn(async () => ({ ok: true })),
    platforms: ["darwin"],
  } satisfies ComputerAppProvider;
  const handler = new ComputerAppModuleHandler({
    logger: { error: vi.fn(), info: options.info ?? vi.fn() },
    providers: [provider],
    ...(options.stopped ? { stopped: true } : {}),
    ...(options.phoneScreens ? { phoneScreens: options.phoneScreens } : {}),
    ...(options.computerUse ? { computerUse: options.computerUse } : {}),
  });
  handlers.push(handler);
  handler.attach(first.stream);
  return {
    events: first.events,
    handle: async (message: object) =>
      await handler.handleFrame(Buffer.from(JSON.stringify({ ...fence, ...message })), false),
    handler,
    /** Supersedes the attached stream the way a reconnect does. */
    openStream: () => {
      const next = createStream(options.screenDrivers);
      handler.attach(next.stream);
      return next;
    },
    provider: {
      ...provider,
      inspect: vi.mocked(provider.inspect),
      invoke: vi.mocked(provider.invoke),
    },
  };
}

function readyInspection(): readonly ComputerAppOperationInspection[] {
  return definitionOperations.map(({ name }) => ({
    detail: null,
    operation: name,
    remedy: null,
    state: "ready",
  }));
}

function createStream(screenDrivers?: 1): {
  readonly events: IntegrationsModuleEvent[];
  readonly stream: RunnerModuleStream;
} {
  const events: IntegrationsModuleEvent[] = [];
  return {
    events,
    stream: {
      ...(screenDrivers === 1 ? { screenDrivers } : {}),
      browserAttachPublicKeys: undefined,
      fence,
      send: vi.fn(async (frame: Buffer | string) => {
        events.push(IntegrationsModuleEventSchema.parse(JSON.parse(frame.toString())));
      }),
    },
  };
}

type InvokeInput = Omit<HostIntegrationsInvoke, keyof typeof fence | "module">;

function invoke(requestId: string, selected: ComputerAppOperation): InvokeInput {
  return {
    access: "read-write",
    arguments:
      selected.effect === "write"
        ? { text: "Hello", to: { address: "person@example.com" } }
        : { sql: "SELECT 1" },
    contract: computerAppOperationContract(selected),
    definitionId: "apple-messages",
    operation: selected.name,
    requestId: RunnerAuxiliaryRequestIdSchema.parse(requestId),
    timeoutMs: 60_000,
    type: "host.integrations.invoke",
  };
}

function statuses(events: readonly IntegrationsModuleEvent[]) {
  return events.filter((event) => event.type === "runner.integrations.status");
}

function results(events: readonly IntegrationsModuleEvent[]) {
  return events.filter((event) => event.type === "runner.integrations.result");
}

function resultFor(events: readonly IntegrationsModuleEvent[], requestId: string) {
  return results(events).find((event) => event.requestId === requestId);
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/** Lets the microtasks that hand a settled call's slot back run to the end. */
async function flush(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
}

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      if (attempt === 19) throw error;
      await Promise.resolve();
    }
  }
}

const phoneAssignment: DeviceScreenDriverAssignment = {
  deviceId: createId("device"),
  role: "screen",
  definitionId: "iphone-screen",
  generation: 1,
};
const phoneTarget = { deviceId: phoneAssignment.deviceId, driverGeneration: 1 };
function phoneCall(requestId: string, target = phoneTarget): HostIntegrationsComputerUse {
  return HostIntegrationsComputerUseSchema.parse({
    ...fence,
    ...target,
    type: "host.integrations.computer-use",
    definitionId: "iphone-screen",
    requestId,
    runId: createId("run"),
    sessionId: ComputerUseSessionIdSchema.parse("cus_00000000-0000-4000-8000-000000000001"),
    access: null,
    app: null,
    operation: "installed_apps",
    params: {},
    threadTitle: null,
    timeoutMs: 1000,
  });
}
function phoneResults(events: readonly IntegrationsModuleEvent[]) {
  return events.filter((event) => event.type === "runner.integrations.computer-use-result");
}
const assignments = (drivers: readonly DeviceScreenDriverAssignment[]) => ({
  type: "host.integrations.device-drivers",
  drivers,
});

describe("assigned phone screens", () => {
  it.each([true, false])(
    "supplies the production driver only after desktop negotiation: %s",
    async (supported) => {
      const request = vi
        .spyOn(ComputerUseHandler.prototype, "iphoneRequest")
        .mockImplementation(async () => {
          if (!supported) throw new ComputerUseBridgeError("unsupported", "Unavailable.");
          return { targets: [] };
        });
      let prepared: Awaited<ReturnType<typeof prepareIntegrationsModule>>;
      try {
        prepared = await prepareIntegrationsModule({
          platform: "darwin",
          dataDirectory: "/tmp/opensteer-iphone-negotiation-test",
          computerUseBridge: { token: "synthetic", url: new URL("http://127.0.0.1:1") },
        });
        expect(prepared?.descriptor.screenDrivers).toBe(supported ? 1 : undefined);
        if (supported) expect(prepared?.phoneScreens).toBeInstanceOf(IphoneScreenDriver);
        else expect(prepared?.phoneScreens).toBeUndefined();
      } finally {
        await prepared?.close?.();
        request.mockRestore();
      }
    },
  );

  it("accepts assignments and emits per-device status only on a negotiated stream", async () => {
    const screens = new FakePhoneScreenDriver();
    const legacy = setup({ phoneScreens: screens });
    await expect(legacy.handle(assignments([phoneAssignment]))).rejects.toThrow(/negotiat/i);
    await legacy.handle(phoneCall("unnegotiated"));
    expect(screens.connections).toHaveLength(0);
    expect(legacy.events.some((event) => event.type === "runner.integrations.device-status")).toBe(
      false,
    );
    expect(phoneResults(legacy.events)[0]?.result).toMatchObject({
      kind: "error",
      code: "unsupported",
    });
    const absent = setup({ screenDrivers: 1 });
    await expect(absent.handle(assignments([phoneAssignment]))).rejects.toThrow(/negotiat/i);
    const modern = setup({ phoneScreens: screens, screenDrivers: 1 });
    await modern.handle(assignments([phoneAssignment]));
    await vi.waitFor(
      () =>
        expect(
          modern.events.some((event) => event.type === "runner.integrations.device-status"),
        ).toBe(true),
      { timeout: 1000 },
    );
    await screens.connections[0]!.emitStatus(phoneAssignment);
    expect(
      modern.events.filter((event) => event.type === "runner.integrations.device-status"),
    ).toHaveLength(1);
    await modern.handle(phoneCall("assigned"));
    await vi.waitFor(
      () =>
        expect(phoneResults(modern.events)[0]).toMatchObject({
          ...phoneTarget,
          result: { kind: "ok", value: { apps: [], total: 0 } },
        }),
      { timeout: 1000 },
    );
  });

  it("replaces the full list, aborting omitted work and suppressing omitted or stale status", async () => {
    const screens = new FakePhoneScreenDriver();
    const fixture = setup({ phoneScreens: screens, screenDrivers: 1 });
    const other = { ...phoneAssignment, deviceId: createId("device") };
    await fixture.handle(assignments([phoneAssignment, other]));
    const connection = screens.connections[0]!;
    const pending = deferred<{ apps: []; total: number }>();
    connection.installedApps.mockReturnValueOnce(pending.promise);
    await fixture.handle(phoneCall("omitted"));
    const context = connection.installedApps.mock.calls[0]![0];
    await fixture.handle(assignments([other]));
    expect(context.signal.aborted).toBe(true);
    expect(connection.assignments).toEqual([other]);
    const length = fixture.events.length;
    await connection.emitStatus(phoneAssignment);
    expect(fixture.events).toHaveLength(length);
    pending.resolve({ apps: [], total: 0 });
    await fixture.handle(phoneCall("removed"));
    expect(connection.installedApps).toHaveBeenCalledTimes(1);
    expect(
      phoneResults(fixture.events).find((event) => event.requestId === "removed")?.result,
    ).toMatchObject({ kind: "error" });
  });

  it("refuses unknown and stale targets before the port or Mac can have an effect", async () => {
    const screens = new FakePhoneScreenDriver();
    const mac = {
      run: vi.fn(),
      onEvent: vi.fn(),
      onGrantsChanged: vi.fn(),
      onPasswordEvent: vi.fn(),
      negotiateLoginText: vi.fn(),
      releaseSessions: vi.fn(),
      ownerViewVersion: () => undefined,
    } as unknown as ComputerUseHandler;
    const fixture = setup({ phoneScreens: screens, screenDrivers: 1, computerUse: mac });
    await fixture.handle(assignments([{ ...phoneAssignment, generation: 2 }]));
    const connection = screens.connections[0]!;
    await fixture.handle(phoneCall("stale"));
    await fixture.handle(
      phoneCall("unknown", { deviceId: createId("device"), driverGeneration: 1 }),
    );
    expect(phoneResults(fixture.events)).toHaveLength(2);
    expect(phoneResults(fixture.events).every((event) => event.result.kind === "error")).toBe(true);
    expect(connection.installedApps).not.toHaveBeenCalled();
    expect(mac.run).not.toHaveBeenCalled();
    for (const type of ["host.integrations.display.stop", "host.integrations.display.refresh"])
      await fixture.handle({
        ...phoneTarget,
        type,
        display: "main",
        streamId: "dsp_00000000-0000-4000-8000-000000000001",
      });
    expect(connection.display).not.toHaveBeenCalled();
  });

  it("old cancel and close cannot affect the replacement generation or its request id", async () => {
    const screens = new FakePhoneScreenDriver();
    const fixture = setup({ phoneScreens: screens, screenDrivers: 1 });
    await fixture.handle(assignments([phoneAssignment]));
    const connection = screens.connections[0]!;
    const old = deferred<{ apps: []; total: number }>();
    const current = deferred<{ apps: []; total: number }>();
    connection.installedApps.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    await fixture.handle(phoneCall("same"));
    await fixture.handle(assignments([{ ...phoneAssignment, generation: 2 }]));
    await fixture.handle(phoneCall("same", { ...phoneTarget, driverGeneration: 2 }));
    const published = fixture.events.length;
    await connection.emitStatus(phoneAssignment);
    expect(fixture.events).toHaveLength(published);
    const active = connection.installedApps.mock.calls[1]![0];
    await fixture.handle({ ...phoneTarget, requestId: "same", type: "host.integrations.cancel" });
    await fixture.handle({ ...phoneCall("old-close"), operation: "close" });
    expect(active.signal.aborted).toBe(false);
    expect(connection.cancel).not.toHaveBeenCalled();
    expect(connection.close).not.toHaveBeenCalled();
    await fixture.handle({
      ...phoneTarget,
      driverGeneration: 2,
      requestId: "same",
      type: "host.integrations.cancel",
    });
    expect(active.signal.aborted).toBe(true);
    expect(connection.cancel).toHaveBeenCalledOnce();
    old.resolve({ apps: [], total: 0 });
    current.resolve({ apps: [], total: 0 });
    fixture.handler.detach();
    expect(connection.detach).toHaveBeenCalledOnce();
  });

  it("routes canonical operations, Stop acknowledgements, owner views and display controls by tuple", async () => {
    const screens = new FakePhoneScreenDriver();
    const fixture = setup({ phoneScreens: screens, screenDrivers: 1 });
    await fixture.handle(assignments([phoneAssignment]));
    const connection = screens.connections[0]!;
    const base = phoneCall("observe");
    const observation = {
      capturedAt: "2026-10-01T00:00:00Z",
      elementCount: 0,
      foreground: null,
      geometry: { width: 390, height: 844 },
      locked: null,
      secureLock: null,
      observationId: "obs-1",
      rotation: 0 as const,
      screen: "on" as const,
      screenshot: null,
      screenshotUnavailable: "not-requested" as const,
      tree: "",
      truncated: false,
    };
    connection.observe.mockResolvedValue({ observation });
    connection.act.mockResolvedValue({ error: null, observation, performed: [] });
    await fixture.handle({
      ...base,
      access: "read",
      operation: "observe",
      params: { includeScreenshot: false },
    });
    await fixture.handle({
      ...base,
      requestId: "act",
      access: "read-write",
      operation: "act",
      params: {
        includeScreenshot: false,
        observationId: "obs-1",
        actions: [{ type: "launch", appId: "test-app" }],
      },
    });
    await fixture.handle({ ...base, requestId: "close", operation: "close" });
    await vi.waitFor(() => expect(phoneResults(fixture.events)).toHaveLength(3), { timeout: 1000 });
    expect(connection.act.mock.calls[0]?.[1].actions).toEqual([
      { type: "launch", appId: "test-app" },
    ]);
    expect(connection.close.mock.calls[0]?.[0]).toMatchObject(phoneTarget);
    await fixture.handle({
      ...base,
      requestId: "invalid-phone-action",
      access: "read-write",
      operation: "act",
      params: {
        includeScreenshot: false,
        observationId: "obs-1",
        actions: [{ type: "launch", packageName: "com.example.app" }],
      },
    });
    await vi.waitFor(() => expect(phoneResults(fixture.events)).toHaveLength(4), { timeout: 1000 });
    expect(connection.act).toHaveBeenCalledOnce();
    expect(
      phoneResults(fixture.events).find((event) => event.requestId === "invalid-phone-action")
        ?.result,
    ).toMatchObject({ kind: "error", code: "failed" });
    connection.act.mockRejectedValueOnce(new Error("Unclassified native failure"));
    await fixture.handle({
      ...base,
      requestId: "unknown-phone-effect",
      access: "read-write",
      operation: "act",
      params: {
        includeScreenshot: false,
        observationId: "obs-1",
        actions: [{ type: "launch", appId: "test-app" }],
      },
    });
    await vi.waitFor(
      () =>
        expect(
          phoneResults(fixture.events).find((event) => event.requestId === "unknown-phone-effect")
            ?.result,
        ).toMatchObject({ kind: "error", code: "outcome-unknown" }),
      { timeout: 1000 },
    );
    await fixture.handle({
      ...phoneTarget,
      type: "host.integrations.computer-use-stop-recorded",
      sessionId: base.sessionId,
      runId: base.runId,
    });
    expect(connection.stopRecorded.mock.calls[0]?.[0]).toMatchObject(phoneTarget);
    await connection.options.emit({
      ...phoneTarget,
      type: "runner.integrations.computer-use-event",
      event: {
        event: "session.stopped",
        params: { sessionId: base.sessionId, runId: base.runId, reason: "user" },
      },
    });
    expect(
      fixture.events.find((event) => event.type === "runner.integrations.computer-use-event"),
    ).toMatchObject(phoneTarget);
    const view = {
      ...phoneTarget,
      type: "host.integrations.computer-view",
      version: 1,
      viewId: "cvw_00000000-0000-4000-8000-000000000002",
      generation: 7,
      leaseDurationMs: 1000,
      target: { kind: "phone", display: "main" },
      operation: "open",
      requestId: "view",
      timeoutMs: 1000,
    };
    connection.ownerView.mockResolvedValue({
      viewId: view.viewId,
      generation: 7,
      state: "ready",
      captureTargetId: null,
    });
    await fixture.handle(view);
    await vi.waitFor(
      () =>
        expect(
          fixture.events.find((event) => event.type === "runner.integrations.computer-view-result"),
        ).toMatchObject({ ...phoneTarget, result: { kind: "ok" } }),
      { timeout: 1000 },
    );
    const display = { ...phoneTarget, streamId: "dsp_00000000-0000-4000-8000-000000000003" };
    const source = { kind: "task-session", sessionId: base.sessionId };
    const frames = [
      {
        type: "host.integrations.display.start",
        display: "main",
        dataTicket: "aaaa.bbbb.cccc",
        revision: 1,
        sources: [source],
        maxLongSide: 800,
        maxFps: 15,
      },
      { type: "host.integrations.display.demand", display: "main", revision: 2, sources: [source] },
      { type: "host.integrations.display.refresh", display: "main" },
      {
        type: "host.integrations.display.input",
        sessionId: base.sessionId,
        geometry: 1,
        sequence: 1,
        events: [{ kind: "nav", to: "home" }],
      },
      { type: "host.integrations.display.input-reset", sessionId: base.sessionId },
      { type: "host.integrations.display.power", source, sequence: 2, action: "wake" },
      { type: "host.integrations.display.stop", display: "main" },
    ];
    for (const frame of frames) await fixture.handle({ ...display, ...frame });
    expect(
      connection.display.mock.calls.map(([frame]) => ({
        type: frame.type,
        deviceId: frame.deviceId,
        driverGeneration: frame.driverGeneration,
      })),
    ).toEqual(frames.map((frame) => ({ type: frame.type, ...phoneTarget })));
    await fixture.handle(assignments([]));
    await fixture.handle({ ...view, requestId: "old-view" });
    await fixture.handle({
      ...phoneTarget,
      type: "host.integrations.computer-use-stop-recorded",
      sessionId: base.sessionId,
      runId: base.runId,
    });
    expect(connection.ownerView).toHaveBeenCalledOnce();
    expect(connection.stopRecorded).toHaveBeenCalledOnce();
  });

  it("keeps canceled work's capacity across stream replacement", async () => {
    const screens = new FakePhoneScreenDriver();
    const fixture = setup({ phoneScreens: screens, screenDrivers: 1 });
    await fixture.handle(assignments([phoneAssignment]));
    const connection = screens.connections[0]!;
    const pending = Array.from({ length: 4 }, () => deferred<{ apps: []; total: number }>());
    for (const item of pending) connection.installedApps.mockReturnValueOnce(item.promise);
    for (let index = 0; index < 4; index++) {
      await fixture.handle(phoneCall(`held-${index}`));
      await fixture.handle({
        ...phoneTarget,
        type: "host.integrations.cancel",
        requestId: `held-${index}`,
      });
    }
    const next = fixture.openStream();
    await fixture.handle(assignments([phoneAssignment]));
    const current = screens.connections[1]!;
    await fixture.handle(phoneCall("full"));
    expect(current.installedApps).not.toHaveBeenCalled();
    expect(phoneResults(next.events)[0]?.result).toMatchObject({ kind: "error" });
    await connection.options.emit({
      ...phoneTarget,
      type: "runner.integrations.computer-use-event",
      event: {
        event: "session.stopped",
        params: { sessionId: phoneCall("late-event").sessionId, reason: "user" },
      },
    });
    expect(
      next.events.some((event) => event.type === "runner.integrations.computer-use-event"),
    ).toBe(false);
    expect(
      next.events.filter((event) => event.type === "runner.integrations.device-status"),
    ).toHaveLength(1);
    for (const item of pending) item.resolve({ apps: [], total: 0 });
    expect(phoneResults(next.events).some((event) => event.requestId.startsWith("held-"))).toBe(
      false,
    );
  });

  it("preserves untargeted Mac self and Android v4 frames", async () => {
    const run = vi.fn(async () => ({ apps: [], total: 0 }));
    const mac = {
      run,
      onEvent: vi.fn(),
      onGrantsChanged: vi.fn(),
      onPasswordEvent: vi.fn(),
      negotiateLoginText: vi.fn(),
      releaseSessions: vi.fn(),
      ownerViewVersion: () => undefined,
    } as unknown as ComputerUseHandler;
    const fixture = setup({ computerUse: mac });
    const {
      deviceId: _device,
      driverGeneration: _generation,
      definitionId: _definition,
      ...self
    } = phoneCall("mac-self");
    await fixture.handle(self);
    await fixture.handle({ ...self, requestId: "android-v4", definitionId: "android-phone" });
    await vi.waitFor(() => expect(phoneResults(fixture.events)).toHaveLength(2), { timeout: 1000 });
    expect(run).toHaveBeenCalledTimes(2);
    expect(
      phoneResults(fixture.events).every(
        (event) => event.deviceId === undefined && event.driverGeneration === undefined,
      ),
    ).toBe(true);
  });
});
