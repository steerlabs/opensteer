import {
  createId,
  ModelSelectionSchema,
  OpensteerError,
  type EnvironmentId,
  type Message,
  type Run,
  type Thread,
  type ThreadInput,
  type Workspace,
} from "@opensteer/core";
import type { OpensteerStore, TriggerControlAdmissionResult } from "@opensteer/database";
import type { CommandService } from "@opensteer/orchestration";
import type { TriggerControlInput } from "@opensteer/triggers";
import { describe, expect, it, vi } from "vitest";
import {
  TriggerControlService,
  type TriggerControlTokenService,
} from "./trigger-control-service.js";

const now = "2026-08-12T12:00:00.000Z";
const ownerId = createId("user");
const runnerId = createId("runner");
const environmentId = createId("environment");
const workspaceId = createId("workspace");
const threadId = createId("thread");
const harnessInstanceId = createId("harnessInstance");
const modelSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: { effort: "low" },
  providerId: "openai",
});

describe("TriggerControlService", () => {
  it("admits Workspace and Thread requests, not just the Trigger tools", async () => {
    const { admitTriggerControlRequest, occurrenceId, service } = makeService({});
    const requestId = crypto.randomUUID();

    await service.handle("trigger-token", { requestId, type: "workspace.inspect" });

    expect(admitTriggerControlRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "workspace.inspect",
        environmentId,
        executionGeneration: 1,
        occurrenceId,
        requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
        requestId,
        requestedBy: ownerId,
        runnerId,
        threadId,
        workspaceId,
      }),
    );
  });

  it("admits a queued Thread message against the Occurrence ledger", async () => {
    const anchor = thread();
    const queued = run(anchor);
    const queuedMessage = message(anchor.id, queued.id);
    const enqueueThreadInput = vi.fn(async () => ({
      disposition: "run-queued" as const,
      input: inboxInput(queuedMessage, queued, "queue"),
      message: queuedMessage,
      run: queued,
    }));
    const { admitTriggerControlRequest, occurrenceId, service } = makeService({
      commands: { enqueueThreadInput } as unknown as CommandService,
    });
    const requestId = crypto.randomUUID();

    await service.handle("trigger-token", {
      content: [{ text: "Status?", type: "text" }],
      delivery: "queue",
      requestId,
      threadId,
      type: "thread.message",
    });

    expect(admitTriggerControlRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "thread.message",
        environmentId,
        executionGeneration: 1,
        occurrenceId,
        requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
        requestId,
        requestedBy: ownerId,
        runnerId,
        threadId,
        workspaceId,
      }),
    );
    expect(enqueueThreadInput).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `trigger:${occurrenceId}:${requestId}:message`,
        policy: "queue",
        source: { kind: "trigger", occurrenceId },
      }),
    );
  });

  it("preserves version 1 Trigger message delivery semantics", async () => {
    const anchor = thread();
    const targetRun = run(anchor);
    const delivered = message(anchor.id, targetRun.id);
    const enqueueThreadInput = vi.fn(async () => ({
      disposition: "pending" as const,
      input: inboxInput(delivered, targetRun, "report"),
      message: delivered,
      run: null,
    }));
    const { service } = makeService({
      commands: { enqueueThreadInput } as unknown as CommandService,
      toolContractVersion: 1,
    });

    await service.handle("trigger-token", {
      content: [{ text: "Passive status", type: "text" }],
      delivery: "queue",
      requestId: crypto.randomUUID(),
      threadId,
      type: "thread.message",
    });
    expect(enqueueThreadInput).toHaveBeenCalledWith(expect.objectContaining({ policy: "report" }));

    await service.handle("trigger-token", {
      content: [{ text: "Run the child", type: "text" }],
      delivery: "trigger",
      requestId: crypto.randomUUID(),
      threadId,
      type: "thread.message",
    });
    expect(enqueueThreadInput).toHaveBeenLastCalledWith(
      expect.objectContaining({ policy: "queue" }),
    );
  });

  it("refuses a delegation once the Occurrence delegation budget is spent", async () => {
    const delegateThread = vi.fn(async () => {
      throw new Error("Unexpected Thread creation");
    });
    const { service } = makeService({
      admitTriggerControlRequest: async () => {
        throw new OpensteerError({
          code: "resource_exhausted",
          message: "Trigger-control thread.delegate request limit of 8 was reached",
        });
      },
      commands: { delegateThread } as unknown as CommandService,
    });

    await expect(
      service.handle("trigger-token", {
        requestId: crypto.randomUUID(),
        task: "Keep delegating forever",
        type: "thread.delegate",
        workspaceId,
      }),
    ).rejects.toMatchObject({ code: "resource_exhausted" });
    expect(delegateThread).not.toHaveBeenCalled();
  });

  it("places delegated work in an explicitly selected available environment", async () => {
    const targetEnvironmentId = createId("environment");
    const targetHarnessId = createId("harnessInstance");
    const selectedHarnessId = createId("harnessInstance");
    const targetWorkspace = {
      ...workspace(workspaceId, "Portable workspace"),
      backing: {
        generation: 1,
        kind: "portablefs" as const,
        serviceId: "test-portablefs",
        volumeId: `pfs_${workspaceId}`,
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota" as const,
      },
    };
    const delegateThread = vi.fn(async () => {
      throw new Error("Delegation reached the selected environment");
    });
    const { service } = makeService({
      commands: { delegateThread } as unknown as CommandService,
      store: {
        environmentIsAvailableToUser: vi.fn(async () => true),
        getEnvironment: vi.fn(async () => environment(targetEnvironmentId)),
        getHarnessCatalog: vi.fn(async () => ({
          detail: "Ready",
          models: [
            {
              isDefault: true,
              modelId: "gpt-5.6-sol",
              options: [
                {
                  id: "effort",
                  label: "Reasoning",
                  type: "select",
                  values: [{ label: "Low", value: "low" }],
                },
              ],
              providerId: "openai",
            },
          ],
          status: "ready",
        })),
        getHarnessInstance: vi.fn(async () => ({
          config: {},
          createdAt: now,
          driverKind: "native" as const,
          enabled: true,
          id: targetHarnessId,
          name: "Opensteer",
        })),
        getWorkspaceForOwner: vi.fn(async () => targetWorkspace),
        listHarnessInstances: vi.fn(async () => [
          {
            config: {},
            createdAt: now,
            driverKind: "native" as const,
            enabled: true,
            id: targetHarnessId,
            name: "Opensteer",
          },
          {
            config: {},
            createdAt: now,
            driverKind: "native" as const,
            enabled: true,
            id: selectedHarnessId,
            name: "Opensteer isolated",
          },
        ]),
      },
    });

    await expect(
      service.handle("trigger-token", {
        environmentId: targetEnvironmentId,
        harnessInstanceId: selectedHarnessId,
        requestId: crypto.randomUUID(),
        task: "Run this elsewhere",
        type: "thread.delegate",
        workspaceId,
      }),
    ).rejects.toThrow("Delegation reached the selected environment");
    expect(delegateThread).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: targetEnvironmentId,
        harnessInstanceId: selectedHarnessId,
        task: [{ text: "Run this elsewhere", type: "text" }],
      }),
    );
  });

  it("derives the Trigger create idempotency key from the Occurrence and request", async () => {
    const manage = vi.fn(async () => ({}));
    const { occurrenceId, service } = makeService({ manage });
    const requestId = crypto.randomUUID();

    await service.handle("trigger-token", {
      input: {
        anchorThreadId: threadId,
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
      ownerId,
      expect.objectContaining({
        idempotencyKey: `trigger:${occurrenceId}:${requestId}:trigger.create`,
      }),
      threadId,
    );
  });

  it("refuses a Trigger control request once its Occurrence write budget is spent", async () => {
    const manage = vi.fn(async () => ({}));
    const { service } = makeService({
      admitTriggerControlRequest: async () => {
        throw new OpensteerError({
          code: "resource_exhausted",
          message: "Trigger-control trigger.write request limit of 32 was reached",
        });
      },
      manage,
    });

    await expect(
      service.handle("trigger-token", {
        input: { operation: "run", triggerId: createId("trigger") },
        requestId: crypto.randomUUID(),
        tool: "trigger.write",
        type: "trigger.control",
      }),
    ).rejects.toMatchObject({ code: "resource_exhausted" });
    expect(manage).not.toHaveBeenCalled();
  });
});

