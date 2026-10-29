import {
  HarnessIdSchema,
  HarnessInstanceIdSchema,
  ThreadAccessModeSchema,
  createId,
  type HarnessInstanceId,
} from "@opensteer/core";
import type { PendingAgentEvent } from "@opensteer/protocol";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import {
  BoundedEventStream,
  EventBufferOverflowError,
  HarnessRegistry,
  LiveSessionDirectory,
  parseGeneratedThreadName,
  threadTitlePrompt,
  harnessRuntimeBoundaryForRunner,
  isolatedServiceHarnessRuntimeBoundary,
  nativeUserHarnessRuntimeBoundary,
  type HarnessAdapter,
  type HarnessCapabilities,
  type HarnessSession,
  type HarnessDurableEventType,
  type HarnessSourceDescriptor,
} from "./index.js";

describe("bounded harness events", () => {
  it("coalesces disposable deltas and keeps must-deliver events", async () => {
    const stream = new BoundedEventStream<string>({ maxBytes: 100, maxItems: 2 });
    expect(stream.publish("old", { coalesceKey: "delta", delivery: "disposable" })).toBe(true);
    expect(stream.publish("new", { coalesceKey: "delta", delivery: "disposable" })).toBe(true);
    expect(stream.publish("done", { delivery: "must-deliver" })).toBe(true);
    expect((await stream[Symbol.asyncIterator]().next()).value).toBe("new");
    expect((await stream[Symbol.asyncIterator]().next()).value).toBe("done");
  });

  it("fails the stream instead of dropping a must-deliver event", () => {
    const stream = new BoundedEventStream<string>({ maxBytes: 10, maxItems: 1 });
    stream.publish("one", { delivery: "must-deliver" });
    expect(() => stream.publish("two", { delivery: "must-deliver" })).toThrow(
      EventBufferOverflowError,
    );
  });

  it("gives every durable event a driver may emit a wire variant the Runner can forward", () => {
    // The Runner parses each durable driver event against PendingAgentEventSchema,
    // so a durable type with no variant there is a Run that fails on its way
    // out; streaming deltas travel as live progress instead. This is the
    // compile-time half; the assertion keeps it a test.
    const forwardable: HarnessDurableEventType extends PendingAgentEvent["type"] ? true : never =
      true;
    expect(forwardable).toBe(true);
  });
});

