import { messageItem } from "../mcp/thread-items.js";
import type { AgentTriggerManager } from "../mcp/handlers/triggers.js";
import { mcpToolCallId } from "../integrations/mcp-call-id.js";
import { fingerprint } from "../mcp/operations.js";
import { ProductToolRequestSchema } from "../mcp/product-tools.test-support.js";
import { ProductToolsTestClient } from "../mcp/product-tools.test-support.js";
import { SpecialistStore } from "@opensteer/database";
import {
  AssignmentSummarySchema,
  createId,
  ModelSelectionSchema,
  OpensteerError,
  PendingRequestSchema,
  type EnvironmentId,
  type HarnessInstanceId,
  type Message,
  type Run,
  type Thread,
  type ThreadInput,
} from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import type { CommandService } from "@opensteer/orchestration";
import {
  createBrowserSessionId,
  HarnessInstanceCatalogSchema,
  type HarnessInstanceCatalog,
} from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import type { BrowserService } from "../browser/browser-service.js";
import { type RunToolTokenService } from "./run-tool-tokens.js";
vi.mock("@opensteer/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@opensteer/database")>()),
  readAgentThreadRecent: async () => ({
    runs: [],
    places: [],
  }),
}));
const now = "2026-08-09T09:00:00.000Z";
const ownerId = createId("user");
const runnerId = createId("runner");
const environmentId = createId("environment");
const targetEnvironmentId = createId("environment");
const currentThreadId = createId("thread");
const targetThreadId = createId("thread");
const nativeHarnessId = createId("harnessInstance");
const codexHarnessId = createId("harnessInstance");
const targetNativeHarnessId = createId("harnessInstance");
const targetCodexHarnessId = createId("harnessInstance");
const testModelSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: {
    effort: "low",
  },
  providerId: "openai",
});
describe("Product tool handlers", () => {
  it("refuses a specialist that is being removed", async () => {
    const current = thread(currentThreadId, nativeHarnessId, "Owner task");
    const delegateThread = vi.fn();
    const { service } = makeService({
      threads: [current],
      messages: [],
      commands: {
        delegateThread,
        enqueueThreadInput: vi.fn(),
      },
    });
    const listing = vi.spyOn(SpecialistStore.prototype, "list").mockResolvedValue([
      {
        id: "removing-specialist",
        pluginId: "plugin",
        pluginVersionId: "version",
        ownerUserId: ownerId,
        ownerName: "Alice",
        canUse: false,
        plugin: "invoices",
        version: "a".repeat(64),
        status: "removing",
        models: [
          {
            role: "light",
          },
        ],
        fallback: "none",
        access: [],
      },
    ]);
    const runnable = vi.spyOn(SpecialistStore.prototype, "assertRunnable").mockRejectedValue(
      new OpensteerError({
        code: "conflict",
        message: "Specialist is removing",
      }),
    );
    try {
      await expect(
        service.handle("run-token", {
          type: "thread.delegate",
          requestId: crypto.randomUUID(),
          specialist: "invoices",
          task: "Read invoices",
        }),
      ).rejects.toThrow("Specialist is removing");
      expect(delegateThread).not.toHaveBeenCalled();
    } finally {
      listing.mockRestore();
      runnable.mockRestore();
    }
  });
  it("continues an existing specialist Thread on its own model, never re-resolving its manifest", async () => {
    const current = thread(currentThreadId, nativeHarnessId, "Owner task");
    const existing = thread(targetThreadId, codexHarnessId, "Invoices", null, {
      specialistId: "ready-specialist",
    });
    const existingRun = run(existing);
    const existingMessage = message(existing.id, existingRun.id, "Next batch");
    const delegateThread = vi.fn(async () => ({
      assignment: {
        id: createId("delegation"),
      },
      input: inboxInput(existingMessage, existingRun, "queue"),
      message: existingMessage,
      run: existingRun,
      thread: existing,
      wasDuplicate: false,
    }));
    const { service } = makeService({
      threads: [current, existing],
      messages: [],
      commands: {
        delegateThread,
        enqueueThreadInput: vi.fn(),
      },
    });
    const listing = vi.spyOn(SpecialistStore.prototype, "list").mockResolvedValue([
      {
        id: "ready-specialist",
        pluginId: "plugin",
        pluginVersionId: "version",
        ownerUserId: ownerId,
        ownerName: "Alice",
        canUse: true,
        plugin: "invoices",
        version: "a".repeat(64),
        status: "ready",
        models: [
          {
            role: "light",
          },
        ],
        fallback: "none",
        access: [],
      },
    ]);
    const runnable = vi
      .spyOn(SpecialistStore.prototype, "assertRunnable")
      .mockResolvedValue(undefined as never);
    try {
      await service.handle("run-token", {
        type: "thread.delegate",
        requestId: crypto.randomUUID(),
        threadId: existing.id,
        task: "Next batch",
      });
      expect(delegateThread).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: existing.id,
          specialistId: "ready-specialist",
          harnessInstanceId: existing.harnessInstanceId,
          modelSelection: existing.modelSelection,
        }),
      );
    } finally {
      listing.mockRestore();
      runnable.mockRestore();
    }
  });
  it("lists the Requests visible to the current task", async () => {
    const current = thread(currentThreadId, nativeHarnessId, "Owner task", null, {});
    const pending = pendingRequest();
    const visiblePage = vi.fn(async () => ({
      requests: [pending],
      window: {
        byteCount: 1,
        hasMore: true,
        itemCount: 1,
        nextBefore: "next_request_page",
        totalItems: 2,
      },
    }));
    const { service, claims } = makeService({
      commands: {
        delegateThread: vi.fn(),
        enqueueThreadInput: vi.fn(),
      },
      messages: [],
      requests: {
        visiblePage,
      },
      threads: [current],
    });
    await expect(
      service.handle("run-token", {
        before: "current_request_page",
        limit: 1,
        requestId: crypto.randomUUID(),
        type: "request.list",
      }),
    ).resolves.toMatchObject({
      requests: [
        {
          id: pending.id,
          status: "pending",
        },
      ],
      type: "request.list.result",
      window: {
        hasMore: true,
        nextBefore: "next_request_page",
      },
    });
    expect(visiblePage).toHaveBeenCalledWith({
      before: "current_request_page",
      limit: 1,
      originatingThreadId: claims.threadId,
    });
  });
  it("keeps settlement sessions out of the Requests it lists", async () => {
    const current = thread(currentThreadId, nativeHarnessId, "Owner task");
    const pending = {
      ...pendingRequest(),
      settlementProvenance: {
        sessionId: "PRIVATE-SETTLEMENT-SESSION",
        deviceLabel: "iPhone",
      },
    };
    const visiblePage = vi.fn(async () => ({
      requests: [pending],
      window: {
        byteCount: 1,
        hasMore: true,
        itemCount: 1,
        nextBefore: "next_request_page",
        totalItems: 2,
      },
    }));
    const { service, claims } = makeService({
      commands: {
        delegateThread: vi.fn(),
        enqueueThreadInput: vi.fn(),
      },
      messages: [],
      requests: {
        visiblePage,
      },
      threads: [current],
    });
    const response = await service.handle("run-token", {
      before: "current_request_page",
      limit: 1,
      requestId: crypto.randomUUID(),
      type: "request.list",
    });
    expect(JSON.stringify(response)).not.toContain("PRIVATE-SETTLEMENT-SESSION");
    expect(response).toMatchObject({
      requests: [
        {
          id: pending.id,
          status: "pending",
          settlementProvenance: {
            deviceLabel: "iPhone",
          },
        },
      ],
      type: "request.list.result",
      window: {
        hasMore: true,
        nextBefore: "next_request_page",
      },
    });
    expect(visiblePage).toHaveBeenCalledWith({
      before: "current_request_page",
      limit: 1,
      originatingThreadId: claims.threadId,
    });
  });
  it.each(["sign-in"] as const)(
    "keeps %s Browser Session requests admitted through the single sign-in permission",
    async (type) => {
      const current = thread(currentThreadId, nativeHarnessId, "Worker");
      const result = {
        status: "unavailable",
        site: "https://example.com",
        reason: "no-saved-login",
      } as const;
      const agentSignIn = vi.fn(async () => result);
      const { service, admitRunToolCall } = makeService({
        browserSources: {
          agentSignIn,
          agentUseCard: async () => {
            throw new Error("Unexpected card use");
          },
        },
        commands: {
          delegateThread: vi.fn(),
          enqueueThreadInput: vi.fn(),
        },
        messages: [],
        threads: [current],
      });
      const sessionId = createBrowserSessionId();
      const requestId = crypto.randomUUID();
      await expect(
        service.handle("run-token", {
          requestId,
          type,
          sessionId,
          site: result.site,
          reason: "Read the account",
        }),
      ).resolves.toEqual({
        requestId,
        type: `${type}.result`,
        // On the result, because a long-lived session keeps the skill it read first.
        result: {
          ...result,
          guidance: expect.stringContaining("call sign_in again"),
        },
      });
      expect(agentSignIn).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId,
          site: result.site,
        }),
      );
      expect(admitRunToolCall).not.toHaveBeenCalled();
    },
  );

  it("coordinates durable child and target turns through typed task history", async () => {
    const current = {
      ...thread(currentThreadId, nativeHarnessId, "Owner task"),
      accessMode: "auto" as const,
    };
    const target = thread(targetThreadId, codexHarnessId, "Research", null, {
      accessMode: "auto",
      environmentId: targetEnvironmentId,
    });
    const targetMessage = message(target.id, null, "Existing research");
    const child = {
      ...thread(createId("thread"), nativeHarnessId, "Contract research", current.id, {}),
      accessMode: current.accessMode,
    };
    const childRun = run(child);
    const childMessage = message(child.id, childRun.id, "Delegated task");
    const targetRun = run(target);
    const forwardedMessage = message(target.id, targetRun.id, "Please continue");
    const delegateThread = vi.fn(async () => ({
      assignment: {
        id: createId("delegation"),
      },
      input: inboxInput(childMessage, childRun, "queue"),
      message: childMessage,
      run: childRun,
      thread: child,
      wasDuplicate: false,
    }));
    const enqueueThreadInput = vi.fn(async () => ({
      disposition: "run-queued" as const,
      input: inboxInput(forwardedMessage, targetRun, "queue"),
      message: forwardedMessage,
      run: targetRun,
      wasDuplicate: false,
    }));
    const { service, authenticate, claims } = makeService({
      commands: {
        delegateThread,
        enqueueThreadInput,
      },
      environments: [environmentId, targetEnvironmentId],
      messages: [targetMessage],
      targetEnvironmentHarnesses,
      threads: [current, target],
    });
    const readId = crypto.randomUUID();
    await expect(
      service.handle("run-token", {
        limit: 10,
        requestId: readId,
        threadId: target.id,
        type: "thread.read",
      }),
    ).resolves.toMatchObject({
      items: [messageItem(targetMessage, 20_000)],
      thread: {
        id: target.id,
      },
    });
    const delegateId = crypto.randomUUID();
    const delegateRequest = ProductToolRequestSchema.parse({
      requestId: delegateId,
      task: "Research the provider contract",
      title: child.title,
      type: "thread.delegate",
    });
    if (delegateRequest.type !== "thread.delegate") throw new Error("Expected delegation");
    await expect(service.handle("run-token", delegateRequest)).resolves.toMatchObject({
      result: {
        runId: childRun.id,
        threadId: child.id,
      },
    });
    expect(delegateThread).toHaveBeenCalledWith({
      accessMode: "auto",
      callerIntent: {
        requestId: mcpToolCallId(`run:${claims.runId}`, delegateId, "operation", "delegate_task"),
        requestFingerprint: fingerprint({
          mode: delegateRequest.mode,
          timeoutMs: delegateRequest.timeoutMs,
          task: delegateRequest.task,
          title: delegateRequest.title,
        }),
      },
      createdBy: ownerId,
      environmentId,
      harnessInstanceId: nativeHarnessId,
      idempotencyKey: expect.stringContaining(
        `${mcpToolCallId(`run:${claims.runId}`, delegateId, "operation", "delegate_task")}:delegate`,
      ),
      modelSelection: testModelSelection,
      origin: {
        kind: "run",
        parentRunId: claims.runId,
        parentThreadId: currentThreadId,
      },
      task: [
        {
          text: "Research the provider contract",
          type: "text",
        },
      ],
      title: child.title,
      titleSource: "chosen",
    });
    const messageId = crypto.randomUUID();
    await expect(
      service.handle("run-token", {
        content: [
          {
            text: "Please continue",
            type: "text",
          },
        ],
        delivery: "queue",
        requestId: messageId,
        threadId: target.id,
        type: "thread.message",
      }),
    ).resolves.toMatchObject({
      result: {
        runId: targetRun.id,
        messageId: forwardedMessage.id,
      },
    });
    expect(enqueueThreadInput).toHaveBeenCalledWith({
      content: [
        {
          text: "Please continue",
          type: "text",
        },
      ],
      idempotencyKey: expect.stringContaining(
        `${mcpToolCallId(`run:${claims.runId}`, messageId, "operation", "thread_send")}:message`,
      ),
      policy: "queue",
      requestedBy: ownerId,
      source: {
        kind: "agent",
        runId: claims.runId,
      },
      threadId: target.id,
    });
    expect(authenticate).toHaveBeenCalledTimes(3);
    expect(authenticate).toHaveBeenCalledWith("run-token");
  });

  it("refuses by name when a selected model is unavailable on the hosting computer", async () => {
    const current = thread(currentThreadId, nativeHarnessId, "Owner task", null, {});
    const delegateThread = vi.fn();
    const { service } = makeService({
      commands: {
        delegateThread,
        enqueueThreadInput: vi.fn(),
      },
      environments: [environmentId, targetEnvironmentId],
      harnessCatalog: readyCatalog([
        {
          isDefault: false,
          modelId: "gpt-5.6-mini",
        },
        {
          isDefault: true,
          modelId: "gpt-5.6-codex",
        },
      ]),
      messages: [],
      targetEnvironmentHarnesses,
      threads: [current],
    });
    await expect(
      service.handle("run-token", {
        requestId: crypto.randomUUID(),
        task: "Do work",
        model: testModelSelection,
        type: "thread.delegate",
      }),
    ).rejects.toMatchObject({
      code: "bad_request",
      message: expect.stringContaining("openai/gpt-5.6-mini, openai/gpt-5.6-codex"),
    });
    expect(delegateThread).not.toHaveBeenCalled();
  });
  it("reports an uninspected engine on the hosting computer before creating work", async () => {
    const current = thread(currentThreadId, nativeHarnessId, "Owner task");
    const delegateThread = vi.fn();
    const { service } = makeService({
      commands: { delegateThread, enqueueThreadInput: vi.fn() },
      harnessCatalog: null,
      messages: [],
      threads: [current],
    });
    await expect(
      service.handle("run-token", {
        requestId: crypto.randomUUID(),
        task: "Do work",
        type: "thread.delegate",
        model: testModelSelection,
      }),
    ).rejects.toThrow("has not reported the models it can run");
    expect(delegateThread).not.toHaveBeenCalled();
  });
  it("rejects self-messaging, foreign-owner Threads, and disabled harness delegation", async () => {
    const current = thread(currentThreadId, nativeHarnessId, "Owner task");
    const target = thread(targetThreadId, codexHarnessId, "Research");
    const foreignOwnerId = createId("user");
    const foreign = thread(createId("thread"), codexHarnessId, "Foreign", null, {
      createdBy: foreignOwnerId,
    });
    const { service } = makeService({
      commands: {
        delegateThread: vi.fn(),
        enqueueThreadInput: vi.fn(),
      },
      disabledHarnessId: nativeHarnessId,
      messages: [],
      threads: [current, target, foreign],
    });
    await expect(
      service.handle("run-token", {
        content: [
          {
            text: "loop",
            type: "text",
          },
        ],
        delivery: "queue",
        requestId: crypto.randomUUID(),
        threadId: current.id,
        type: "thread.message",
      }),
    ).rejects.toThrow("cannot message its own active Thread");
    await expect(
      service.handle("run-token", {
        limit: 10,
        requestId: crypto.randomUUID(),
        threadId: foreign.id,
        type: "thread.read",
      }),
    ).rejects.toThrow("unavailable");
    await expect(
      service.handle("run-token", {
        content: [
          {
            text: "exfiltrate",
            type: "text",
          },
        ],
        delivery: "queue",
        requestId: crypto.randomUUID(),
        threadId: foreign.id,
        type: "thread.message",
      }),
    ).rejects.toThrow("unavailable");
    await expect(
      service.handle("run-token", {
        requestId: crypto.randomUUID(),
        task: "Do not run",
        title: "Disabled",
        type: "thread.delegate",
      }),
    ).rejects.toThrow("disabled or unavailable");
  });
  it("does not create a delegated Thread when its pinned environment lacks the driver", async () => {
    const current = thread(currentThreadId, nativeHarnessId, "Owner task");
    const delegateThread = vi.fn();
    const enqueueThreadInput = vi.fn();
    const { service } = makeService({
      commands: {
        delegateThread,
        enqueueThreadInput,
      },
      messages: [],
      threads: [current],
      unavailableHarnessId: nativeHarnessId,
    });
    await expect(
      service.handle("run-token", {
        requestId: crypto.randomUUID(),
        task: "Do not schedule this",
        title: "Unavailable driver",
        type: "thread.delegate",
      }),
    ).rejects.toThrow("cannot run harness driver native");
    expect(delegateThread).not.toHaveBeenCalled();
    expect(enqueueThreadInput).not.toHaveBeenCalled();
  });
  it("replays an exact durable delegation before rechecking placement", async () => {
    const current = thread(currentThreadId, nativeHarnessId, "Owner task");
    const child = thread(createId("thread"), nativeHarnessId, "Existing child", current.id, {});
    const childRun = run(child);
    const childMessage = message(child.id, childRun.id, "Existing task");
    const delegateThread = vi.fn();
    const enqueueThreadInput = vi.fn();
    const requestId = crypto.randomUUID();
    const { service } = makeService({
      commands: {
        delegateThread,
        enqueueThreadInput,
      },
      disconnectedEnvironmentId: environmentId,
      environments: [environmentId, targetEnvironmentId],
      existingDelegation: {
        assignment: {
          id: createId("delegation"),
        },
        input: inboxInput(childMessage, childRun, "queue"),
        message: childMessage,
        run: childRun,
        thread: child,
      },
      messages: [],
      threads: [current, child],
    });
    await expect(
      service.handle("run-token", {
        requestId,
        task: "Existing task",
        title: child.title,
        type: "thread.delegate",
      }),
    ).resolves.toMatchObject({
      result: {
        runId: childRun.id,
        threadId: child.id,
      },
    });
    expect(delegateThread).not.toHaveBeenCalled();
    expect(enqueueThreadInput).not.toHaveBeenCalled();
  });

  it("carries a chosen browser machine through and refuses one this user cannot reach", async () => {
    const current = thread(currentThreadId, nativeHarnessId, "Owner task", null, {});
    const freshSummary = {
      access: "read-write" as const,
      activeAttachmentCount: 1,
      attached: true,
      createdAt: now,
      id: createBrowserSessionId(),
      origin: "agent" as const,
      placement: {
        kind: "runner" as const,
        runnerId: createId("runner"),
      },
      profileId: null,
      profileName: null,
      runtimeId: "hosted-browser-1",
      state: "ready" as const,
      updatedAt: now,
    };
    const openAgentSession = vi.fn(async () => ({
      session: freshSummary,
      wasExisting: false,
    }));
    const { service } = makeService({
      browser: {
        openAgentSession,
      },
      commands: {
        delegateThread: vi.fn(),
        enqueueThreadInput: vi.fn(),
      },
      environments: [environmentId, targetEnvironmentId],
      messages: [],
      threads: [current],
    });
    await expect(
      service.handle("run-token", {
        environmentId: targetEnvironmentId,
        fresh: true,
        requestId: crypto.randomUUID(),
        type: "browser.session.open",
      }),
    ).resolves.toMatchObject({
      type: "browser.session.open.result",
    });
    expect(openAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        chosenEnvironmentId: targetEnvironmentId,
        // The Run's own machine still travels, so an unnamed session keeps
        // landing next to the agent.
        environmentId,
        fresh: true,
      }),
    );
    await expect(
      service.handle("run-token", {
        environmentId: createId("environment"),
        fresh: true,
        requestId: crypto.randomUUID(),
        type: "browser.session.open",
      }),
    ).rejects.toMatchObject({
      code: "bad_request",
      message: expect.stringContaining("not exist"),
    });
    const { service: unreachable } = makeService({
      browser: {
        openAgentSession: vi.fn(),
      },
      commands: {
        delegateThread: vi.fn(),
        enqueueThreadInput: vi.fn(),
      },
      environments: [environmentId, targetEnvironmentId],
      foreignEnvironmentId: targetEnvironmentId,
      messages: [],
      threads: [current],
    });
    await expect(
      unreachable.handle("run-token", {
        environmentId: targetEnvironmentId,
        fresh: true,
        requestId: crypto.randomUUID(),
        type: "browser.session.open",
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
  });
  it("admits full access requests from %s before calling the service", async () => {
    const current = thread(currentThreadId, nativeHarnessId, "Client", null, {});
    const request = vi.fn(async () => ({
      kind: "machine.full-disk-access" as const,
      replayed: false,
      requestId: createId("request"),
      status: "pending" as const,
    }));
    const { claims, service, admitRunToolCall } = makeService({
      machineFullDiskAccess: {
        request,
      },
      commands: {
        delegateThread: vi.fn(),
        enqueueThreadInput: vi.fn(),
      },
      messages: [],
      threads: [current],
    });
    const callId = crypto.randomUUID();
    expect(
      await service.handle("run-token", {
        type: "machine.full-disk-access.request",
        requestId: callId,
        computer: "test-mac",
        reason: "Read Mail",
      }),
    ).toMatchObject({
      type: "machine.full-disk-access.request.result",
    });
    expect(request).toHaveBeenCalledWith({
      callId: mcpToolCallId(
        `run:${claims.runId}`,
        callId,
        "operation",
        "machine_full_disk_access_request",
      ),
      computer: "test-mac",
      reason: "Read Mail",
      claims,
    });
    expect(admitRunToolCall).not.toHaveBeenCalled();
  });

  it("uses Run-stable command idempotency after durable exact-request admission", async () => {
    const current = thread(currentThreadId, nativeHarnessId, "Owner task");
    const target = thread(targetThreadId, codexHarnessId, "Research");
    const targetRun = run(target);
    const forwardedMessage = message(target.id, targetRun.id, "Please continue");
    const enqueueThreadInput = vi.fn(async (_input: { readonly idempotencyKey: string }) => ({
      disposition: "run-queued" as const,
      input: inboxInput(forwardedMessage, targetRun, "queue"),
      message: forwardedMessage,
      run: targetRun,
      wasDuplicate: true,
    }));
    const { admitRunToolCall, claims, service } = makeService({
      commands: {
        delegateThread: vi.fn(),
        enqueueThreadInput,
      },
      messages: [],
      threads: [current, target],
    });
    const requestId = crypto.randomUUID();
    const request = {
      content: [
        {
          text: "Please continue",
          type: "text" as const,
        },
      ],
      delivery: "queue" as const,
      requestId,
      threadId: target.id,
      type: "thread.message" as const,
    };
    await service.handle("first-token", request);
    await service.handle("replacement-token", request);
    expect(admitRunToolCall).toHaveBeenCalledTimes(2);
    expect(admitRunToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "thread.message",
        requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        requestId: mcpToolCallId(`run:${claims.runId}`, requestId, "operation", "thread_send"),
        runId: claims.runId,
        sourceThreadId: claims.threadId,
      }),
    );
    expect(enqueueThreadInput).toHaveBeenCalledTimes(2);
    const firstKey = enqueueThreadInput.mock.calls[0]?.[0].idempotencyKey;
    expect(firstKey).toBe(
      `run:${claims.runId}:${mcpToolCallId(`run:${claims.runId}`, requestId, "operation", "thread_send")}:message`,
    );
    expect(enqueueThreadInput.mock.calls[1]?.[0].idempotencyKey).toBe(firstKey);
    expect(firstKey).not.toContain(claims.jti);
  });
  it("does not execute an agent mutation when durable admission rejects it", async () => {
    const current = thread(currentThreadId, nativeHarnessId, "Owner task");
    const target = thread(targetThreadId, codexHarnessId, "Research");
    const enqueueThreadInput = vi.fn();
    const admitRunToolCall = vi.fn(async () => {
      throw new OpensteerError({
        code: "conflict",
        message: "Agent-control thread.message request limit reached",
      });
    });
    const { service } = makeService({
      admitRunToolCall,
      commands: {
        delegateThread: vi.fn(),
        enqueueThreadInput,
      },
      messages: [],
      threads: [current, target],
    });
    await expect(
      service.handle("run-token", {
        content: [
          {
            text: "Please continue",
            type: "text",
          },
        ],
        delivery: "queue",
        requestId: crypto.randomUUID(),
        threadId: target.id,
        type: "thread.message",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    expect(enqueueThreadInput).not.toHaveBeenCalled();
  });
  it("admits each split Trigger tool under its own action class", async () => {
    const current = thread(currentThreadId, nativeHarnessId, "Owner task", null, {});
    const manage = vi.fn(async () => ({
      triggers: [],
    }));
    const { admitRunToolCall, service } = makeService({
      commands: {
        delegateThread: vi.fn(),
        enqueueThreadInput: vi.fn(),
      },
      messages: [],
      threads: [current],
      triggers: {
        manage,
      },
    });
    await expect(
      service.handle("run-token", {
        input: {
          limit: 10,
          operation: "list",
        },
        requestId: crypto.randomUUID(),
        tool: "trigger.read",
        type: "trigger.control",
      }),
    ).resolves.toMatchObject({
      result: {
        triggers: [],
      },
      type: "trigger.control.result",
    });
    await service.handle("run-token", {
      input: {
        operation: "run",
        triggerId: createId("trigger"),
      },
      requestId: crypto.randomUUID(),
      tool: "trigger.write",
      type: "trigger.control",
    });
    expect(
      (
        manage.mock.calls as unknown as readonly [
          unknown,
          {
            operation: string;
          },
        ][]
      ).map(([, input]) => input.operation),
    ).toEqual(["list", "run"]);
    expect(admitRunToolCall).not.toHaveBeenCalled();
  });
  it("derives the Trigger create idempotency key from the Run and request", async () => {
    const current = thread(currentThreadId, nativeHarnessId, "Owner task", null, {});
    const manage = vi.fn(async () => ({}));
    const { claims, service } = makeService({
      commands: {
        delegateThread: vi.fn(),
        enqueueThreadInput: vi.fn(),
      },
      messages: [],
      threads: [current],
      triggers: {
        manage,
      },
    });
    const requestId = crypto.randomUUID();
    await service.handle("run-token", {
      input: {
        anchorThreadId: current.id,
        idempotencyKey: requestId,
        name: "Nightly report",
        operation: "create",
        program: {
          toolContractVersion: 3,
          language: "javascript",
          source: "export default () => {}",
        },
        source: {
          kind: "webhook",
        },
      },
      requestId,
      tool: "trigger.write",
      type: "trigger.control",
    });
    expect(manage).toHaveBeenCalledWith(
      claims.requestedBy,
      expect.objectContaining({
        idempotencyKey: `run:${claims.runId}:${mcpToolCallId(`run:${claims.runId}`, requestId, "operation", "trigger_write")}:trigger.create`,
      }),
      current.id,
      expect.objectContaining({
        operationKey: expect.any(String),
      }),
    );
  });
  it.each([
    ["task", {}],
    [
      "specialist",
      {
        specialistId: "invoices",
      },
    ],
  ] as const)("allows Trigger tools for a %s task", async (_place, consent) => {
    const current = thread(currentThreadId, nativeHarnessId, "Owner task", null, consent);
    const manage = vi.fn(async () => ({}));
    const { service } = makeService({
      commands: {
        delegateThread: vi.fn(),
        enqueueThreadInput: vi.fn(),
      },
      messages: [],
      threads: [current],
      triggers: {
        manage,
      },
    });
    await expect(
      service.handle("run-token", {
        input: {
          limit: 10,
          operation: "list",
        },
        requestId: crypto.randomUUID(),
        tool: "trigger.read",
        type: "trigger.control",
      }),
    ).resolves.toMatchObject({
      type: "trigger.control.result",
    });
    expect(manage).toHaveBeenCalledWith(
      ownerId,
      {
        limit: 10,
        operation: "list",
      },
      current.id,
      {
        accessMode: current.accessMode,
      },
    );
  });
});
function makeService(options: {
  personShow?: ConstructorParameters<typeof ProductToolsTestClient>[0]["personShow"];
  browserSources?: ConstructorParameters<typeof ProductToolsTestClient>[0]["browserSources"];
  machineFullDiskAccess?: ConstructorParameters<
    typeof ProductToolsTestClient
  >[0]["machineFullDiskAccess"];
  admitRunToolCall?: ReturnType<typeof vi.fn>;
  browser?: Partial<
    Pick<
      BrowserService,
      | "createProfile"
      | "closeAgentSession"
      | "listAgentSessions"
      | "listAgentProfiles"
      | "openAgentSession"
      | "requestAccess"
    >
  >;
  runAssignment?: {
    readonly assignerThreadId: Thread["id"];
    readonly open: boolean;
  };
  runnerCapabilities?: readonly string[];
  commands: {
    publishPersonMessage?: ReturnType<typeof vi.fn>;
    delegateThread: ReturnType<typeof vi.fn>;
    enqueueThreadInput: ReturnType<typeof vi.fn>;
  };
  disconnectedEnvironmentId?: EnvironmentId;
  disabledHarnessId?: HarnessInstanceId;
  environments?: readonly EnvironmentId[];
  existingDelegation?: {
    assignment: {
      id: string;
    };
    readonly input: ThreadInput;
    readonly message: Message;
    readonly run: Run;
    readonly thread: Thread;
  };
  foreignEnvironmentId?: EnvironmentId;
  harnessCatalog?: HarnessInstanceCatalog | null;
  messages: readonly Message[];
  listHarnessInstances?: OpensteerStore["listHarnessInstances"];
  requests?: {
    visiblePage?: OpensteerStore["requests"]["visiblePage"];
    withdraw?: OpensteerStore["requests"]["withdraw"];
  };
  targetEnvironmentHarnesses?: readonly {
    readonly driverKind: string;
    readonly enabled: boolean;
    readonly id: HarnessInstanceId;
    readonly isDefault: boolean;
    readonly name: string;
    /** Defaults to the one source the engine of that kind declares here. */
    readonly sourceId?: string;
  }[];
  threads: readonly Thread[];
  triggers?: AgentTriggerManager;
  unavailableHarnessId?: HarnessInstanceId;
}) {
  const claims = {
    aud: "opensteer-run-tools" as const,
    bindingGeneration: 1,
    environmentId,
    exp: Math.floor(Date.now() / 1_000) + 60,
    iat: Math.floor(Date.now() / 1_000),
    iss: "opensteer-host" as const,
    jti: crypto.randomUUID(),
    requestedBy: ownerId,
    runId: createId("run"),
    runnerBootId: "boot-1",
    runnerId,
    threadId: currentThreadId,
  };
  const authenticate = vi.fn(async () => claims);
  const environments = options.environments ?? [environmentId];
  const admitRunToolCall =
    options.admitRunToolCall ??
    vi.fn(async () => ({
      actionClass: "thread.message" as const,
      delegationDepth: null,
      lineageRootThreadId: null,
      wasDuplicate: false,
    }));
  const listEnvironmentsForUser = vi.fn(async () =>
    environments.map((id) => ({
      capabilities: ["filesystem"] as const,
      id,
      kind: id === environmentId ? ("main" as const) : ("local" as const),
      name: id === environmentId ? "Main Runner" : "Local Runner",
      runnerId,
    })),
  );
  const lineageIds = (threadId: Thread["id"]): readonly Thread["id"][] => {
    const byThreadId = new Map(options.threads.map((candidate) => [candidate.id, candidate]));
    let root = byThreadId.get(threadId);
    while (root?.parentThreadId && byThreadId.has(root.parentThreadId)) {
      root = byThreadId.get(root.parentThreadId);
    }
    const lineage = new Set<Thread["id"]>(root ? [root.id] : [threadId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const candidate of options.threads) {
        if (candidate.parentThreadId && lineage.has(candidate.parentThreadId)) {
          changed = lineage.has(candidate.id) ? changed : true;
          lineage.add(candidate.id);
        }
      }
    }
    lineage.add(threadId);
    return [...lineage];
  };
  const agentThreadPageForOwner = vi.fn(
    async (input: {
      maxItems?: number;
      ownerId: typeof ownerId;
      query?: string;
      scope: { kind: string; threadId?: Thread["id"] };
      parentThreadId?: Thread["id"];
    }) => {
      const lineage = input.scope.threadId ? lineageIds(input.scope.threadId) : null;
      const visible = options.threads
        .filter((candidate) => candidate.createdBy === input.ownerId)
        .filter((candidate) => !lineage || lineage.includes(candidate.id))
        .filter(
          (candidate) => !input.parentThreadId || candidate.parentThreadId === input.parentThreadId,
        )
        .filter(
          (candidate) =>
            !input.query || candidate.title.toLowerCase().includes(input.query.toLowerCase()),
        )
        .map((candidate) => ({
          assignmentId: null,
          taskStatus: null,
          environmentId: candidate.environmentId,
          id: candidate.id,
          parentThreadId: candidate.parentThreadId,
          pendingRequests: candidate.pendingRequests,
          status: candidate.status,
          title: candidate.title,
          updatedAt: candidate.updatedAt,
        }));
      const threads = visible.slice(0, input.maxItems ?? 25);
      return {
        threads,
        window: {
          byteCount: Buffer.byteLength(JSON.stringify(threads), "utf8"),
          hasMore: visible.length > threads.length,
          itemCount: threads.length,
          nextBefore: visible.length > threads.length ? "test_cursor" : null,
          totalItems: visible.length,
        },
      };
    },
  );
  function summarized(result: NonNullable<typeof options.existingDelegation>) {
    return {
      ...result,
      assignment: AssignmentSummarySchema.parse({
        id: result.assignment.id,
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
        currentRunId: result.run.id,
        currentRunStatus: result.run.status,
        initialRunId: result.run.id,
        modelLabel: null,
        objectivePreview: "Task",
        origin: "run",
        parentThreadId: currentThreadId,
        resultPreview: null,
        returnStatus: "pending",
        revision: 1,
        status: "open",
        workerThread: result.thread,
      }),
    };
  }
  const store = {
    getThreadInputQueue: async () => ({
      paused: false,
      items: [],
    }),
    listThreadAssignmentsForOwner: async () => ({
      assignments: [],
      window: {
        byteCount: 0,
        hasMore: false,
        itemCount: 0,
        nextBefore: null,
        totalItems: 0,
      },
    }),
    admitRunToolCall,
    getAssignmentForOwner: async () => ({
      resultText: null,
    }),
    runAssignment: vi.fn(async () => options.runAssignment ?? null),
    agentThreadLineage: vi.fn(async (threadId: Thread["id"]) => lineageIds(threadId)),
    agentThreadPageForOwner,
    runnerCapabilities: async () => options.runnerCapabilities ?? [],
    environmentIsAvailableToUser: vi.fn(
      async (id: EnvironmentId) => environments.includes(id) && id !== options.foreignEnvironmentId,
    ),
    findDelegatedThreadByIdempotency: vi.fn(async () =>
      options.existingDelegation ? summarized(options.existingDelegation) : null,
    ),
    getEnvironment: async (id: EnvironmentId) => {
      if (!environments.includes(id)) return null;
      return {
        capabilities: ["filesystem"],
        id,
        kind: id === environmentId ? ("main" as const) : ("local" as const),
        name: id === environmentId ? "Main Runner" : "Local Runner",
        runnerId,
      };
    },
    getHarnessInstance: async (id: HarnessInstanceId) => {
      const native = id === nativeHarnessId || id === targetNativeHarnessId;
      const onTarget = id === targetNativeHarnessId || id === targetCodexHarnessId;
      return {
        config: {},
        createdAt: now,
        driverKind: native ? "native" : "codex",
        enabled: id !== options.disabledHarnessId,
        environmentId: onTarget ? targetEnvironmentId : environmentId,
        id,
        name: native ? "Opensteer" : "Codex",
        sourceId: native ? "native" : "openai",
      };
    },
    getThreadForOwner: async (id: Thread["id"], requestedBy: typeof ownerId) => {
      const value = options.threads.find((candidate) => candidate.id === id);
      return value?.createdBy === requestedBy ? value : null;
    },
    listEnvironmentsForUser,
    getHarnessCatalog: async () =>
      options.harnessCatalog === undefined ? readyCatalog() : options.harnessCatalog,
    listHarnessCatalogs: async () => [],
    listHarnessInstances:
      options.listHarnessInstances ??
      (async (input?: { environmentIds?: readonly EnvironmentId[] }) => {
        const rows = [
          {
            config: {},
            createdAt: now,
            driverKind: "native",
            enabled: options.disabledHarnessId !== nativeHarnessId,
            environmentId,
            id: nativeHarnessId,
            isDefault: options.disabledHarnessId !== nativeHarnessId,
            name: "Opensteer",
            sourceId: "native",
          },
          {
            config: {},
            createdAt: now,
            driverKind: "codex",
            enabled: options.disabledHarnessId !== codexHarnessId,
            environmentId,
            id: codexHarnessId,
            isDefault: options.disabledHarnessId !== codexHarnessId,
            name: "Codex",
            sourceId: "openai",
          },
          ...(options.targetEnvironmentHarnesses ?? []).map((harness) => ({
            config: {},
            createdAt: now,
            environmentId: targetEnvironmentId,
            sourceId: harness.driverKind === "codex" ? "openai" : harness.driverKind,
            ...harness,
          })),
        ];
        const wanted = input?.environmentIds;
        return wanted ? rows.filter((row) => wanted.includes(row.environmentId)) : rows;
      }),
    listThreadsForOwner: async (requestedBy: typeof ownerId) =>
      options.threads.filter((candidate) => candidate.createdBy === requestedBy),
    ownerThreadPageForOwner: async (input: { maxItems: number; ownerId: typeof ownerId }) => {
      const values = options.threads
        .filter((candidate) => candidate.createdBy === input.ownerId)
        .slice(0, input.maxItems);
      return {
        threads: values,
        window: {
          byteCount: Buffer.byteLength(JSON.stringify(values), "utf8"),
          hasMore: false,
          itemCount: values.length,
          nextBefore: null,
          totalItems: values.length,
        },
      };
    },
    requests: {
      visiblePage:
        options.requests?.visiblePage ??
        vi.fn(async () => {
          throw new Error("Unexpected Request listing");
        }),
      withdraw:
        options.requests?.withdraw ??
        vi.fn(async () => {
          throw new Error("Unexpected Request withdrawal");
        }),
    },
    threadMessagePageForOwner: async (input: {
      maxItems: number;
      ownerId: typeof ownerId;
      threadId: Thread["id"];
    }) => {
      const value = options.threads.find((candidate) => candidate.id === input.threadId);
      if (!value) return null;
      const allMessages = options.messages.filter(
        (candidate) => candidate.threadId === input.threadId,
      );
      const messages = allMessages.slice(-input.maxItems);
      return {
        messages,
        threadId: input.threadId,
        window: {
          byteCount: Buffer.byteLength(JSON.stringify(messages), "utf8"),
          hasMore: allMessages.length > messages.length,
          itemCount: messages.length,
          nextBefore: allMessages.length > messages.length ? "test_cursor" : null,
          threadId: input.threadId,
          totalItems: allMessages.length,
        },
      };
    },
  } as unknown as OpensteerStore;
  store.listAgentHarnessInstancesForUser = vi.fn(async (_requestedBy, input = {}) => {
    const visible = await listEnvironmentsForUser();
    const rows = await store.listHarnessInstances({
      environmentIds: visible.map(({ id }) => id),
    });
    return rows
      .filter((row) => row.enabled && row.removedAt == null)
      .filter((row) => input.id === undefined || row.id === input.id)
      .filter((row) => input.afterId === undefined || row.id > input.afterId)
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, input.limit ?? 65);
  });
  const tokens = {
    authenticate,
  } as unknown as RunToolTokenService;
  const unexpectedBrowserRequest = async () => {
    throw new Error("Unexpected browser request");
  };
  const commands = {
    publishPersonMessage: options.commands.publishPersonMessage,
    withInputAdmission: async <T>(_owner: string, _key: string, operation: () => Promise<T>) =>
      operation(),
    delegateAdmittedThread: async (
      operation: Parameters<CommandService["delegateAdmittedThread"]>[0],
    ) => {
      await (admitRunToolCall as (input: unknown) => Promise<unknown>)(operation.admission.request);
      return summarized(
        (await (
          options.commands.delegateThread as (
            input: unknown,
          ) => Promise<NonNullable<typeof options.existingDelegation>>
        )(operation.input)) as NonNullable<typeof options.existingDelegation>,
      );
    },
    enqueueAdmittedThreadInput: async (
      operation: Parameters<CommandService["enqueueAdmittedThreadInput"]>[0],
    ) => {
      await (admitRunToolCall as (input: unknown) => Promise<unknown>)(operation.admission.request);
      return (options.commands.enqueueThreadInput as (input: unknown) => Promise<unknown>)(
        operation.input,
      ) as ReturnType<CommandService["enqueueAdmittedThreadInput"]>;
    },
  } as unknown as CommandService;
  return {
    admitRunToolCall,
    agentThreadPageForOwner,
    authenticate,
    claims,
    listEnvironmentsForUser,
    service: new ProductToolsTestClient({
      ...(options.personShow
        ? {
            personShow: options.personShow,
          }
        : {}),
      browserSources: options.browserSources ?? {
        agentSignIn: unexpectedBrowserRequest,
        agentUseCard: unexpectedBrowserRequest,
      },
      machineFullDiskAccess: options.machineFullDiskAccess ?? {
        request: vi.fn(),
      },
      browser: {
        createProfile: options.browser?.createProfile ?? unexpectedBrowserRequest,
        closeAgentSession: options.browser?.closeAgentSession ?? unexpectedBrowserRequest,
        readablePlaces: async (_owner, references) => [...references],
        drainRunPlaces: async () => undefined,
        listAgentSessions: options.browser?.listAgentSessions ?? unexpectedBrowserRequest,
        listAgentProfiles: options.browser?.listAgentProfiles ?? unexpectedBrowserRequest,
        openAgentSession: options.browser?.openAgentSession ?? unexpectedBrowserRequest,
        requestAccess: options.browser?.requestAccess ?? unexpectedBrowserRequest,
      },
      canRunHarness: (_environment, driverKind) =>
        options.unavailableHarnessId === undefined ||
        driverKind !== (options.unavailableHarnessId === nativeHarnessId ? "native" : "codex"),
      commands,
      isEnvironmentConnected: (id) =>
        environments.includes(id) && id !== options.disconnectedEnvironmentId,
      store,
      tokens,
      ...(options.triggers === undefined
        ? {}
        : {
            triggers: options.triggers,
          }),
      execution: {
        environmentFor: async (owner) => {
          if (owner !== ownerId)
            throw new OpensteerError({ code: "forbidden", message: "Personal owner required" });
          return environmentId;
        },
        canExecute: (id) => id === environmentId,
      },
    }),
  };
}
function pendingRequest() {
  return PendingRequestSchema.parse({
    callId: crypto.randomUUID(),
    cancellationReason: null,
    createdAt: now,
    id: createId("request"),
    kind: "browser.access",
    mode: "durable",
    originatingOccurrenceId: null,
    originatingRunId: createId("run"),
    originatingThreadId: currentThreadId,
    payload: {
      kind: "browser.access",
      reason: "Use the signed-in client portal",
      suggestion: {
        kind: "user_choice",
      },
    },
    presentation: {
      kind: "external",
      subject: {
        id: currentThreadId,
        kind: "thread",
      },
      title: "Browser profile access",
    },
    requestedBy: ownerId,
    requiredActor: "requester",
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    status: "pending",
  });
}