function makeService(options: {
  admitTriggerControlRequest?: () => Promise<TriggerControlAdmissionResult>;
  commands?: CommandService;
  create?: (input: {
    readonly createdBy: typeof ownerId;
    readonly idempotencyKey: string;
    readonly kind: "specialized";
    readonly name: string;
  }) => Promise<Workspace>;
  listEnvironmentsForUser?: (
    userId: typeof ownerId,
    limit: number,
  ) => Promise<readonly ReturnType<typeof environment>[]>;
  manage?: (owner: typeof ownerId, input: TriggerControlInput) => Promise<unknown>;
  store?: Readonly<Record<string, unknown>>;
  toolContractVersion?: 1 | 2;
}) {
  const anchor = thread();
  const claims = {
    aud: "opensteer-trigger-control" as const,
    environmentId,
    executionGeneration: 1,
    exp: Math.floor(Date.now() / 1_000) + 60,
    iat: Math.floor(Date.now() / 1_000),
    iss: "opensteer-host" as const,
    jti: crypto.randomUUID(),
    occurrenceId: createId("triggerOccurrence"),
    requestedBy: ownerId,
    runnerBootId: "boot-1",
    runnerId,
    threadId,
    toolContractVersion: options.toolContractVersion ?? 2,
    workspaceId,
  };
  const listEnvironmentsForUser = vi.fn(
    options.listEnvironmentsForUser ?? (async () => [environment(environmentId)]),
  );
  const admitTriggerControlRequest = vi.fn(
    options.admitTriggerControlRequest ??
      (async () => ({ actionClass: "trigger.read", wasDuplicate: false })),
  );
  const store = {
    admitTriggerControlRequest,
    findDelegatedThreadByIdempotency: vi.fn(async () => null),
    getEnvironment: vi.fn(async () => environment(environmentId)),
    getHarnessInstance: vi.fn(async () => ({
      config: {},
      createdAt: now,
      driverKind: "native" as const,
      enabled: true,
      id: harnessInstanceId,
      name: "Opensteer",
    })),
    getThreadForOwner: vi.fn(async () => anchor),
    getWorkspaceForOwner: vi.fn(async () => workspace(workspaceId, "Scheduled workspace")),
    listEnvironmentsForUser,
    listHarnessCatalogs: vi.fn(async () => []),
    listHarnessInstances: vi.fn(async () => [
      harness(harnessInstanceId, environmentId, "Opensteer"),
    ]),
    ownerThreadPageForOwner: vi.fn(async () => ({
      threads: [anchor],
      window: windowFor([anchor]),
    })),
    workspacePageForOwner: vi.fn(async () => ({
      window: windowFor([]),
      workspaces: [],
    })),
    ...options.store,
  } as unknown as OpensteerStore;
  store.listAgentHarnessInstancesForUser = vi.fn(async (requestedBy, input = {}) => {
    const visible = await listEnvironmentsForUser(requestedBy, 65);
    const rows = await store.listHarnessInstances({ environmentIds: visible.map(({ id }) => id) });
    return rows
      .filter((row) => row.enabled && row.removedAt == null)
      .filter((row) => input.id === undefined || row.id === input.id)
      .filter((row) => input.afterId === undefined || row.id > input.afterId)
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, input.limit ?? 65);
  });
  const tokens = {
    authenticate: vi.fn(async () => claims),
  } as unknown as TriggerControlTokenService;
  const commands = {
    delegateAdmittedThread: async (
      operation: Parameters<CommandService["delegateAdmittedThread"]>[0],
    ) => {
      await (admitTriggerControlRequest as (input: unknown) => Promise<unknown>)(
        operation.admission.request,
      );
      const delegateThread = (
        options.commands as unknown as
          | {
              delegateThread?: CommandService["delegateThread"];
            }
          | undefined
      )?.delegateThread;
      if (!delegateThread) throw new Error("Unexpected Thread delegation");
      return delegateThread(operation.input);
    },
    enqueueAdmittedThreadInput: async (
      operation: Parameters<CommandService["enqueueAdmittedThreadInput"]>[0],
    ) => {
      await (admitTriggerControlRequest as (input: unknown) => Promise<unknown>)(
        operation.admission.request,
      );
      const enqueueThreadInput = (
        options.commands as unknown as
          | {
              enqueueThreadInput?: CommandService["enqueueThreadInput"];
            }
          | undefined
      )?.enqueueThreadInput;
      if (!enqueueThreadInput) throw new Error("Unexpected Thread message");
      return enqueueThreadInput(operation.input);
    },
  } as CommandService;
  return {
    admitTriggerControlRequest,
    occurrenceId: claims.occurrenceId,
    service: new TriggerControlService({
      defaultWorkspaceBacking: "local-directory",
      canRunHarness: () => true,
      commands,
      environmentWorkspaceBackings: () => ["portablefs"] as const,
      isEnvironmentConnected: () => true,
      store,
      tokens,
      triggers: {
        manage:
          options.manage ??
          vi.fn(async () => {
            throw new Error("Unexpected Trigger management");
          }),
      },
      workspaces: {
        create:
          options.create ??
          vi.fn(async () => {
            throw new Error("Unexpected Workspace creation");
          }),
      },
    }),
  };
}

