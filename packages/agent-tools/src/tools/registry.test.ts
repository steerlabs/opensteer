import { randomUUID } from "node:crypto";
import { createId } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import {
  agentTools,
  computer,
  delegate_task,
  pending_request,
  thread_wait,
  thread_configure,
  environment_list,
  orchestrator_capabilities,
  thread_read,
  thread_list,
  thread_send,
} from "./index.js";
import { sign_in } from "./browser.js";
import { person_message } from "./person.js";
import { trigger_read, trigger_write } from "./triggers.js";

describe("Opensteer tool registry", () => {
  it("has one specification per product and integration tool", () => {
    expect(agentTools).toHaveLength(49);
    expect(new Set(agentTools.map(({ name }) => name)).size).toBe(49);
    const runs = agentTools.filter((t) => t.callers.some((c) => c === "run")).map((t) => t.name);
    expect(runs).toContain("integration_call");
    expect(runs).toEqual(
      expect.arrayContaining([
        "delegate_task",
        "thread_send",
        "thread_wait",
        "pending_request",
        "device_access_request",
        "orchestrator_capabilities",
      ]),
    );
    for (const old of [
      "thread_delegate",
      "thread_message",
      "request_list",
      "browser_session_open",
      "browser_tab_read",
    ])
      expect(runs).not.toContain(old);
    const programs = agentTools
      .filter((t) => t.callers.some((c) => c === "program"))
      .map((t) => t.name);
    expect(programs).toContain("delegate_task");
    expect(programs).not.toContain("person_show");
    expect(programs).not.toContain("computer");
  });
  it("exposes bounded waiting and connection work without human-only controls", () => {
    const connections = agentTools.filter((t) => t.callers.some((c) => c === "connection"));
    for (const name of [
      "delegate_task",
      "thread_send",
      "thread_wait",
      "thread_configure",
      "thread_queue",
    ])
      expect(connections.map((t) => t.name)).toContain(name);
    const wait = agentTools.find((t) => t.name === "thread_wait");
    expect(
      wait?.input.safeParse({
        threadId: "thr_11111111-1111-4111-8111-111111111111",
        timeoutMs: 100001,
      }).success,
    ).toBe(false);
  });
  it("strips an unnamed secret from a tool result", () => {
    expect(
      person_message.output.parse({
        messageId: "msg_11111111-1111-4111-8111-111111111111",
        surpriseSecret: "never leave the Host",
      }),
    ).not.toHaveProperty("surpriseSecret");
  });
  it("refuses task placement, ambiguous waits and unobserved Request answers", () => {
    expect(
      delegate_task.input.safeParse({ task: "Inspect", environmentId: "env_any" }).success,
    ).toBe(false);
    expect(thread_wait.input.safeParse({}).success).toBe(false);
    expect(
      thread_wait.input.safeParse({
        threadId: "thr_11111111-1111-4111-8111-111111111111",
        assignmentId: "dlg_11111111-1111-4111-8111-111111111111",
      }).success,
    ).toBe(false);
    expect(pending_request.input.safeParse({ action: "read" }).success).toBe(false);
    expect(pending_request.input.safeParse({ action: "respond" }).success).toBe(false);
    expect(
      pending_request.input.safeParse({
        action: "respond",
        requestId: "req_11111111-1111-4111-8111-111111111111",
        expectedRevision: "seen",
        response: { kind: "form", answers: { answer: ["42"] } },
      }).success,
    ).toBe(true);
  });
  it("strips wait metadata and refuses access-mode changes through configure", () => {
    expect(
      thread_wait.output.parse({
        hasMore: false,
        status: "running",
        items: [],
        token: "secret",
        run: {
          id: "run_11111111-1111-4111-8111-111111111111",
          status: "running",
          token: "secret",
        },
      }),
    ).toEqual({
      hasMore: false,
      status: "running",
      items: [],
      run: { id: "run_11111111-1111-4111-8111-111111111111", status: "running" },
    });
    expect(
      thread_configure.input.safeParse({
        threadId: "thr_11111111-1111-4111-8111-111111111111",
        accessMode: "full-access",
      }).success,
    ).toBe(false);
  });
  it("retains safe Trigger details and cancellation receipts", () => {
    const detail = {
      activation: null,
      anchorThreadTitle: "Anchor",
      createdByThreadTitle: null,
      downstreamRuns: [],
      downstreamRunsTruncated: false,
      canceledOccurrenceIds: ["toc_11111111-1111-4111-8111-111111111111"],
    };
    expect(trigger_write.output.parse({ ...detail, unnamedSecret: "hidden" })).toEqual(detail);
  });
  it("preserves the image detail hint while stripping unnamed metadata", () => {
    const image = {
      type: "image",
      data: "aW1hZ2U=",
      mimeType: "image/png",
      _meta: { "codex/imageDetail": "original" },
    };
    expect(
      computer.output.parse({
        content: [
          {
            ...image,
            surpriseSecret: "hidden",
            _meta: { ...image._meta, surpriseSecret: "hidden" },
          },
        ],
      }),
    ).toEqual({ content: [image] });
  });
  it("returns a ready sign-in's login reference, which grants nothing without the Run's authority", () => {
    const ready = {
      status: "ready",
      site: "https://example.com",
      loginRef: `lgn_${"1".repeat(32)}`,
      account: "a•••@example.com",
    };
    expect(sign_in.output.parse({ ...ready, password: "hidden" })).toEqual(ready);
  });
  it("returns webhook setup credentials on writes and excludes them from reads", () => {
    const result = {
      webhook: { secret: "oswh_private", url: "https://example.test/private" },
    };
    expect(trigger_write.output.parse(result)).toEqual(result);
    expect(trigger_read.output.parse(result)).toEqual({});
  });
});