describe("harness registry", () => {
  it("reports driver readiness and refuses unavailable drivers before adapter creation", async () => {
    const registry = new HarnessRegistry();
    const create = vi.fn(async () => adapter(createId("harnessInstance")));
    registry.registerDriver(
      {
        accessModes: testAccessModes,
        capabilities: testCapabilities,
        configSchema: z.strictObject({}),
        create,
        kind: HarnessIdSchema.parse("disabled"),
        sources: testSources("disabled", "Disabled"),
      },
      { reason: "Provider credential route is not configured", status: "unavailable" },
    );
    expect(registry.listDrivers()).toEqual([
      {
        kind: "disabled",
        readiness: {
          reason: "Provider credential route is not configured",
          status: "unavailable",
        },
      },
    ]);
    expect(registry.canRunDriver(HarnessIdSchema.parse("disabled"))).toBe(false);

    const id = createId("harnessInstance");
    expect(
      registry.configureInstance({
        config: {},
        driverKind: HarnessIdSchema.parse("disabled"),
        id,
        name: "Disabled",
        runtimeRevision: 1,
        sourceId: "disabled",
        stateKind: "isolated",
      }),
    ).toMatchObject({
      reason: "Provider credential route is not configured",
      status: "unavailable",
    });
    await expect(registry.adapter(id)).rejects.toThrow(
      "Provider credential route is not configured",
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps invalid instances visible and fails closed", async () => {
    const registry = new HarnessRegistry();
    registry.registerDriver({
      accessModes: testAccessModes,
      capabilities: testCapabilities,
      configSchema: z.strictObject({ endpoint: z.url() }),
      create: vi.fn(async () => adapter(createId("harnessInstance"))),
      kind: HarnessIdSchema.parse("test"),
      sources: testSources("test", "Test"),
    });
    const id = createId("harnessInstance");
    const state = registry.configureInstance({
      config: { endpoint: "not a URL" },
      driverKind: HarnessIdSchema.parse("test"),
      id,
      name: "Invalid test harness",
      runtimeRevision: 1,
      sourceId: "test",
      stateKind: "isolated",
    });
    expect(state.status).toBe("unavailable");
    await expect(registry.adapter(id)).rejects.toMatchObject({ code: "harness_error" });
  });
});

describe("session generation fencing", () => {
  it("prevents stale cleanup from releasing a successor", () => {
    const directory = new LiveSessionDirectory("boot-1");
    const threadId = createId("thread");
    const instanceId = HarnessInstanceIdSchema.parse(createId("harnessInstance"));
    const first = directory.acquire({
      harnessInstanceId: instanceId,
      session: session(),
      threadId,
    });
    expect(directory.release(first)).toBe(true);
    const second = directory.acquire({
      harnessInstanceId: instanceId,
      session: session(),
      threadId,
    });
    expect(directory.release(first)).toBe(false);
    expect(directory.get(threadId)?.generation).toBe(second.generation);
  });
});

describe("harness runtime boundary", () => {
  it("keeps a lent local Runner native-user on a server Deployment", () => {
    expect(
      harnessRuntimeBoundaryForRunner({ deploymentKind: "server", runnerKind: "local" }),
    ).toEqual(nativeUserHarnessRuntimeBoundary);
  });

  it("isolates the Deployment's own Runners on a server Deployment", () => {
    expect(
      harnessRuntimeBoundaryForRunner({ deploymentKind: "server", runnerKind: "main" }),
    ).toEqual(isolatedServiceHarnessRuntimeBoundary);
    expect(
      harnessRuntimeBoundaryForRunner({ deploymentKind: "server", runnerKind: "managed" }),
    ).toEqual(isolatedServiceHarnessRuntimeBoundary);
  });

  it("keeps every Personal Runner native-user", () => {
    for (const runnerKind of ["main", "local", "managed"] as const) {
      expect(harnessRuntimeBoundaryForRunner({ deploymentKind: "personal", runnerKind })).toEqual(
        nativeUserHarnessRuntimeBoundary,
      );
    }
  });
});

const testAccessModes = ThreadAccessModeSchema.options;

const testCapabilities: HarnessCapabilities = {
  approvals: false,
  attachments: false,
  mcpImageContent: false,
  interruption: true,
  resume: true,
  steering: false,
  toolCalls: false,
  userInput: false,
};

function testSources(sourceId: string, label: string): readonly HarnessSourceDescriptor[] {
  return [
    {
      fields: [],
      kind: "first-party",
      label,
      quota: "none",
      sourceId,
      stateKinds: ["ambient", "isolated"],
    },
  ];
}

function adapter(instanceId: HarnessInstanceId): HarnessAdapter {
  return {
    capabilities: testCapabilities,
    close: async () => undefined,
    instanceId,
    resumeSession: async () => session(),
    startSession: async () => session(),
  };
}

function session(): HarnessSession {
  return {
    events: (async function* () {})(),
    interrupt: async () => undefined,
    providerSessionReference: "session-1",
    resolveRequest: async () => undefined,
    execute: async () => undefined,
    stop: async () => undefined,
  };
}

// Task marks failures 1–3, 24 and revision 2.8: fields settle independently.
describe("Thread naming replies", () => {
  it("requests one title, adding the bounded symbol vocabulary only when negotiated", () => {
    const original = threadTitlePrompt("Plan a trip");
    expect(original).toContain("title alone, on one line");
    expect(original).not.toContain("Line 2");
    const combined = threadTitlePrompt("Plan a trip", { icon: true });
    expect(combined).toContain("Reply with two lines and nothing else");
    expect(combined).toContain("or none");
    expect(combined).toContain("plane");
    expect(combined).toContain("<request>\nPlan a trip\n</request>");
  });

  it.each([
    ["plane\nTokyo flights", { title: "plane", icon: "document" }],
    ["Tokyo flights\nIcon: **PLANE**.", { title: "Tokyo flights", icon: "plane" }],
    ["Tokyo flights\n「Icon: `plane`」.", { title: "Tokyo flights", icon: "plane" }],
    ["Tokyo flights\nSymbol: none.", { title: "Tokyo flights", icon: "document" }],
    ["Tokyo flights\nbogus\nplane", { title: "Tokyo flights", icon: "document" }],
    ["Post-launch support\npl-ane", { title: "Post-launch support", icon: "document" }],
    ["Tokyo flights\nmade-up\nghost", { title: "Tokyo flights", icon: "document" }],
    ["Title: ** **\nplane", { title: null, icon: "plane" }],
    ["Title: ** **\ninvalid", { title: null, icon: "document" }],
    ["Tokyo flights", { title: "Tokyo flights", icon: "document" }],
    ["", { title: null }],
    [" \r\n ", { title: null }],
    ["Title: ** **", { title: null, icon: "document" }],
    ["\r\nTitle: ‘東京への航空券’\r\nIcon: PLANE\r\n", { title: "東京への航空券", icon: "plane" }],
  ])("parses independent name fields from %j", (reply, expected) => {
    expect(parseGeneratedThreadName(reply, { icon: true })).toEqual(expected);
  });

  it("never emits an icon without negotiation", () => {
    expect(parseGeneratedThreadName("Title: ** **\nplane")).toEqual({ title: null });
    expect(parseGeneratedThreadName("Tokyo flights\nplane")).toEqual({ title: "Tokyo flights" });
  });

  it("bounds multilingual titles without cutting a surrogate pair or consuming the icon", () => {
    const reply = `${"한中".repeat(38)}😀😀旅行計画\r\nicon: plane`;
    const parsed = parseGeneratedThreadName(reply, { icon: true });
    expect(parsed.title?.length).toBeLessThanOrEqual(80);
    expect(parsed.title?.isWellFormed()).toBe(true);
    expect(parsed.title).toMatch(/…$/u);
    expect(parsed.icon).toBe("plane");
  });
});