/**
 * What the second environment has installed. A test that delegates across
 * environments states this, because the engine the child runs on comes from the
 * target machine's own profiles and never from the parent Thread's.
 */
const targetEnvironmentHarnesses = [
  {
    driverKind: "native",
    enabled: true,
    id: targetNativeHarnessId,
    isDefault: true,
    name: "Opensteer",
  },
  {
    driverKind: "codex",
    enabled: true,
    id: targetCodexHarnessId,
    isDefault: true,
    name: "Codex",
  },
];

/**
 * The catalog a target environment's engine reports. `models` decides whether a
 * cross-environment delegation can carry the parent Thread's model across.
 */
function readyCatalog(
  models: readonly {
    readonly isDefault: boolean;
    readonly modelId: string;
  }[] = [
    {
      isDefault: true,
      modelId: "gpt-5.6-sol",
    },
  ],
): HarnessInstanceCatalog {
  return HarnessInstanceCatalogSchema.parse({
    continuationIdentity: {
      continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
      driverKind: "codex",
    },
    driverKind: "codex",
    harnessInstanceId: codexHarnessId,
    models: models.map((model) => ({
      displayName: model.modelId,
      isDefault: model.isDefault,
      modelId: model.modelId,
      options: [
        {
          id: "effort",
          label: "Reasoning",
          type: "select",
          values: [
            {
              label: "Low",
              value: "low",
            },
          ],
        },
      ],
      providerId: "openai",
    })),
    status: "ready",
  });
}
function thread(
  id: Thread["id"],
  harnessInstanceId: HarnessInstanceId,
  title: string,
  parentThreadId: Thread["parentThreadId"] = null,
  overrides: Partial<
    Pick<Thread, "accessMode" | "createdBy" | "environmentId" | "specialistId">
  > = {},
): Thread {
  return {
    accessMode: "full-access",
    teamOrigin: null,
    continuationIdentity: null,
    doneAt: null,
    doneReason: null,
    icon: null,
    purpose: "task",
    createdAt: now,
    createdBy: ownerId,
    environmentId,
    harnessInstanceId,
    inputQueuePaused: false,
    id,
    lineageRootThreadId: parentThreadId ?? id,
    listed: parentThreadId === null,
    modelSelection: testModelSelection,
    parentThreadId,
    pendingRequests: 0,
    providerSessionId: null,
    status: "idle",
    title,
    updatedAt: now,
    ...overrides,
  };
}
function run(value: Thread): Run {
  const seedInputId = createId("message");
  return {
    accessMode: value.accessMode,
    teamRequestId: null,
    activationInputId: seedInputId,
    assignmentId: null,
    completedAt: null,
    createdAt: now,
    environmentId: value.environmentId,
    failure: null,
    harnessInstanceId: value.harnessInstanceId,
    id: createId("run"),
    modelSelection: value.modelSelection,
    providerSessionId: null,
    requestedBy: value.createdBy,
    startedAt: null,
    status: "queued",
    threadId: value.id,
    causalChainId: createId("causalChain"),
    replyTarget: null,
    runOrdinal: 0,
    seedInputId,
  };
}
function message(threadId: Thread["id"], runId: Run["id"] | null, text: string): Message {
  return {
    author: {
      displayName: "Test user",
      kind: "human",
      principalId: `user:${ownerId}`,
      userId: ownerId,
    },
    content: [
      {
        text,
        type: "text",
      },
    ],
    createdAt: now,
    id: createId("message"),
    kind: "input",
    runId,
    sequence: "1" as Message["sequence"],
    threadId,
  };
}
function inboxInput(
  value: Message,
  run: Run | null,
  policy: "report" | "queue" | "steer",
): ThreadInput {
  return {
    assignmentId: null,
    teamRequestId: null,
    teamSource: null,
    cancelReason: null,
    causalChainId: run?.causalChainId ?? createId("causalChain"),
    createdAt: now,
    deliveredAt: run ? now : null,
    messageId: value.id,
    policy,
    replyTarget: null,
    runId: run?.id ?? null,
    state: run ? "claimed" : "pending",
    threadId: value.threadId,
    updatedAt: now,
  };
}
it("uses authenticated admission for a person message without waking work", async () => {
  const messageId = createId("message");
  const publishPersonMessage = vi.fn(async () => ({
    message: {
      id: messageId,
    },
    events: [],
    wasDuplicate: false,
  }));
  const enqueueThreadInput = vi.fn();
  const fixture = makeService({
    commands: {
      publishPersonMessage,
      delegateThread: vi.fn(),
      enqueueThreadInput,
    },
    messages: [],
    threads: [thread(currentThreadId, nativeHarnessId, "Owner task", null, {})],
  });
  const requestId = crypto.randomUUID();
  await expect(
    fixture.service.handle("run-token", {
      type: "person.message",
      requestId,
      message: "Ready.",
    }),
  ).resolves.toEqual({
    type: "person.message.result",
    requestId,
    messageId,
  });
  expect(publishPersonMessage).toHaveBeenCalledWith({
    message: "Ready.",
    admission: expect.objectContaining({
      action: "person.message",
      requestedBy: fixture.claims.requestedBy,
      sourceThreadId: fixture.claims.threadId,
      runId: fixture.claims.runId,
      requestId: mcpToolCallId(
        `run:${fixture.claims.runId}`,
        requestId,
        "operation",
        "person_message",
      ),
    }),
  });
  expect(enqueueThreadInput).not.toHaveBeenCalled();
});
it("omits client-only addressing from agent thread history", async () => {
  const current = thread(currentThreadId, nativeHarnessId, "Owner task");
  const original = message(current.id, null, "Published milestone");
  const addressed = {
    ...original,
    addressedToUserId: ownerId,
  };
  const fixture = makeService({
    commands: {
      delegateThread: vi.fn(),
      enqueueThreadInput: vi.fn(),
    },
    messages: [addressed],
    threads: [current],
  });
  const response = await fixture.service.handle("run-token", {
    type: "thread.read",
    requestId: crypto.randomUUID(),
    threadId: current.id,
  });
  expect(response).toMatchObject({
    type: "thread.read.result",
    items: [messageItem(original, 20_000)],
  });
  if (response.type !== "thread.read.result") throw new Error("Wrong response");
  expect(response.items[0]).not.toHaveProperty("addressedToUserId");
});
it.each([
  // A Thread the person started, reused as a task, answers its assigner.
  [
    "person.message",
    {
      assignerThreadId: targetThreadId,
      open: true,
    },
  ],
  [
    "person.show",
    {
      assignerThreadId: targetThreadId,
      open: true,
    },
  ],
] as const)(
  "refuses %s from an assigned Run with assignment %o before side effects",
  async (type, runAssignment) => {
    const publishPersonMessage = vi.fn();
    const personShow = vi.fn(async () => 1);
    const fixture = makeService({
      personShow,
      ...(runAssignment
        ? {
            runAssignment,
          }
        : {}),
      commands: {
        publishPersonMessage,
        delegateThread: vi.fn(),
        enqueueThreadInput: vi.fn(),
      },
      messages: [],
      threads: [thread(currentThreadId, nativeHarnessId, "Worker", null, {})],
    });
    await expect(
      fixture.service.handle("run-token", {
        type,
        requestId: crypto.randomUUID(),
        ...(type === "person.message"
          ? {
              message: "Hello",
            }
          : {
              target: {
                current: true,
              },
            }),
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(publishPersonMessage).not.toHaveBeenCalled();
    expect(personShow).not.toHaveBeenCalled();
    expect(fixture.admitRunToolCall).not.toHaveBeenCalled();
  },
);

it("allows a task to show its Thread to the person", async () => {
  const personShow = vi.fn(async () => 1);
  const fixture = makeService({
    personShow,
    commands: {
      delegateThread: vi.fn(),
      enqueueThreadInput: vi.fn(),
    },
    messages: [],
    threads: [thread(currentThreadId, nativeHarnessId, "Current", null, {})],
  });
  await expect(
    fixture.service.handle("run-token", {
      type: "person.show",
      requestId: crypto.randomUUID(),
      target: {
        threadId: currentThreadId,
      },
    }),
  ).resolves.toMatchObject({
    type: "person.show.result",
    status: "sent-unconfirmed",
    connectedDevices: 1,
  });
  expect(personShow).toHaveBeenCalledWith(
    ownerId,
    expect.objectContaining({
      target: {
        threadId: currentThreadId,
      },
    }),
  );
});
