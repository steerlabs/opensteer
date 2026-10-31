import { createHash } from "node:crypto";
import {
  createId,
  HarnessIdSchema,
  ModelSelectionSchema,
  OpensteerError,
  PendingRequestSchema,
  type AgentEvent,
  type EnvironmentId,
  type HarnessInstanceId,
  type Message,
  type Run,
  type Thread,
  type ThreadInput,
  type Workspace,
} from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import type { CommandService } from "@opensteer/orchestration";
import {
  createBrowserSessionId,
  AgentControlRequestSchema,
  HarnessInstanceCatalogSchema,
  type HarnessInstanceCatalog,
} from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  AgentControlService,
  type AgentControlTokenService,
  type AgentTriggerManager,
  type AgentWorkspaceMountService,
} from "./agent-control-service.js";
import type { BrowserService } from "../browser/browser-service.js";

const now = "2026-08-09T09:00:00.000Z";
const ownerId = createId("user");
const runnerId = createId("runner");
const environmentId = createId("environment");
const targetEnvironmentId = createId("environment");
const workspaceId = createId("workspace");
const targetWorkspaceId = createId("workspace");
const currentThreadId = createId("thread");
const targetThreadId = createId("thread");
const nativeHarnessId = createId("harnessInstance");
const codexHarnessId = createId("harnessInstance");
const targetNativeHarnessId = createId("harnessInstance");
const targetCodexHarnessId = createId("harnessInstance");
const testModelSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: { effort: "low" },
  providerId: "openai",
});