const agentToolPayloadMaxSerializedBytes = 432 * 1024;

it("fits largest catalog and single-message tool pages but rejects an oversized combined page", () => {
  const requestId = randomUUID();
  const harnessIds = Array.from({ length: 64 }, () => createId("harnessInstance"));
  const environments = Array.from({ length: 64 }, (_, index) => ({
    capabilities: ["filesystem", "shell", "browser"],
    connected: true,
    id: createId("environment"),
    kind: index === 0 ? ("main" as const) : ("local" as const),
    name: "e".repeat(120),
    can: { executeTasks: index === 0 },
  }));
  const threads = Array.from({ length: 100 }, () => {
    const id = createId("thread");
    return {
      accessMode: "full-access" as const,
      continuationIdentity: null,
      createdAt: new Date().toISOString(),
      createdBy: createId("user"),
      environmentId: createId("environment"),
      harnessInstanceId: harnessIds[0],
      id,
      inputQueuePaused: false,
      lineageRootThreadId: id,
      modelSelection: {
        modelId: "gpt-5.6-sol",
        options: { effort: "low" },
        providerId: "openai",
      },
      listed: true,
      parentThreadId: null,
      pendingRequests: 0,
      purpose: "task" as const,
      teamOrigin: null,
      status: "idle" as const,
      title: "t".repeat(240),
      updatedAt: new Date().toISOString(),
    };
  });
  // Every model a discovery page may show, each at its longest names.
  const longestModel = (index: number) => ({
    modelId: `${index}`.padEnd(255, "m"),
    providerId: `p${index}`.padEnd(100, "p"),
  });
  const catalog = orchestrator_capabilities.output.parse({
    accessCeiling: "full-access",
    limits: {
      maxDepth: 4,
      remainingDepth: 4,
      maxTasks: 32,
      remainingTasks: 32,
      maxAutonomousRuns: 64,
      remainingAutonomousRuns: 64,
      maxWaitMs: 100_000,
      taskDeadlineAt: null,
    },
    delegationDefault: {
      environmentId: environments[0]!.id,
      harnessInstanceId: harnessIds[0],
      model: {
        ...longestModel(0),
        options: Object.fromEntries(
          Array.from({ length: 16 }, (_, option) => [`o${option}`.padEnd(100, "o"), true]),
        ),
      },
    },
    harnesses: harnessIds.map((id, index) => ({
      driverKind: "d".repeat(100),
      enabled: true,
      environmentId: environments[index % environments.length]!.id,
      id,
      models:
        index < 5 ? Array.from({ length: 8 }, (_, model) => longestModel(index * 8 + model)) : [],
      modelsOmitted: index < 5 ? 8_184 : 0,
      status: "ready",
      name: "h".repeat(120),
    })),
    requestId,
  });
  expect(Buffer.byteLength(JSON.stringify(catalog), "utf8")).toBeLessThanOrEqual(
    agentToolPayloadMaxSerializedBytes,
  );
  expect(
    Buffer.byteLength(JSON.stringify(environment_list.output.parse({ environments })), "utf8"),
  ).toBeLessThanOrEqual(agentToolPayloadMaxSerializedBytes);

  const threadId = createId("thread");
  const thread = { ...threads[0], id: threadId };
  const largeItem = {
    itemId: createId("message"),
    type: "message",
    status: "published",
    runId: createId("run"),
    title: null,
    text: "m".repeat(256 * 1_024),
    textTruncated: false,
    nextTextOffset: null,
    createdAt: new Date().toISOString(),
  };
  const readPage = {
    items: [largeItem],
    recentRuns: [],
    recentPlaces: [],
    hasMore: false,
    nextBefore: null,
    thread,
  };
  expect(thread_read.output.safeParse(readPage).success).toBe(true);
  const oversized = thread_read.output.safeParse({
    ...readPage,
    items: [largeItem, { ...largeItem, itemId: createId("message") }],
  });
  expect(oversized.error?.issues.map(({ message }) => message)).toEqual([
    "Thread history exceeds the agent output byte limit",
  ]);
});