function environment(id: EnvironmentId) {
  return {
    capabilities: ["filesystem"] as const,
    id,
    kind: "main" as const,
    name: "Main Runner",
    runnerId,
  };
}

function harness(
  id: ReturnType<typeof createId<"harnessInstance">>,
  profileEnvironmentId: EnvironmentId,
  name: string,
) {
  return {
    config: {},
    createdAt: now,
    driverKind: "native" as const,
    enabled: true,
    environmentId: profileEnvironmentId,
    id,
    name,
    removedAt: null,
    runtimeRevision: 1,
    stateKind: "ambient" as const,
  };
}

function thread(): Thread {
  return {
    accessMode: "full-access",
    capabilityProfileId: "main",
    continuationIdentity: null,
    doneAt: null,
    icon: null,
    role: "work",
    createdAt: now,
    createdBy: ownerId,
    environmentId,
    harnessInstanceId,
    inputQueuePaused: false,
    id: threadId,
    lineageRootThreadId: threadId,
    listed: true,
    modelSelection,
    parentThreadId: null,
    pendingRequests: 0,
    providerSessionId: null,
    status: "idle",
    title: "Scheduled task",
    updatedAt: now,
    workspaceId,
  };
}

function run(value: Thread): Run {
  const seedInputId = createId("message");
  return {
    accessMode: value.accessMode,
    activationInputId: seedInputId,
    assignmentId: null,
    causalChainId: createId("causalChain"),
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
    replyTarget: null,
    runOrdinal: 0,
    seedInputId,
  };
}