describe("AgentControlService", () => {
  it("lists exactly the Requests visible to the current Thread and Workspace", async () => {
    const current = thread(currentThreadId, nativeHarnessId, "Main");
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
      commands: { delegateThread: vi.fn(), enqueueThreadInput: vi.fn() },
      messages: [],
      requests: { visiblePage },
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
      requests: [{ id: pending.id, status: "pending" }],
      type: "request.list.result",
      window: { hasMore: true, nextBefore: "next_request_page" },
    });
    expect(visiblePage).toHaveBeenCalledWith({
      before: "current_request_page",
      limit: 1,
      originatingThreadId: claims.threadId,
      targetWorkspaceId: claims.workspaceId,
    });
  });

  it("derives the exposed tool surface from the Thread's pinned capability profile", async () => {
    const current = thread(currentThreadId, nativeHarnessId, "Delegated", null, {
      capabilityProfileId: "delegated",
    });
    const { service } = makeService({
      capabilityProfileId: "delegated",
      commands: { delegateThread: vi.fn(), enqueueThreadInput: vi.fn() },
      messages: [],
      threads: [current],
    });

    await expect(
      service.handle("run-token", {
        requestId: crypto.randomUUID(),
        type: "workspace.inspect",
      }),
    ).rejects.toThrow("does not allow workspace.list");
  });

  it.each(["browser.sign-in", "sign-in"] as const)(
    "keeps %s Browser Session requests admitted through the single sign-in permission",
    async (type) => {
      const current = thread(currentThreadId, nativeHarnessId, "Main");
      const result = {
        status: "unavailable",
        site: "https://example.com",
        reason: "no-saved-login",
      } as const;
      const agentSignIn = vi.fn(async () => result);
      const { service, admitAgentControlRequest } = makeService({
        browserSources: { agentSignIn },
        commands: { delegateThread: vi.fn(), enqueueThreadInput: vi.fn() },
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
      ).resolves.toEqual({ requestId, type: `${type}.result`, result });
      expect(agentSignIn).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId, site: result.site }),
      );
      expect(admitAgentControlRequest).toHaveBeenCalledWith(
        expect.objectContaining({ action: "browser.sign-in" }),
      );
    },
  );

  it("does not preserve Main authority after its member is no longer an owner", async () => {
    const current = thread(currentThreadId, nativeHarnessId, "Main");
    const { service } = makeService({
      commands: { delegateThread: vi.fn(), enqueueThreadInput: vi.fn() },
      currentMembershipRole: "collaborator",
      messages: [],
      threads: [current],
    });

    await expect(
      service.handle("run-token", {
        requestId: crypto.randomUUID(),
        type: "workspace.inspect",
      }),
    ).rejects.toThrow("Main coordination requires active owner authority");
  });

  // The Workspace an agent asks to mount may have been archived, or claimed by
  // the archive sweep moments ago. Neither is a failed mount: the wake cancels
  // a quiescing archive, so the answer is "retry", not "not ready".
  it.each(["archiving", "archived"] as const)(
    "wakes a %s Workspace instead of failing the agent's mount",
    async (status) => {
      const current = thread(currentThreadId, nativeHarnessId, "Main");
      const target = { ...workspace(targetWorkspaceId, "Client"), status };
      const mountWorkspace = vi.fn();
      const { service, wakeWorkspace } = makeService({
        commands: { delegateThread: vi.fn(), enqueueThreadInput: vi.fn() },
        messages: [],
        mountWorkspace,
        threads: [current],
        workspaces: [workspace(workspaceId, "Main"), target],
      });

      await expect(
        service.handle("run-token", {
          requestId: crypto.randomUUID(),
          type: "workspace.mount",
          workspaceId: target.id,
        }),
      ).rejects.toMatchObject({ code: "conflict", retryable: true });
      expect(wakeWorkspace).toHaveBeenCalledWith(target.id, "agent-workspace-mount");
      expect(mountWorkspace).not.toHaveBeenCalled();
    },
  );

  it("refuses to mount a Workspace whose storage failed, without waking it", async () => {
    const current = thread(currentThreadId, nativeHarnessId, "Main");
    const target = { ...workspace(targetWorkspaceId, "Client"), status: "failed" as const };
    const { service, wakeWorkspace } = makeService({
      commands: { delegateThread: vi.fn(), enqueueThreadInput: vi.fn() },
      messages: [],
      threads: [current],
      workspaces: [workspace(workspaceId, "Main"), target],
    });

    await expect(
      service.handle("run-token", {
        requestId: crypto.randomUUID(),
        type: "workspace.mount",
        workspaceId: target.id,
      }),
    ).rejects.toMatchObject({ code: "conflict", retryable: false });
    expect(wakeWorkspace).not.toHaveBeenCalled();
  });

  it("projects created Workspaces onto the public response shape", async () => {
    const current = thread(currentThreadId, nativeHarnessId, "Main");
    const created = workspace(targetWorkspaceId, "Analysis");
    const createWorkspace = vi.fn(async () => created);
    const { service } = makeService({
      commands: { delegateThread: vi.fn(), enqueueThreadInput: vi.fn() },
      createWorkspace,
      messages: [],
      threads: [current],
    });

    const response = await service.handle("run-token", {
      name: "Analysis",
      requestId: crypto.randomUUID(),
      type: "workspace.create",
    });

    expect(response).toMatchObject({
      type: "workspace.create.result",
      workspace: {
        capacity: { kind: "managed-quota" },
        id: created.id,
        location: { kind: "shared-storage" },
        name: created.name,
      },
    });
    if (response.type !== "workspace.create.result") throw new Error("Unexpected response type");
    expect(response.workspace).not.toHaveProperty("backing");
    expect(response.workspace).not.toHaveProperty("capacityPolicy");
    expect(response.workspace).not.toHaveProperty("createdBy");
    // The icon is for people; a Runner parsing this strictly never sees it.
    expect(response.workspace).not.toHaveProperty("icon");
    expect(createWorkspace).toHaveBeenLastCalledWith(
      expect.objectContaining({ storage: { backing: "portablefs" } }),
    );

    // A local directory with no machine named goes on the machine this Run uses.
    await service.handle("run-token", {
      icon: "plane",
      name: "Travel",
      requestId: crypto.randomUUID(),
      storage: { backing: "local-directory" },
      type: "workspace.create",
    });
    expect(createWorkspace).toHaveBeenLastCalledWith(
      expect.objectContaining({
        icon: "plane",
        storage: { backing: "local-directory", environmentId },
      }),
    );
  });

  it("exposes only typed workspace context and coordinates durable child/target turns", async () => {
    const current = {
      ...thread(currentThreadId, nativeHarnessId, "Main"),
      accessMode: "auto" as const,
    };
    const target = thread(targetThreadId, codexHarnessId, "Research", null, {
      environmentId: targetEnvironmentId,
      workspaceId: targetWorkspaceId,
    });
    const targetMessage = message(target.id, null, "Existing research");
    const child = {
      ...thread(createId("thread"), nativeHarnessId, "Contract research", current.id, {
        workspaceId: targetWorkspaceId,
      }),
      accessMode: current.accessMode,
    };
    const childRun = run(child);
    const childMessage = message(child.id, childRun.id, "Delegated task");
    const targetRun = run(target);
    const forwardedMessage = message(target.id, targetRun.id, "Please continue");
    const delegateThread = vi.fn(async () => ({
      assignment: { id: createId("delegation") },
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
    const { service, authenticate, claims, listEnvironmentsForUser, workspaceSnapshot } =
      makeService({
        commands: { delegateThread, enqueueThreadInput },
        environments: [environmentId, targetEnvironmentId],
        messages: [targetMessage],
        targetEnvironmentHarnesses,
        threads: [current, target],
        workspaces: [
          workspace(workspaceId, "Main workspace"),
          workspace(targetWorkspaceId, "Client"),
        ],
      });

    const inspectId = crypto.randomUUID();
    await expect(
      service.handle("run-token", { requestId: inspectId, type: "workspace.inspect" }),
    ).resolves.toMatchObject({
      environments: [
        {
          compatibleHarnessInstanceIds: expect.arrayContaining([nativeHarnessId, codexHarnessId]),
          connected: true,
          id: environmentId,
        },
        {
          compatibleHarnessInstanceIds: expect.arrayContaining([
            targetNativeHarnessId,
            targetCodexHarnessId,
          ]),
          connected: true,
          id: targetEnvironmentId,
        },
      ],
      harnesses: expect.arrayContaining([
        expect.objectContaining({ enabled: true, id: nativeHarnessId }),
        expect.objectContaining({ enabled: true, id: codexHarnessId }),
        expect.objectContaining({ enabled: true, id: targetNativeHarnessId }),
        expect.objectContaining({ enabled: true, id: targetCodexHarnessId }),
      ]),
      requestId: inspectId,
      threads: [current, target],
      type: "workspace.inspect.result",
      workspaces: [
        { id: workspaceId, name: "Main workspace", status: "ready" },
        { id: targetWorkspaceId, name: "Client", status: "ready" },
      ],
    });

    const readId = crypto.randomUUID();
    await expect(
      service.handle("run-token", {
        maxMessages: 10,
        requestId: readId,
        threadId: target.id,
        type: "thread.read",
      }),
    ).resolves.toMatchObject({ messages: [targetMessage], thread: target });

    const delegateId = crypto.randomUUID();
    const delegateRequest = AgentControlRequestSchema.parse({
      requestId: delegateId,
      task: "Research the provider contract",
      title: child.title,
      type: "thread.delegate",
      workspaceId: targetWorkspaceId,
    });
    await expect(service.handle("run-token", delegateRequest)).resolves.toMatchObject({
      result: { run: childRun, thread: child },
    });
    expect(delegateThread).toHaveBeenCalledWith({
      accessMode: "auto",
      callerIntent: {
        requestId: delegateId,
        requestFingerprint: createHash("sha256")
          .update(JSON.stringify(delegateRequest), "utf8")
          .digest("hex"),
      },
      createdBy: ownerId,
      environmentId,
      harnessInstanceId: nativeHarnessId,
      idempotencyKey: expect.stringContaining(`${delegateId}:delegate`),
      modelSelection: testModelSelection,
      origin: {
        kind: "run",
        parentRunId: claims.runId,
        parentThreadId: currentThreadId,
      },
      task: [{ text: "Research the provider contract", type: "text" }],
      title: child.title,
      titleSource: "chosen",
      workspaceId: targetWorkspaceId,
    });

    const messageId = crypto.randomUUID();
    await expect(
      service.handle("run-token", {
        content: [{ text: "Please continue", type: "text" }],
        delivery: "queue",
        requestId: messageId,
        threadId: target.id,
        type: "thread.message",
      }),
    ).resolves.toMatchObject({ result: { run: targetRun, thread: target } });
    expect(enqueueThreadInput).toHaveBeenCalledWith({
      content: [{ text: "Please continue", type: "text" }],
      idempotencyKey: expect.stringContaining(`${messageId}:message`),
      policy: "queue",
      requestedBy: ownerId,
      source: { kind: "agent", runId: claims.runId },
      threadId: target.id,
    });
    expect(authenticate).toHaveBeenCalledTimes(4);
    expect(authenticate).toHaveBeenCalledWith("run-token");
    expect(listEnvironmentsForUser).toHaveBeenCalledWith(ownerId, 65);
    expect(workspaceSnapshot).not.toHaveBeenCalled();
  });

  it("scopes Workspace inspection profiles to their authorized Environment", async () => {
    const current = thread(currentThreadId, nativeHarnessId, "Main");
    const foreignEnvironmentId = createId("environment");
    const foreignProfiles = Array.from({ length: 64 }, (_, index) => ({
      config: {},
      createdAt: now,
      driverKind: HarnessIdSchema.parse("native"),
      enabled: true,
      environmentId: foreignEnvironmentId,
      id: createId("harnessInstance"),
      isDefault: index === 0,
      name: `Foreign ${String(index)}`,
      removedAt: null,
      runtimeRevision: 1,
      sourceId: "native",
      stateKind: "ambient" as const,
    }));
    const ownProfile = {
      config: {},
      createdAt: now,
      driverKind: HarnessIdSchema.parse("native"),
      enabled: true,
      environmentId,
      id: nativeHarnessId,
      isDefault: true,
      name: "Opensteer",
      removedAt: null,
      runtimeRevision: 1,
      sourceId: "native",
      stateKind: "ambient" as const,
    };
    const listHarnessInstances = vi.fn<OpensteerStore["listHarnessInstances"]>(async (input) =>
      input?.environmentIds ? [ownProfile] : [...foreignProfiles, ownProfile],
    );
    const { service } = makeService({
      commands: { delegateThread: vi.fn(), enqueueThreadInput: vi.fn() },
      listHarnessInstances,
      messages: [],
      threads: [current],
    });

    await expect(
      service.handle("run-token", {
        requestId: crypto.randomUUID(),
        type: "workspace.inspect",
      }),
    ).resolves.toMatchObject({
      environments: [{ compatibleHarnessInstanceIds: [nativeHarnessId], id: environmentId }],
      harnesses: [{ id: nativeHarnessId }],
      harnessesTruncated: false,
    });
    expect(listHarnessInstances).toHaveBeenCalledWith({ environmentIds: [environmentId] });
  });

  it("scopes thread_list by capability profile and passes its filters through", async () => {
    const parentThreadId = createId("thread");
    const parent = thread(parentThreadId, nativeHarnessId, "Parent");
    const child = thread(currentThreadId, nativeHarnessId, "Child", parentThreadId, {
      capabilityProfileId: "delegated",
    });
    const sibling = thread(createId("thread"), nativeHarnessId, "Sibling", parentThreadId, {
      capabilityProfileId: "delegated",
    });
    const unrelated = thread(targetThreadId, codexHarnessId, "Unrelated research", null, {
      capabilityProfileId: "main",
      workspaceId: targetWorkspaceId,
    });
    const threads = [parent, child, sibling, unrelated];
    const workspaces = [
      workspace(workspaceId, "Main workspace"),
      workspace(targetWorkspaceId, "Client"),
    ];

    const main = makeService({
      capabilityProfileId: "main",
      commands: { delegateThread: vi.fn(), enqueueThreadInput: vi.fn() },
      messages: [],
      threads: [
        thread(currentThreadId, nativeHarnessId, "Main", null, {
          capabilityProfileId: "main",
        }),
        unrelated,
      ],
      workspaces,
    });
    await expect(
      main.service.handle("run-token", { requestId: crypto.randomUUID(), type: "thread.list" }),
    ).resolves.toMatchObject({
      threads: [
        { id: currentThreadId, workspaceName: "Main workspace" },
        { environmentConnected: true, id: unrelated.id, workspaceName: "Client" },
      ],
      type: "thread.list.result",
      window: { hasMore: false, itemCount: 2, totalItems: 2 },
    });
    const legacyList = await main.service.handle("run-token", {
      requestId: crypto.randomUUID(),
      type: "thread.list",
    });
    if (legacyList.type !== "thread.list.result") throw new Error("Expected thread list");
    for (const summary of legacyList.threads) expect(summary).not.toHaveProperty("doneAt");
    expect(main.agentThreadPageForOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        maxItems: 25,
        ownerId,
        scope: { kind: "user" },
        scopeId: currentThreadId,
      }),
    );

    await expect(
      main.service.handle("run-token", {
        limit: 50,
        query: "Unrelated",
        requestId: crypto.randomUUID(),
        type: "thread.list",
        workspaceId: targetWorkspaceId,
      }),
    ).resolves.toMatchObject({ threads: [{ id: unrelated.id }] });
    expect(main.agentThreadPageForOwner).toHaveBeenLastCalledWith(
      expect.objectContaining({ maxItems: 50, query: "Unrelated", workspaceId: targetWorkspaceId }),
    );

    const scoped = makeService({
      capabilityProfileId: "workspace",
      commands: { delegateThread: vi.fn(), enqueueThreadInput: vi.fn() },
      messages: [],
      threads: [
        thread(currentThreadId, nativeHarnessId, "Workspace", null, {
          capabilityProfileId: "workspace",
        }),
        unrelated,
      ],
      workspaces,
    });
    await expect(
      scoped.service.handle("run-token", { requestId: crypto.randomUUID(), type: "thread.list" }),
    ).resolves.toMatchObject({ threads: [{ id: currentThreadId }] });
    expect(scoped.agentThreadPageForOwner).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { kind: "workspace", workspaceId } }),
    );
    await expect(
      scoped.service.handle("run-token", {
        requestId: crypto.randomUUID(),
        type: "thread.list",
        workspaceId: targetWorkspaceId,
      }),
    ).rejects.toThrow("can list Threads only in its Workspace");

    const delegated = makeService({
      capabilityProfileId: "delegated",
      commands: { delegateThread: vi.fn(), enqueueThreadInput: vi.fn() },
      messages: [],
      threads,
      workspaces,
    });
    await expect(
      delegated.service.handle("run-token", {
        requestId: crypto.randomUUID(),
        type: "thread.list",
      }),
    ).resolves.toMatchObject({
      threads: [{ id: parent.id }, { id: child.id }, { id: sibling.id }],
    });
    expect(delegated.agentThreadPageForOwner).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { kind: "lineage", threadId: currentThreadId } }),
    );
  });

  it("keeps delegated reads and messages inside its lineage", async () => {
    const parentThreadId = createId("thread");
    const parent = thread(parentThreadId, nativeHarnessId, "Parent");
    const unrelated = thread(targetThreadId, codexHarnessId, "Unrelated", null, {
      workspaceId: targetWorkspaceId,
    });
    const workspaces = [
      workspace(workspaceId, "Main workspace"),
      workspace(targetWorkspaceId, "Client"),
    ];
    const forwarded = message(unrelated.id, null, "Status?");
    const enqueueThreadInput = vi.fn(async () => ({
      disposition: "pending" as const,
      input: inboxInput(forwarded, null, "queue"),
      message: forwarded,
      run: null,
      wasDuplicate: false,
    }));
    const child = thread(currentThreadId, nativeHarnessId, "Child", parentThreadId, {
      capabilityProfileId: "delegated",
    });
    const { service } = makeService({
      capabilityProfileId: "delegated",
      commands: { delegateThread: vi.fn(), enqueueThreadInput },
      messages: [],
      threads: [parent, child, unrelated],
      workspaces,
    });

    await expect(
      service.handle("run-token", {
        content: [{ text: "Status?", type: "text" }],
        delivery: "queue",
        requestId: crypto.randomUUID(),
        threadId: unrelated.id,
        type: "thread.message",
      }),
    ).rejects.toThrow("delegation lineage");
    expect(enqueueThreadInput).not.toHaveBeenCalled();

    await expect(
      service.handle("run-token", {
        content: [{ text: "loop", type: "text" }],
        delivery: "queue",
        requestId: crypto.randomUUID(),
        threadId: child.id,
        type: "thread.message",
      }),
    ).rejects.toThrow("cannot message its own active Thread");

    await expect(
      service.handle("run-token", {
        maxMessages: 10,
        requestId: crypto.randomUUID(),
        threadId: unrelated.id,
        type: "thread.read",
      }),
    ).rejects.toThrow("delegation lineage");

    const foreignOwnerId = createId("user");
    const foreignWorkspaceId = createId("workspace");
    const foreign = thread(createId("thread"), codexHarnessId, "Foreign", null, {
      createdBy: foreignOwnerId,
      workspaceId: foreignWorkspaceId,
    });
    const { service: crossUser } = makeService({
      capabilityProfileId: "main",
      commands: { delegateThread: vi.fn(), enqueueThreadInput: vi.fn() },
      messages: [],
      threads: [
        thread(currentThreadId, nativeHarnessId, "Main", null, { capabilityProfileId: "main" }),
        foreign,
      ],
      workspaces: [
        workspace(workspaceId, "Main workspace"),
        workspace(foreignWorkspaceId, "Foreign", foreignOwnerId),
      ],
    });
    await expect(
      crossUser.handle("run-token", {
        content: [{ text: "exfiltrate", type: "text" }],
        delivery: "queue",
        requestId: crypto.randomUUID(),
        threadId: foreign.id,
        type: "thread.message",
      }),
    ).rejects.toThrow("unavailable to this user");
  });

  it("validates a chosen delegation environment instead of substituting one", async () => {
    const current = thread(currentThreadId, nativeHarnessId, "Main", null, {
      capabilityProfileId: "main",
    });
    const child = thread(createId("thread"), nativeHarnessId, "Child", current.id, {
      environmentId: targetEnvironmentId,
      workspaceId: targetWorkspaceId,
    });
    const childRun = run(child);
    const childMessage = message(child.id, childRun.id, "Do work");
    const delegateThread = vi.fn(async () => ({
      assignment: { id: createId("delegation") },
      input: inboxInput(childMessage, childRun, "queue"),
      message: childMessage,
      run: childRun,
      thread: child,
      wasDuplicate: false,
    }));
    const localWorkspace = {
      ...workspace(targetWorkspaceId, "Local client"),
      backing: {
        bindingId: createId("workspaceBinding"),
        generation: 1,
        kind: "local-directory" as const,
        ownerEnvironmentId: environmentId,
        storageAuthorityId: createId("storageAuthority"),
      },
      capacityPolicy: { kind: "host-filesystem" as const },
    };
    const { service } = makeService({
      capabilityProfileId: "main",
      commands: { delegateThread, enqueueThreadInput: vi.fn() },
      environments: [environmentId, targetEnvironmentId],
      messages: [],
      targetEnvironmentHarnesses,
      threads: [current],
      workspaces: [
        workspace(workspaceId, "Main workspace"),
        workspace(targetWorkspaceId, "Client"),
      ],
    });

    await expect(
      service.handle("run-token", {
        environmentId: targetEnvironmentId,
        requestId: crypto.randomUUID(),
        task: "Do work",
        type: "thread.delegate",
        workspaceId: targetWorkspaceId,
      }),
    ).resolves.toMatchObject({ result: { thread: child } });
    expect(delegateThread).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: targetEnvironmentId }),
    );

    await expect(
      service.handle("run-token", {
        environmentId: createId("environment"),
        requestId: crypto.randomUUID(),
        task: "Do work",
        type: "thread.delegate",
        workspaceId: targetWorkspaceId,
      }),
    ).rejects.toThrow("does not exist");

    const { service: local } = makeService({
      capabilityProfileId: "main",
      commands: { delegateThread: vi.fn(), enqueueThreadInput: vi.fn() },
      environments: [environmentId, targetEnvironmentId],
      messages: [],
      threads: [current],
      workspaces: [workspace(workspaceId, "Main workspace"), localWorkspace],
    });
    await expect(
      local.handle("run-token", {
        environmentId: targetEnvironmentId,
        requestId: crypto.randomUUID(),
        task: "Do work",
        type: "thread.delegate",
        workspaceId: targetWorkspaceId,
      }),
    ).rejects.toThrow("can run only in its owning environment");

    const { service: offline } = makeService({
      capabilityProfileId: "main",
      commands: { delegateThread, enqueueThreadInput: vi.fn() },
      disconnectedEnvironmentId: targetEnvironmentId,
      environments: [environmentId, targetEnvironmentId],
      messages: [],
      targetEnvironmentHarnesses,
      threads: [current],
      workspaces: [
        workspace(workspaceId, "Main workspace"),
        workspace(targetWorkspaceId, "Client"),
      ],
    });
    await expect(
      offline.handle("run-token", {
        environmentId: targetEnvironmentId,
        requestId: crypto.randomUUID(),
        task: "Do work",
        type: "thread.delegate",
        workspaceId: targetWorkspaceId,
      }),
    ).resolves.toMatchObject({ result: { thread: child } });

    const { service: unavailable } = makeService({
      capabilityProfileId: "main",
      commands: { delegateThread: vi.fn(), enqueueThreadInput: vi.fn() },
      environments: [environmentId, targetEnvironmentId],
      foreignEnvironmentId: targetEnvironmentId,
      messages: [],
      threads: [current],
      workspaces: [
        workspace(workspaceId, "Main workspace"),
        workspace(targetWorkspaceId, "Client"),
      ],
    });
    await expect(
      unavailable.handle("run-token", {
        environmentId: targetEnvironmentId,
        requestId: crypto.randomUUID(),
        task: "Do work",
        type: "thread.delegate",
        workspaceId: targetWorkspaceId,
      }),
    ).rejects.toThrow("unavailable to this user");
  });

  it("fences a local-directory Workspace when the delegation names no environment", async () => {
    // The parent Thread runs on one machine and the Workspace's files live on
    // another, so the inherited environment is the wrong machine. Nothing about
    // the fence depends on the environment having been named.
    const current = thread(currentThreadId, nativeHarnessId, "Main", null, {
      capabilityProfileId: "main",
    });
    const delegateThread = vi.fn();
    const localWorkspace = {
      ...workspace(targetWorkspaceId, "Local client"),
      backing: {
        bindingId: createId("workspaceBinding"),
        generation: 1,
        kind: "local-directory" as const,
        ownerEnvironmentId: targetEnvironmentId,
        storageAuthorityId: createId("storageAuthority"),
      },
      capacityPolicy: { kind: "host-filesystem" as const },
    };
    const { service } = makeService({
      capabilityProfileId: "main",
      commands: { delegateThread, enqueueThreadInput: vi.fn() },
      environments: [environmentId, targetEnvironmentId],
      messages: [],
      threads: [current],
      workspaces: [workspace(workspaceId, "Main workspace"), localWorkspace],
    });

    await expect(
      service.handle("run-token", {
        requestId: crypto.randomUUID(),
        task: "Do work",
        type: "thread.delegate",
        workspaceId: targetWorkspaceId,
      }),
    ).rejects.toMatchObject({
      code: "bad_request",
      message: "A local-directory Workspace can run only in its owning environment",
    });
    expect(delegateThread).not.toHaveBeenCalled();
  });

  it("refuses by name when the target machine's engine does not offer the delegating model", async () => {
    const current = thread(currentThreadId, nativeHarnessId, "Main", null, {
      capabilityProfileId: "main",
    });
    const delegateThread = vi.fn();
    const { service } = makeService({
      capabilityProfileId: "main",
      commands: { delegateThread, enqueueThreadInput: vi.fn() },
      environments: [environmentId, targetEnvironmentId],
      harnessCatalog: readyCatalog([
        { isDefault: false, modelId: "gpt-5.6-mini" },
        { isDefault: true, modelId: "gpt-5.6-codex" },
      ]),
      messages: [],
      targetEnvironmentHarnesses,
      threads: [current],
      workspaces: [
        workspace(workspaceId, "Main workspace"),
        workspace(targetWorkspaceId, "Client"),
      ],
    });

    await expect(
      service.handle("run-token", {
        environmentId: targetEnvironmentId,
        requestId: crypto.randomUUID(),
        task: "Do work",
        type: "thread.delegate",
        workspaceId: targetWorkspaceId,
      }),
    ).rejects.toMatchObject({
      code: "bad_request",
      message: expect.stringContaining("openai/gpt-5.6-mini, openai/gpt-5.6-codex"),
    });
    expect(delegateThread).not.toHaveBeenCalled();
  });

  it("names the machine and driver when a cross-environment delegation has nowhere to run", async () => {
    const current = thread(currentThreadId, nativeHarnessId, "Main", null, {
      capabilityProfileId: "main",
    });
    const delegateThread = vi.fn();
    const base = {
      capabilityProfileId: "main" as const,
      commands: { delegateThread, enqueueThreadInput: vi.fn() },
      environments: [environmentId, targetEnvironmentId],
      messages: [],
      threads: [current],
      workspaces: [
        workspace(workspaceId, "Main workspace"),
        workspace(targetWorkspaceId, "Client"),
      ],
    };
    const request = {
      environmentId: targetEnvironmentId,
      requestId: crypto.randomUUID(),
      task: "Do work",
      type: "thread.delegate" as const,
      workspaceId: targetWorkspaceId,
    };

    const { service: missing } = makeService({
      ...base,
      targetEnvironmentHarnesses: [
        {
          driverKind: "codex",
          enabled: true,
          id: targetCodexHarnessId,
          isDefault: true,
          name: "Codex",
        },
      ],
    });
    await expect(missing.handle("run-token", request)).rejects.toThrow(
      "Local Runner has no enabled native AI engine",
    );

    const { service: disabled } = makeService({
      ...base,
      targetEnvironmentHarnesses: [
        {
          driverKind: "native",
          enabled: false,
          id: targetNativeHarnessId,
          isDefault: false,
          name: "Opensteer",
        },
      ],
    });
    await expect(disabled.handle("run-token", request)).rejects.toThrow(
      "Local Runner has no enabled native AI engine",
    );

    const { service: uninspected } = makeService({
      ...base,
      harnessCatalog: null,
      targetEnvironmentHarnesses,
    });
    await expect(uninspected.handle("run-token", request)).rejects.toThrow(
      "has not reported the models it can run",
    );
    expect(delegateThread).not.toHaveBeenCalled();
  });

  it("rejects self-messaging, foreign-owner Threads, and disabled harness delegation", async () => {
    const current = thread(currentThreadId, nativeHarnessId, "Main");
    const target = thread(targetThreadId, codexHarnessId, "Research");
    const foreignOwnerId = createId("user");
    const foreignWorkspaceId = createId("workspace");
    const foreign = thread(createId("thread"), codexHarnessId, "Foreign", null, {
      createdBy: foreignOwnerId,
      workspaceId: foreignWorkspaceId,
    });
    const { service } = makeService({
      commands: { delegateThread: vi.fn(), enqueueThreadInput: vi.fn() },
      disabledHarnessId: nativeHarnessId,
      messages: [],
      threads: [current, target, foreign],
      workspaces: [
        workspace(workspaceId, "Main workspace"),
        workspace(foreignWorkspaceId, "Foreign workspace", foreignOwnerId),
      ],
    });

    await expect(
      service.handle("run-token", {
        requestId: crypto.randomUUID(),
        type: "workspace.inspect",
      }),
    ).resolves.toMatchObject({
      environments: [{ compatibleHarnessInstanceIds: [codexHarnessId] }],
      harnesses: [{ id: codexHarnessId }],
      threads: [current, target],
      workspaces: [{ id: workspaceId }],
    });

    await expect(
      service.handle("run-token", {
        content: [{ text: "loop", type: "text" }],
        delivery: "queue",
        requestId: crypto.randomUUID(),
        threadId: current.id,
        type: "thread.message",
      }),
    ).rejects.toThrow("cannot message its own active Thread");

    await expect(
      service.handle("run-token", {
        maxMessages: 10,
        requestId: crypto.randomUUID(),
        threadId: foreign.id,
        type: "thread.read",
      }),
    ).rejects.toThrow("unavailable to this user");

    await expect(
      service.handle("run-token", {
        content: [{ text: "exfiltrate", type: "text" }],
        delivery: "queue",
        requestId: crypto.randomUUID(),
        threadId: foreign.id,
        type: "thread.message",
      }),
    ).rejects.toThrow("unavailable to this user");

    await expect(
      service.handle("run-token", {
        requestId: crypto.randomUUID(),
        task: "Do not run",
        title: "Disabled",
        type: "thread.delegate",
        workspaceId,
      }),
    ).rejects.toThrow("disabled or unavailable");
  });

  it("does not create a delegated Thread when its pinned environment lacks the driver", async () => {
    const current = thread(currentThreadId, nativeHarnessId, "Main");
    const delegateThread = vi.fn();
    const enqueueThreadInput = vi.fn();
    const { service } = makeService({
      commands: { delegateThread, enqueueThreadInput },
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
        workspaceId,
      }),
    ).rejects.toThrow("cannot run harness driver native");
    expect(delegateThread).not.toHaveBeenCalled();
    expect(enqueueThreadInput).not.toHaveBeenCalled();
  });

  it("replays an exact durable delegation before rechecking placement", async () => {
    const current = thread(currentThreadId, nativeHarnessId, "Main");
    const child = thread(createId("thread"), nativeHarnessId, "Existing child", current.id, {
      workspaceId: targetWorkspaceId,
    });
    const childRun = run(child);
    const childMessage = message(child.id, childRun.id, "Existing task");
    const delegateThread = vi.fn();
    const enqueueThreadInput = vi.fn();
    const requestId = crypto.randomUUID();
    const { service } = makeService({
      commands: { delegateThread, enqueueThreadInput },
      disconnectedEnvironmentId: environmentId,
      environments: [environmentId, targetEnvironmentId],
      existingDelegation: {
        assignment: { id: createId("delegation") },
        input: inboxInput(childMessage, childRun, "queue"),
        message: childMessage,
        run: childRun,
        thread: child,
      },
      messages: [],
      threads: [current, child],
      workspaces: [
        workspace(workspaceId, "Main workspace"),
        { ...workspace(targetWorkspaceId, "Unavailable target"), status: "unavailable" },
      ],
    });

    await expect(
      service.handle("run-token", {
        requestId,
        task: "Existing task",
        title: child.title,
        type: "thread.delegate",
        workspaceId: targetWorkspaceId,
      }),
    ).resolves.toMatchObject({ result: { message: childMessage, run: childRun, thread: child } });
    expect(delegateThread).not.toHaveBeenCalled();
    expect(enqueueThreadInput).not.toHaveBeenCalled();
  });

  it("requires an owned target Workspace and a connected inherited environment", async () => {
    const current = thread(currentThreadId, nativeHarnessId, "Main");
    const foreignOwnerId = createId("user");
    const foreignWorkspaceId = createId("workspace");
    const delegateThread = vi.fn();
    const enqueueThreadInput = vi.fn();
    const { service } = makeService({
      commands: { delegateThread, enqueueThreadInput },
      disconnectedEnvironmentId: environmentId,
      environments: [environmentId, targetEnvironmentId],
      messages: [],
      threads: [current],
      workspaces: [
        workspace(workspaceId, "Main workspace"),
        workspace(foreignWorkspaceId, "Foreign", foreignOwnerId),
      ],
    });
    const base = {
      requestId: crypto.randomUUID(),
      task: "Do work",
      title: "Child",
      type: "thread.delegate" as const,
    };

    await expect(
      service.handle("run-token", { ...base, workspaceId: foreignWorkspaceId }),
    ).rejects.toThrow("unavailable to this user");
    await expect(service.handle("run-token", { ...base, workspaceId })).rejects.toThrow(
      "not connected",
    );
    expect(delegateThread).not.toHaveBeenCalled();
    expect(enqueueThreadInput).not.toHaveBeenCalled();
  });

  it("opens fresh Browser Sessions and brokers profile saves for Main and Workspace", async () => {
    const sessionId = createBrowserSessionId();
    const durableRequestId = createId("request");
    const freshSummary = {
      access: "full-control" as const,
      activeAttachmentCount: 1,
      attached: true,
      createdAt: now,
      id: sessionId,
      origin: "agent" as const,
      placement: { kind: "runner" as const, runnerId: createId("runner") },
      profileId: null,
      profileName: null,
      runtimeId: "hosted-browser-1",
      state: "ready" as const,
      updatedAt: now,
      workspaceId,
    };
    for (const capabilityProfileId of ["main", "workspace"] as const) {
      const current = thread(currentThreadId, nativeHarnessId, "Main", null, {
        capabilityProfileId,
      });
      const openAgentSession = vi.fn(async () => ({ session: freshSummary, wasExisting: false }));
      const requestSaveProfile = vi.fn(async () => ({
        kind: "browser.profile.save" as const,
        replayed: false,
        requestId: durableRequestId,
        status: "pending" as const,
      }));
      const { claims, service } = makeService({
        browser: { openAgentSession, requestSaveProfile },
        capabilityProfileId,
        commands: { delegateThread: vi.fn(), enqueueThreadInput: vi.fn() },
        messages: [],
        threads: [current],
      });

      await expect(
        service.handle("run-token", {
          fresh: true,
          requestId: crypto.randomUUID(),
          type: "browser.session.open",
        }),
      ).resolves.toMatchObject({
        session: { profileId: null, profileName: null },
        type: "browser.session.open.result",
      });
      expect(openAgentSession).toHaveBeenCalledWith(
        expect.objectContaining({ environmentId, fresh: true }),
      );
      expect(openAgentSession).not.toHaveBeenCalledWith(
        expect.objectContaining({ profileId: expect.anything() }),
      );

      const saveRequestId = crypto.randomUUID();
      await expect(
        service.handle("run-token", {
          reason: "Reuse this portal login next time",
          requestId: saveRequestId,
          sessionId,
          suggestedName: "Client portal",
          type: "browser.profile.save",
        }),
      ).resolves.toEqual({
        result: {
          kind: "browser.profile.save",
          replayed: false,
          requestId: durableRequestId,
          status: "pending",
        },
        requestId: expect.any(String),
        type: "browser.profile.save.result",
      });
      expect(requestSaveProfile).toHaveBeenCalledWith({
        callId: saveRequestId,
        originatingWorkspaceId: claims.workspaceId,
        ownerId: claims.requestedBy,
        reason: "Reuse this portal login next time",
        runId: claims.runId,
        sessionId,
        suggestedName: "Client portal",
        threadId: claims.threadId,
        workspaceId: claims.workspaceId,
      });
    }
  });

  it("carries a chosen browser machine through and refuses one this user cannot reach", async () => {
    const current = thread(currentThreadId, nativeHarnessId, "Main", null, {
      capabilityProfileId: "main",
    });
    const freshSummary = {
      access: "full-control" as const,
      activeAttachmentCount: 1,
      attached: true,
      createdAt: now,
      id: createBrowserSessionId(),
      origin: "agent" as const,
      placement: { kind: "runner" as const, runnerId: createId("runner") },
      profileId: null,
      profileName: null,
      runtimeId: "hosted-browser-1",
      state: "ready" as const,
      updatedAt: now,
      workspaceId,
    };
    const openAgentSession = vi.fn(async () => ({ session: freshSummary, wasExisting: false }));
    const { service } = makeService({
      browser: { openAgentSession },
      capabilityProfileId: "main",
      commands: { delegateThread: vi.fn(), enqueueThreadInput: vi.fn() },
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
    ).resolves.toMatchObject({ type: "browser.session.open.result" });
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
    ).rejects.toMatchObject({ code: "bad_request", message: expect.stringContaining("not exist") });

    const { service: unreachable } = makeService({
      browser: { openAgentSession: vi.fn() },
      capabilityProfileId: "main",
      commands: { delegateThread: vi.fn(), enqueueThreadInput: vi.fn() },
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
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("keeps browser profile saves away from delegated and Trigger capability profiles", async () => {
    const current = thread(currentThreadId, nativeHarnessId, "Delegated", null, {
      capabilityProfileId: "delegated",
    });
    const { service } = makeService({
      capabilityProfileId: "delegated",
      commands: { delegateThread: vi.fn(), enqueueThreadInput: vi.fn() },
      messages: [],
      threads: [current],
    });

    await expect(
      service.handle("run-token", {
        reason: "Reuse this portal login next time",
        requestId: crypto.randomUUID(),
        sessionId: createBrowserSessionId(),
        type: "browser.profile.save",
      }),
    ).rejects.toThrow("does not allow browser.profile.save");
  });

  it.each(["main", "workspace"] as const)(
    "admits full access requests from %s before calling the service",
    async (capabilityProfileId) => {
      const current = thread(currentThreadId, nativeHarnessId, "Client", null, {
        capabilityProfileId,
      });
      const request = vi.fn(async () => ({
        kind: "machine.full-disk-access" as const,
        replayed: false,
        requestId: createId("request"),
        status: "pending" as const,
      }));
      const { claims, service, admitAgentControlRequest } = makeService({
        capabilityProfileId,
        machineFullDiskAccess: { request },
        commands: { delegateThread: vi.fn(), enqueueThreadInput: vi.fn() },
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
      ).toMatchObject({ type: "machine.full-disk-access.request.result" });
      expect(request).toHaveBeenCalledWith({
        callId,
        computer: "test-mac",
        reason: "Read Mail",
        claims,
      });
      expect(admitAgentControlRequest.mock.invocationCallOrder[0]).toBeLessThan(
        request.mock.invocationCallOrder[0] ?? 0,
      );
    },
  );

  it("refuses full access requests from delegated agents before admission", async () => {
    const current = thread(currentThreadId, nativeHarnessId, "Delegated", null, {
      capabilityProfileId: "delegated",
    });
    const request = vi.fn();
    const { service, admitAgentControlRequest } = makeService({
      capabilityProfileId: "delegated",
      machineFullDiskAccess: { request },
      commands: { delegateThread: vi.fn(), enqueueThreadInput: vi.fn() },
      messages: [],
      threads: [current],
    });
    await expect(
      service.handle("run-token", {
        type: "machine.full-disk-access.request",
        requestId: crypto.randomUUID(),
        computer: "test-mac",
        reason: "Read Mail",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(request).not.toHaveBeenCalled();
    expect(admitAgentControlRequest).not.toHaveBeenCalled();
  });

  it("scopes browser access requests to the claimed Workspace outside Main", async () => {
    const current = thread(currentThreadId, nativeHarnessId, "Client", null, {
      capabilityProfileId: "workspace",
    });
    const durableRequestId = createId("request");
    const requestAccess = vi.fn(async () => ({
      kind: "browser.access" as const,
      replayed: false,
      requestId: durableRequestId,
      status: "pending" as const,
    }));
    const { claims, service } = makeService({
      browser: { requestAccess },
      capabilityProfileId: "workspace",
      commands: { delegateThread: vi.fn(), enqueueThreadInput: vi.fn() },
      messages: [],
      threads: [current],
    });

    const toolRequestId = crypto.randomUUID();
    await expect(
      service.handle("run-token", {
        reason: "Sign in to the client portal",
        requestId: toolRequestId,
        suggestion: { kind: "new", suggestedName: "Client portal" },
        type: "browser.access.request",
      }),
    ).resolves.toMatchObject({
      result: {
        kind: "browser.access",
        replayed: false,
        requestId: durableRequestId,
        status: "pending",
      },
      type: "browser.access.request.result",
    });
    expect(requestAccess).toHaveBeenCalledWith({
      callId: toolRequestId,
      originatingWorkspaceId: claims.workspaceId,
      ownerId,
      reason: "Sign in to the client portal",
      runId: claims.runId,
      suggestion: { kind: "new", suggestedName: "Client portal" },
      threadId: currentThreadId,
      workspaceId,
    });
    await expect(
      service.handle("run-token", {
        reason: "Sign in to the client portal",
        requestId: crypto.randomUUID(),
        suggestion: { kind: "user_choice" },
        type: "browser.access.request",
        workspaceId: targetWorkspaceId,
      }),
    ).rejects.toThrow("can request browser access only for its Workspace");
    expect(requestAccess).toHaveBeenCalledTimes(1);
  });

  it("denies a delegated Thread the browser authority it cannot expand", async () => {
    const current = thread(currentThreadId, nativeHarnessId, "Delegated", null, {
      capabilityProfileId: "delegated",
    });
    const { service } = makeService({
      capabilityProfileId: "delegated",
      commands: { delegateThread: vi.fn(), enqueueThreadInput: vi.fn() },
      messages: [],
      threads: [current],
    });

    await expect(
      service.handle("run-token", {
        reason: "Sign in to the client portal",
        requestId: crypto.randomUUID(),
        suggestion: { kind: "user_choice" },
        type: "browser.access.request",
      }),
    ).rejects.toThrow("does not allow browser.access.request");
    await expect(
      service.handle("run-token", {
        requestId: crypto.randomUUID(),
        sessionId: createBrowserSessionId(),
        type: "browser.session.close",
      }),
    ).rejects.toThrow("does not allow browser.session.close");
  });

  it("uses Run-stable command idempotency after durable exact-request admission", async () => {
    const current = thread(currentThreadId, nativeHarnessId, "Main");
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
    const { admitAgentControlRequest, claims, service } = makeService({
      commands: { delegateThread: vi.fn(), enqueueThreadInput },
      messages: [],
      threads: [current, target],
    });
    const requestId = crypto.randomUUID();
    const request = {
      content: [{ text: "Please continue", type: "text" as const }],
      delivery: "queue" as const,
      requestId,
      threadId: target.id,
      type: "thread.message" as const,
    };

    await service.handle("first-token", request);
    await service.handle("replacement-token", request);

    expect(admitAgentControlRequest).toHaveBeenCalledTimes(2);
    expect(admitAgentControlRequest.mock.calls[0]?.[0]).toEqual(
      admitAgentControlRequest.mock.calls[1]?.[0],
    );
    expect(admitAgentControlRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "thread.message",
        requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        requestId,
        runId: claims.runId,
        sourceThreadId: claims.threadId,
      }),
    );
    expect(enqueueThreadInput).toHaveBeenCalledTimes(2);
    const firstKey = enqueueThreadInput.mock.calls[0]?.[0].idempotencyKey;
    const secondKey = enqueueThreadInput.mock.calls[1]?.[0].idempotencyKey;
    expect(firstKey).toBe(`agent:${claims.runId}:${requestId}:message`);
    expect(secondKey).toBe(firstKey);
    expect(firstKey).not.toContain(claims.jti);
  });

  it("does not execute an agent mutation when durable admission rejects it", async () => {
    const current = thread(currentThreadId, nativeHarnessId, "Main");
    const target = thread(targetThreadId, codexHarnessId, "Research");
    const enqueueThreadInput = vi.fn();
    const admitAgentControlRequest = vi.fn(async () => {
      throw new OpensteerError({
        code: "conflict",
        message: "Agent-control thread.message request limit reached",
      });
    });
    const { service } = makeService({
      admitAgentControlRequest,
      commands: { delegateThread: vi.fn(), enqueueThreadInput },
      messages: [],
      threads: [current, target],
    });

    await expect(
      service.handle("run-token", {
        content: [{ text: "Please continue", type: "text" }],
        delivery: "queue",
        requestId: crypto.randomUUID(),
        threadId: target.id,
        type: "thread.message",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(enqueueThreadInput).not.toHaveBeenCalled();
  });

  it("admits each split Trigger tool under its own action class", async () => {
    const current = thread(currentThreadId, nativeHarnessId, "Main", null, {
      capabilityProfileId: "main",
    });
    const manage = vi.fn(async () => ({ triggers: [] }));
    const { admitAgentControlRequest, service } = makeService({
      capabilityProfileId: "main",
      commands: { delegateThread: vi.fn(), enqueueThreadInput: vi.fn() },
      messages: [],
      threads: [current],
      triggers: { manage },
    });

    await expect(
      service.handle("run-token", {
        input: { limit: 10, operation: "list" },
        requestId: crypto.randomUUID(),
        tool: "trigger.read",
        type: "trigger.control",
      }),
    ).resolves.toMatchObject({ result: { triggers: [] }, type: "trigger.control.result" });
    await service.handle("run-token", {
      input: { operation: "run", triggerId: createId("trigger") },
      requestId: crypto.randomUUID(),
      tool: "trigger.write",
      type: "trigger.control",
    });

    expect(admitAgentControlRequest.mock.calls.map(([input]) => input.action)).toEqual([
      "trigger.read",
      "trigger.write",
    ]);
  });

  it("derives the Trigger create idempotency key from the Run and request", async () => {
    const current = thread(currentThreadId, nativeHarnessId, "Main", null, {
      capabilityProfileId: "main",
    });
    const manage = vi.fn(async () => ({}));
    const { claims, service } = makeService({
      capabilityProfileId: "main",
      commands: { delegateThread: vi.fn(), enqueueThreadInput: vi.fn() },
      messages: [],
      threads: [current],
      triggers: { manage },
    });
    const requestId = crypto.randomUUID();

    await service.handle("run-token", {
      input: {
        anchorThreadId: current.id,
        idempotencyKey: requestId,
        name: "Nightly report",
        operation: "create",
        program: {
          toolContractVersion: 2,
          language: "javascript",
          source: "export default () => {}",
        },
        source: { kind: "webhook" },
      },
      requestId,
      tool: "trigger.write",
      type: "trigger.control",
    });

    expect(manage).toHaveBeenCalledWith(
      claims.requestedBy,
      expect.objectContaining({
        idempotencyKey: `agent:${claims.runId}:${requestId}:trigger.create`,
      }),
      current.id,
    );
  });

  it.each(["workspace", "delegated"] as const)(
    "allows Trigger tools for the %s capability profile",
    async (capabilityProfileId) => {
      const current = thread(currentThreadId, nativeHarnessId, "Main", null, {
        capabilityProfileId,
      });
      const manage = vi.fn(async () => ({}));
      const { service } = makeService({
        capabilityProfileId,
        commands: { delegateThread: vi.fn(), enqueueThreadInput: vi.fn() },
        messages: [],
        threads: [current],
        triggers: { manage },
      });

      await expect(
        service.handle("run-token", {
          input: { limit: 10, operation: "list" },
          requestId: crypto.randomUUID(),
          tool: "trigger.read",
          type: "trigger.control",
        }),
      ).resolves.toMatchObject({ type: "trigger.control.result" });
      expect(manage).toHaveBeenCalledWith(ownerId, { limit: 10, operation: "list" }, current.id);
    },
  );
});

function makeService(options: {
  browserSources?: ConstructorParameters<typeof AgentControlService>[0]["browserSources"];
  machineFullDiskAccess?: ConstructorParameters<
    typeof AgentControlService
  >[0]["machineFullDiskAccess"];
  admitAgentControlRequest?: ReturnType<typeof vi.fn>;
  browser?: Partial<
    Pick<
      BrowserService,
      | "createProfile"
      | "profileSiteData"
      | "closeAgentSession"
      | "listAgentSessions"
      | "listGrantedProfiles"
      | "openAgentSession"
      | "requestAccess"
      | "requestSaveProfile"
    >
  >;
  capabilityProfileId?: Thread["capabilityProfileId"];
  runnerCapabilities?: readonly string[];
  commands: {
    publishPersonNotification?: ReturnType<typeof vi.fn>;
    delegateThread: ReturnType<typeof vi.fn>;
    enqueueThreadInput: ReturnType<typeof vi.fn>;
  };
  currentMembershipRole?: "collaborator" | "owner";
  createWorkspace?: (input: {
    readonly createdBy: typeof ownerId;
    readonly idempotencyKey: string;
    readonly kind: "specialized";
    readonly name: string;
  }) => Promise<Workspace>;
  disconnectedEnvironmentId?: EnvironmentId;
  disabledHarnessId?: HarnessInstanceId;
  environments?: readonly EnvironmentId[];
  existingDelegation?: {
    assignment: { id: string };
    readonly input: ThreadInput;
    readonly message: Message;
    readonly run: Run;
    readonly thread: Thread;
  };
  foreignEnvironmentId?: EnvironmentId;
  harnessCatalog?: HarnessInstanceCatalog | null;
  messages: readonly Message[];
  listHarnessInstances?: OpensteerStore["listHarnessInstances"];
  mountWorkspace?: AgentWorkspaceMountService["mount"];
  onWorkspaceEvent?: (event: AgentEvent) => void;
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
  workspaces?: readonly Workspace[];
}) {
  const claims = {
    aud: "opensteer-agent-control" as const,
    bindingGeneration: 1,
    capabilityProfileId: options.capabilityProfileId ?? ("main" as const),
    environmentId,
    exp: Math.floor(Date.now() / 1_000) + 60,
    iat: Math.floor(Date.now() / 1_000),
    iss: "opensteer-host" as const,
    jti: crypto.randomUUID(),
    membershipGeneration: 1,
    requestedBy: ownerId,
    runId: createId("run"),
    runnerBootId: "boot-1",
    runnerId,
    threadId: currentThreadId,
    workspaceId,
  };
  const authenticate = vi.fn(async () => claims);
  const environments = options.environments ?? [environmentId];
  const workspaces = options.workspaces ?? [workspace(workspaceId, "Main workspace")];
  const workspaceOwner = (id: Thread["workspaceId"]) =>
    workspaces.find((candidate) => candidate.id === id)?.createdBy;
  const workspaceSnapshot = vi.fn(async () => ({
    events: [],
    messages: options.messages,
    sequence: 0,
    threads: options.threads,
    workspace: {},
  }));
  const admitAgentControlRequest =
    options.admitAgentControlRequest ??
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
      scope: { kind: string; threadId?: Thread["id"]; workspaceId?: Thread["workspaceId"] };
      workspaceId?: Thread["workspaceId"];
    }) => {
      const lineage = input.scope.threadId ? lineageIds(input.scope.threadId) : null;
      const visible = options.threads
        .filter((candidate) => workspaceOwner(candidate.workspaceId) === input.ownerId)
        .filter(
          (candidate) =>
            input.scope.kind !== "workspace" || candidate.workspaceId === input.scope.workspaceId,
        )
        .filter((candidate) => !lineage || lineage.includes(candidate.id))
        .filter((candidate) => !input.workspaceId || candidate.workspaceId === input.workspaceId)
        .filter(
          (candidate) =>
            !input.query || candidate.title.toLowerCase().includes(input.query.toLowerCase()),
        )
        .map((candidate) => ({
          environmentId: candidate.environmentId,
          id: candidate.id,
          parentThreadId: candidate.parentThreadId,
          pendingRequests: candidate.pendingRequests,
          status: candidate.status,
          title: candidate.title,
          updatedAt: candidate.updatedAt,
          workspaceId: candidate.workspaceId,
          workspaceName:
            workspaces.find((workspace) => workspace.id === candidate.workspaceId)?.name ??
            "Unknown",
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
  const store = {
    listThreadAssignmentsForOwner: async () => ({
      assignments: [],
      window: { byteCount: 0, hasMore: false, itemCount: 0, nextBefore: null, totalItems: 0 },
    }),
    admitAgentControlRequest,
    agentThreadLineage: vi.fn(async (threadId: Thread["id"]) => lineageIds(threadId)),
    agentThreadPageForOwner,
    runnerCapabilities: async () => options.runnerCapabilities ?? [],
    environmentIsAvailableToUser: vi.fn(
      async (id: EnvironmentId) => environments.includes(id) && id !== options.foreignEnvironmentId,
    ),
    findDelegatedThreadByIdempotency: vi.fn(async () => options.existingDelegation ?? null),
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
      return value && workspaceOwner(value.workspaceId) === requestedBy ? value : null;
    },
    getWorkspaceForOwner: async (id: Workspace["id"], requestedBy: typeof ownerId) =>
      workspaces.find((candidate) => candidate.id === id && candidate.createdBy === requestedBy) ??
      null,
    workspaceMembershipForUser: async (id: Workspace["id"], requestedBy: typeof ownerId) => {
      const candidate = workspaces.find(
        (workspace) => workspace.id === id && workspace.createdBy === requestedBy,
      );
      if (!candidate) return null;
      return {
        generation: 1,
        id: createId("workspaceMembership"),
        invitedBy: null,
        joinedAt: now,
        role: options.currentMembershipRole ?? ("owner" as const),
        state: "active" as const,
        userId: requestedBy,
        workspaceId: candidate.id,
      };
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
      options.threads.filter((candidate) => workspaceOwner(candidate.workspaceId) === requestedBy),
    listWorkspacesForOwner: async (requestedBy: typeof ownerId) =>
      workspaces.filter((candidate) => candidate.createdBy === requestedBy),
    ownerThreadPageForOwner: async (input: { maxItems: number; ownerId: typeof ownerId }) => {
      const values = options.threads
        .filter((candidate) => workspaceOwner(candidate.workspaceId) === input.ownerId)
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
      if (!value || workspaceOwner(value.workspaceId) !== input.ownerId) return null;
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
    workspacePageForOwner: async (input: { maxItems: number; ownerId: typeof ownerId }) => {
      const values = workspaces
        .filter((candidate) => candidate.createdBy === input.ownerId)
        .slice(0, input.maxItems);
      return {
        window: {
          byteCount: Buffer.byteLength(JSON.stringify(values), "utf8"),
          hasMore: false,
          itemCount: values.length,
          nextBefore: null,
          totalItems: values.length,
        },
        workspaces: values,
      };
    },
    workspaceSnapshot,
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
  const tokens = { authenticate } as unknown as AgentControlTokenService;
  const unexpectedBrowserRequest = async () => {
    throw new Error("Unexpected browser request");
  };
  const wakeWorkspace = vi.fn(async () => undefined);
  const commands = {
    publishPersonNotification: options.commands.publishPersonNotification,
    withInputAdmission: async <T>(_owner: string, _key: string, operation: () => Promise<T>) =>
      operation(),
    delegateAdmittedThread: async (
      operation: Parameters<CommandService["delegateAdmittedThread"]>[0],
    ) => {
      await (admitAgentControlRequest as (input: unknown) => Promise<unknown>)(
        operation.admission.request,
      );
      return (options.commands.delegateThread as (input: unknown) => Promise<unknown>)(
        operation.input,
      ) as ReturnType<CommandService["delegateAdmittedThread"]>;
    },
    enqueueAdmittedThreadInput: async (
      operation: Parameters<CommandService["enqueueAdmittedThreadInput"]>[0],
    ) => {
      await (admitAgentControlRequest as (input: unknown) => Promise<unknown>)(
        operation.admission.request,
      );
      return (options.commands.enqueueThreadInput as (input: unknown) => Promise<unknown>)(
        operation.input,
      ) as ReturnType<CommandService["enqueueAdmittedThreadInput"]>;
    },
  } as unknown as CommandService;
  return {
    admitAgentControlRequest,
    agentThreadPageForOwner,
    authenticate,
    claims,
    listEnvironmentsForUser,
    wakeWorkspace,
    service: new AgentControlService({
      browserSources: options.browserSources ?? { agentSignIn: unexpectedBrowserRequest },
      machineFullDiskAccess: options.machineFullDiskAccess ?? { request: vi.fn() },
      browser: {
        createProfile: options.browser?.createProfile ?? unexpectedBrowserRequest,
        profileSiteData: options.browser?.profileSiteData ?? unexpectedBrowserRequest,
        closeAgentSession: options.browser?.closeAgentSession ?? unexpectedBrowserRequest,
        listAgentSessions: options.browser?.listAgentSessions ?? unexpectedBrowserRequest,
        listGrantedProfiles: options.browser?.listGrantedProfiles ?? unexpectedBrowserRequest,
        openAgentSession: options.browser?.openAgentSession ?? unexpectedBrowserRequest,
        requestAccess: options.browser?.requestAccess ?? unexpectedBrowserRequest,
        requestSaveProfile: options.browser?.requestSaveProfile ?? unexpectedBrowserRequest,
      },
      canRunHarness: (_environment, driverKind) =>
        options.unavailableHarnessId === undefined ||
        driverKind !== (options.unavailableHarnessId === nativeHarnessId ? "native" : "codex"),
      commands,
      isEnvironmentConnected: (id) =>
        environments.includes(id) && id !== options.disconnectedEnvironmentId,
      onWorkspaceEvent: options.onWorkspaceEvent ?? vi.fn(),
      store,
      tokens,
      ...(options.triggers === undefined ? {} : { triggers: options.triggers }),
      defaultWorkspaceBacking: "portablefs",
      environmentWorkspaceBackings: () => ["portablefs"] as const,
      workspaceMounts: {
        mount:
          options.mountWorkspace ??
          vi.fn(async ({ workspace }: { workspace: Workspace }) => ({
            path: `workspaces/${workspace.id}`,
          })),
      },
      workspaceWake: { wake: wakeWorkspace },
      workspaces: {
        create:
          options.createWorkspace ??
          vi.fn(async () => {
            throw new Error("Unexpected Workspace creation");
          }),
      },
    }),
    workspaceSnapshot,
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
    originatingWorkspaceId: workspaceId,
    payload: {
      kind: "browser.access",
      reason: "Use the signed-in client portal",
      suggestion: { kind: "user_choice" },
    },
    presentation: {
      kind: "external",
      subject: { id: workspaceId, kind: "workspace" },
      title: "Browser profile access",
    },
    requestedBy: ownerId,
    requiredActor: "requester",
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    status: "pending",
    targetWorkspaceId: workspaceId,
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
  models: readonly { readonly isDefault: boolean; readonly modelId: string }[] = [
    { isDefault: true, modelId: "gpt-5.6-sol" },
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
          values: [{ label: "Low", value: "low" }],
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
    Pick<Thread, "capabilityProfileId" | "createdBy" | "environmentId" | "workspaceId">
  > = {},
): Thread {
  return {
    accessMode: "full-access",
    capabilityProfileId: parentThreadId ? "delegated" : "main",
    continuationIdentity: null,
    doneAt: null,
    icon: null,
    role: "work",
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
    workspaceId,
    ...overrides,
  };
}

function workspace(
  id: Workspace["id"],
  name: string,
  createdBy: Workspace["createdBy"] = ownerId,
): Workspace {
  return {
    backing: {
      generation: 1,
      kind: "portablefs",
      serviceId: "test-portablefs",
      volumeId: `pfs_${id}`,
    },
    capacityPolicy: {
      blockHardLimitBytes: 10_000_000,
      inodeHardLimit: 10_000,
      kind: "hard-quota",
    },
    createdAt: now,
    createdBy,
    homeThreadId: null,
    icon: null,
    id,
    kind: id === workspaceId ? "main" : "specialized",
    name,
    status: "ready",
    storageIssue: null,
    updatedAt: now,
  };
}

function run(value: Thread): Run {
  const seedInputId = createId("message");
  return {
    accessMode: value.accessMode,
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
    content: [{ text, type: "text" }],
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

it("uses authenticated admission for a person notification without waking work", async () => {
  const messageId = createId("message");
  const publishPersonNotification = vi.fn(async () => ({
    message: { id: messageId },
    events: [],
    wasDuplicate: false,
  }));
  const fixture = makeService({
    runnerCapabilities: ["person-notify-v1"],
    commands: { publishPersonNotification, delegateThread: vi.fn(), enqueueThreadInput: vi.fn() },
    messages: [],
    threads: [thread(currentThreadId, nativeHarnessId, "Main")],
  });
  const requestId = crypto.randomUUID();
  await expect(
    fixture.service.handle("run-token", { type: "person.notify", requestId, message: "Ready." }),
  ).resolves.toEqual({ type: "person.notify.result", requestId, messageId });
  expect(publishPersonNotification).toHaveBeenCalledWith({
    message: "Ready.",
    admission: expect.objectContaining({
      action: "person.notify",
      requestedBy: fixture.claims.requestedBy,
      sourceThreadId: fixture.claims.threadId,
      runId: fixture.claims.runId,
      requestId,
    }),
  });
  expect(fixture.wakeWorkspace).not.toHaveBeenCalled();
});

it("omits client-only addressing from agent thread history", async () => {
  const current = thread(currentThreadId, nativeHarnessId, "Main");
  const original = message(current.id, null, "Published milestone");
  const addressed = { ...original, addressedToUserId: ownerId };
  const fixture = makeService({
    commands: { delegateThread: vi.fn(), enqueueThreadInput: vi.fn() },
    messages: [addressed],
    threads: [current],
  });
  const response = await fixture.service.handle("run-token", {
    type: "thread.read",
    requestId: crypto.randomUUID(),
    threadId: current.id,
  });
  expect(response).toMatchObject({ type: "thread.read.result", messages: [original] });
  if (response.type !== "thread.read.result") throw new Error("Wrong response");
  expect(response.messages[0]).not.toHaveProperty("addressedToUserId");
});