it("fits a full Thread listing page and requires explicit agent message delivery", () => {
  const listing = thread_list.output.parse({
    threads: Array.from({ length: 50 }, () => ({
      assignmentId: createId("delegation"),
      taskStatus: "open" as const,
      environmentConnected: true,
      environmentId: createId("environment"),
      id: createId("thread"),
      parentThreadId: createId("thread"),
      pendingRequests: 2,
      status: "running" as const,
      title: "t".repeat(240),
      updatedAt: new Date().toISOString(),
    })),
    hasMore: true,
    nextBefore: "cursor",
  });
  expect(Buffer.byteLength(JSON.stringify(listing), "utf8")).toBeLessThanOrEqual(
    agentToolPayloadMaxSerializedBytes,
  );
  expect(
    thread_list.output.safeParse({
      ...listing,
      threads: [...listing.threads, listing],
    }).success,
  ).toBe(false);

  const untitled = thread_send.input.parse({
    message: "Status?",
    delivery: "queue",
    threadId: createId("thread"),
  });
  expect(untitled).toMatchObject({ delivery: "queue" });
  expect(thread_send.input.parse({ ...untitled, freshContext: true }).freshContext).toBe(true);
  for (const delivery of ["report", "steer"] as const)
    expect(thread_send.input.safeParse({ ...untitled, delivery, freshContext: true }).success).toBe(
      false,
    );
  expect(
    thread_send.input.safeParse({
      message: "Status?",
      threadId: createId("thread"),
    }).success,
  ).toBe(false);
  for (const delivery of ["turn", "notify"] as const) {
    expect(
      thread_send.input.safeParse({
        message: "Status?",
        delivery,
        threadId: createId("thread"),
      }).success,
    ).toBe(false);
  }
  expect(thread_list.input.parse({ limit: 50 })).toMatchObject({ limit: 50 });
  expect(thread_list.input.parse({})).toMatchObject({
    limit: 25,
  });
  expect(thread_list.input.safeParse({ limit: 51 }).success).toBe(false);
});