function message(anchorThreadId: Thread["id"], runId: Run["id"]): Message {
  return {
    author: {
      displayName: "Scheduled task",
      kind: "trigger",
      occurrenceId: createId("triggerOccurrence"),
      source: "schedule",
      triggerId: createId("trigger"),
    },
    content: [{ text: "Status?", type: "text" }],
    createdAt: now,
    id: createId("message"),
    kind: "input",
    runId,
    sequence: "1" as Message["sequence"],
    threadId: anchorThreadId,
  };
}

function inboxInput(value: Message, run: Run, policy: "report" | "queue" | "steer"): ThreadInput {
  return {
    assignmentId: null,
    cancelReason: null,
    causalChainId: run.causalChainId,
    createdAt: now,
    deliveredAt: now,
    messageId: value.id,
    policy,
    replyTarget: null,
    runId: run.id,
    state: "claimed",
    threadId: value.threadId,
    updatedAt: now,
  };
}

function workspace(id: Workspace["id"], name: string): Workspace {
  return {
    backing: {
      bindingId: createId("workspaceBinding"),
      generation: 1,
      kind: "local-directory",
      ownerEnvironmentId: environmentId,
      storageAuthorityId: createId("storageAuthority"),
    },
    capacityPolicy: { kind: "host-filesystem" },
    createdAt: now,
    createdBy: ownerId,
    homeThreadId: null,
    icon: null,
    id,
    kind: "specialized",
    name,
    status: "ready",
    storageIssue: null,
    updatedAt: now,
  };
}

function windowFor(values: readonly unknown[]) {
  return {
    byteCount: Buffer.byteLength(JSON.stringify(values), "utf8"),
    hasMore: false,
    itemCount: values.length,
    nextBefore: null,
    totalItems: values.length,
  };
}
