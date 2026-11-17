import { TeamChannelSummarySchema, TeamKnowledgeWriteResultSchema } from "@opensteer/protocol";
import { randomUUID } from "node:crypto";
import { createId } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import {
  agentTools,
  AgentTeamChannelSummarySchema,
  opensteer_knowledge_save,
  computer_use,
  opensteer_task_delegate,
  opensteer_request_answer,
  opensteer_task_wait,
  opensteer_task_configure,
  computer_list,
  opensteer_ai_account_list,
  opensteer_task_read,
  opensteer_task_list,
  opensteer_task_send,
} from "./index.js";
import { saved_login_request } from "./browser.js";
import { send_to_person } from "./person.js";
import { opensteer_automation_list, opensteer_automation_create } from "./triggers.js";

describe("Opensteer tool registry", () => {
  it("has one specification per product tool", () => {
    expect(new Set(agentTools.map(({ name }) => name)).size).toBe(agentTools.length);
    const runs = agentTools.filter((t) => t.callers.some((c) => c === "run")).map((t) => t.name);
    expect(runs).toEqual(
      expect.arrayContaining([
        "opensteer_task_delegate",
        "opensteer_task_send",
        "opensteer_task_wait",
        "opensteer_request_answer",
        "computer_access_request",
        "opensteer_ai_account_list",
      ]),
    );
    for (const old of [
      "thread_delegate",
      "thread_message",
      "request_list",
      "sign_in",
      "browser_session_list",
      "browser_session_close",
      "browser_tab_write",
      "browser_session_open",
      "browser_tab_read",
    ])
      expect(runs).not.toContain(old);
    const programs = agentTools
      .filter((t) => t.callers.some((c) => c === "program"))
      .map((t) => t.name);
    expect(programs).toContain("opensteer_task_delegate");
    expect(programs).not.toContain("show_to_person");
    expect(programs).not.toContain("computer_use");
  });
  it("exposes bounded waiting and connection work without human-only controls", () => {
    const connections = agentTools.filter((t) => t.callers.some((c) => c === "connection"));
    for (const name of [
      "opensteer_task_create",
      "opensteer_task_send",
      "opensteer_task_wait",
      "opensteer_task_configure",
      "opensteer_task_queue",
    ])
      expect(connections.map((t) => t.name)).toContain(name);
    const wait = agentTools.find((t) => t.name === "opensteer_task_wait");
    expect(
      wait?.input.safeParse({
        taskId: "thr_11111111-1111-4111-8111-111111111111",
        timeoutMs: 100001,
      }).success,
    ).toBe(false);
  });
  it("strips an unnamed secret from a tool result", () => {
    expect(
      send_to_person.output.parse({
        messageId: "msg_11111111-1111-4111-8111-111111111111",
        surpriseSecret: "never leave the Host",
      }),
    ).not.toHaveProperty("surpriseSecret");
  });
  it("refuses task placement, ambiguous waits and unobserved Request answers", () => {
    expect(
      opensteer_task_delegate.input.safeParse({ task: "Inspect", environmentId: "env_any" })
        .success,
    ).toBe(false);
    expect(opensteer_task_wait.input.safeParse({}).success).toBe(false);
    expect(
      opensteer_task_wait.input.safeParse({
        taskId: "thr_11111111-1111-4111-8111-111111111111",
        delegationId: "dlg_11111111-1111-4111-8111-111111111111",
      }).success,
    ).toBe(false);
    expect(opensteer_request_answer.input.safeParse({ action: "read" }).success).toBe(false);
    expect(opensteer_request_answer.input.safeParse({ action: "respond" }).success).toBe(false);
    expect(
      opensteer_request_answer.input.safeParse({
        requestId: "req_11111111-1111-4111-8111-111111111111",
        expectedRevision: "seen",
        response: { kind: "form", answers: { answer: ["42"] } },
      }).success,
    ).toBe(true);
  });
  it("strips wait metadata and refuses access-mode changes through configure", () => {
    expect(
      opensteer_task_wait.output.parse({
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
      opensteer_task_configure.input.safeParse({
        taskId: "thr_11111111-1111-4111-8111-111111111111",
        accessMode: "full-access",
      }).success,
    ).toBe(false);
  });
  it("retains safe Trigger details and cancellation receipts", () => {
    const detail = {
      activation: null,
      taskTitle: "Anchor",
      createdByTaskTitle: null,
      downstreamRuns: [],
      downstreamRunsTruncated: false,
      canceledOccurrenceIds: ["toc_11111111-1111-4111-8111-111111111111"],
    };
    expect(
      opensteer_automation_create.output.parse({ ...detail, unnamedSecret: "hidden" }),
    ).toEqual(detail);
  });
  it("preserves the image detail hint while stripping unnamed metadata", () => {
    const image = {
      type: "image",
      data: "aW1hZ2U=",
      mimeType: "image/png",
      _meta: { "codex/imageDetail": "original" },
    };
    expect(
      computer_use.output.parse({
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
  it("returns a ready login reference and drops any other field, such as a saved value", () => {
    const ready = {
      status: "ready",
      site: "https://example.com",
      loginRef: `lgn_${"1".repeat(32)}`,
      account: "a•••@example.com",
    };
    expect(saved_login_request.output.parse({ ...ready, password: "hidden" })).toEqual(ready);
  });
  it("returns webhook setup credentials on writes and excludes them from reads", () => {
    const result = {
      webhook: { secret: "oswh_private", url: "https://example.test/private" },
    };
    expect(opensteer_automation_create.output.parse(result)).toEqual(result);
    expect(opensteer_automation_list.output.parse(result)).toEqual({});
  });
});

const agentToolPayloadMaxSerializedBytes = 432 * 1024;

it("fits largest catalog and single-message tool pages but rejects an oversized combined page", () => {
  const requestId = randomUUID();
  const harnessIds = Array.from({ length: 64 }, () => createId("harnessInstance"));
  const tasks = Array.from({ length: 100 }, () => {
    const id = createId("thread");
    return {
      accessMode: "full-access" as const,
      continuationIdentity: null,
      createdAt: new Date().toISOString(),
      createdBy: createId("user"),
      environmentId: createId("environment"),
      aiAccountId: harnessIds[0],
      id,
      inputQueuePaused: false,
      lineageRootThreadId: id,
      modelSelection: {
        modelId: "gpt-5.6-sol",
        options: { effort: "low" },
        providerId: "openai",
      },
      listed: true,
      parentTaskId: null,
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
  const computerId = createId("runner");
  const catalog = opensteer_ai_account_list.output.parse({
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
      aiAccountId: harnessIds[0],
      model: {
        ...longestModel(0),
        options: Object.fromEntries(
          Array.from({ length: 16 }, (_, option) => [`o${option}`.padEnd(100, "o"), true]),
        ),
      },
    },
    accounts: harnessIds.map((aiAccountId, index) => ({
      aiAccountId,
      computerId,
      name: "h".repeat(120),
      engine: "d".repeat(100),
      enabled: true,
      isDefault: index === 0,
      status: "ready",
      models:
        index < 5 ? Array.from({ length: 8 }, (_, model) => longestModel(index * 8 + model)) : [],
      modelsOmitted: index < 5 ? 8_184 : 0,
    })),
    nextCursor: harnessIds[63],
    requestId,
  });
  expect(Buffer.byteLength(JSON.stringify(catalog), "utf8")).toBeLessThanOrEqual(
    agentToolPayloadMaxSerializedBytes,
  );
  const computers = Array.from({ length: 100 }, () => ({
    computerId: createId("runner"),
    name: "e".repeat(120),
    kind: "agent-phone",
    online: true,
    hosting: false,
    canRunTasks: false,
    capabilities: ["filesystem", "shell", "browser"],
    revoked: false,
    access: { browser: "enabled", apps: "enabled", files: "enabled" },
    sessions: [{ id: createId("authSession") }],
    phoneDisplay: {
      definitionId: "iphone-screen",
      control: { state: "unavailable", reason: { kind: "driver-update-required" } },
      input: { state: "unavailable", reason: { kind: "driver-update-required" } },
      navigationButtons: Array.from({ length: 32 }, (_, index) => ({
        id: `button-${index}`.padEnd(64, "x"),
        label: "l".repeat(120),
      })),
      actions: ["tap", "longPress", "swipe", "drag", "type", "clear", "navigate", "launch"],
      setup: { location: "driver-mac", driverRunnerName: "m".repeat(120) },
    },
  }));
  expect(
    Buffer.byteLength(
      JSON.stringify(computer_list.output.parse({ computers, nextCursor: null })),
      "utf8",
    ),
  ).toBeLessThanOrEqual(agentToolPayloadMaxSerializedBytes);

  const taskId = createId("thread");
  const thread = { ...tasks[0], id: taskId };
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
    nextCursor: null,
    task: thread,
  };
  expect(opensteer_task_read.output.safeParse(readPage).success).toBe(true);
  const oversized = opensteer_task_read.output.safeParse({
    ...readPage,
    items: [largeItem, { ...largeItem, itemId: createId("message") }],
  });
  expect(oversized.error?.issues.map(({ message }) => message)).toEqual([
    "Task history exceeds the agent output byte limit",
  ]);
});

it("fits a full Thread listing page and requires explicit agent message delivery", () => {
  const listing = opensteer_task_list.output.parse({
    tasks: Array.from({ length: 50 }, () => ({
      delegationId: createId("delegation"),
      taskStatus: "open" as const,
      environmentConnected: true,
      environmentId: createId("environment"),
      id: createId("thread"),
      parentTaskId: createId("thread"),
      pendingRequests: 2,
      status: "running" as const,
      title: "t".repeat(240),
      updatedAt: new Date().toISOString(),
    })),
    hasMore: true,
    nextCursor: "cursor",
  });
  expect(Buffer.byteLength(JSON.stringify(listing), "utf8")).toBeLessThanOrEqual(
    agentToolPayloadMaxSerializedBytes,
  );
  expect(
    opensteer_task_list.output.safeParse({
      ...listing,
      tasks: [...listing.tasks, listing],
    }).success,
  ).toBe(false);

  const untitled = opensteer_task_send.input.parse({
    message: "Status?",
    delivery: "queue",
    taskId: createId("thread"),
  });
  expect(untitled).toMatchObject({ delivery: "queue" });
  expect(opensteer_task_send.input.parse({ ...untitled, freshContext: true }).freshContext).toBe(
    true,
  );
  for (const delivery of ["report", "steer"] as const)
    expect(
      opensteer_task_send.input.safeParse({ ...untitled, delivery, freshContext: true }).success,
    ).toBe(false);
  expect(
    opensteer_task_send.input.safeParse({
      message: "Status?",
      taskId: createId("thread"),
    }).success,
  ).toBe(false);
  for (const delivery of ["turn", "notify"] as const) {
    expect(
      opensteer_task_send.input.safeParse({
        message: "Status?",
        delivery,
        taskId: createId("thread"),
      }).success,
    ).toBe(false);
  }
  expect(opensteer_task_list.input.parse({ limit: 50 })).toMatchObject({ limit: 50 });
  expect(opensteer_task_list.input.parse({})).toMatchObject({
    limit: 25,
  });
  expect(opensteer_task_list.input.safeParse({ limit: 51 }).success).toBe(false);
});

it("retains links in strict agent projections without widening canonical team records", () => {
  const link = "[channel](https://team.example/c/example)";
  const channel = {
    id: createId("teamChannel"),
    kind: "public",
    name: "general",
    peopleOnly: false,
    archivedAt: null,
    changeSeq: "1",
    latestMessageId: null,
    can: { read: true, post: true, manage: true, join: false, leave: true, wakeOwnAgent: true },
    link,
  };
  expect(AgentTeamChannelSummarySchema.parse(channel)).toEqual(channel);
  expect(TeamChannelSummarySchema.safeParse(channel).success).toBe(false);
  const conflict = {
    written: false,
    current: {
      id: createId("knowledgeNote"),
      topicId: createId("knowledgeTopic"),
      version: 1,
      title: "Note",
      body: "Body",
      deleted: false,
      writtenAt: new Date(0).toISOString(),
      writer: { kind: "human", userId: createId("user"), name: "Person" },
      source: null,
      link,
    },
  };
  expect(opensteer_knowledge_save.output.parse(conflict)).toEqual(conflict);
  expect(TeamKnowledgeWriteResultSchema.safeParse(conflict).success).toBe(false);
});
