import { mcpToolCallId } from "../integrations/mcp-call-id.js";
import { TriggerToolsTestClient } from "../mcp/product-tools.test-support.js";
import {
  createId,
  ModelSelectionSchema,
  type EnvironmentId,
  type Message,
  type Run,
  type Thread,
  type ThreadInput,
} from "@opensteer/core";
import type { OpensteerStore, TriggerControlAdmissionResult } from "@opensteer/database";
import type { CommandService } from "@opensteer/orchestration";
import type { TriggerControlInput } from "@opensteer/triggers";
import { describe, expect, it, vi } from "vitest";
import { type TriggerControlTokenService } from "./trigger-control-service.js";
vi.mock("@opensteer/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@opensteer/database")>()),
  readAgentThreadRecent: async () => ({
    runs: [],
    places: [],
  }),
}));
const now = "2026-08-12T12:00:00.000Z";
const ownerId = createId("user");
const runnerId = createId("runner");
const environmentId = createId("environment");
const folder = { computerId: runnerId, path: "/tmp/trigger-fixture" };
const threadId = createId("thread");
const harnessInstanceId = createId("harnessInstance");
const modelSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: {
    effort: "low",
  },
  providerId: "openai",
});
describe("TriggerControlService", () => {
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
      commands: {
        enqueueThreadInput,
      } as unknown as CommandService,
    });
    const requestId = crypto.randomUUID();
    await service.handle("trigger-token", {
      content: [
        {
          text: "Status?",
          type: "text",
        },
      ],
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
        requestId: mcpToolCallId(`trigger:${occurrenceId}`, requestId, "operation", "thread_send"),
        requestedBy: ownerId,
        runnerId,
        threadId,
      }),
    );
    expect(enqueueThreadInput).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `trigger:${occurrenceId}:${mcpToolCallId(`trigger:${occurrenceId}`, requestId, "operation", "thread_send")}:message`,
        policy: "queue",
        source: {
          kind: "trigger",
          occurrenceId,
        },
      }),
    );
  });
  it("places delegated work in its admitted folder with the selected harness", async () => {
    const targetEnvironmentId = environmentId;
    const targetHarnessId = createId("harnessInstance");
    const selectedHarnessId = createId("harnessInstance");
    const delegateThread = vi.fn(async () => {
      throw new Error("Delegation reached the selected environment");
    });
    const { service } = makeService({
      commands: {
        delegateThread,
      } as unknown as CommandService,
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
                  values: [
                    {
                      label: "Low",
                      value: "low",
                    },
                  ],
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
        harnessInstanceId: selectedHarnessId,
        requestId: crypto.randomUUID(),
        task: "Run this elsewhere",
        type: "thread.delegate",
      }),
    ).rejects.toThrow("Delegation reached the selected environment");
    expect(delegateThread).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: targetEnvironmentId,
        harnessInstanceId: selectedHarnessId,
        folder,
        task: [
          {
            text: "Run this elsewhere",
            type: "text",
          },
        ],
      }),
    );
  });
  it("derives the Trigger create idempotency key from the Occurrence and request", async () => {
    const manage = vi.fn(async () => ({}));
    const { occurrenceId, service } = makeService({
      manage,
    });
    const requestId = crypto.randomUUID();
    await service.handle("trigger-token", {
      input: {
        anchorThreadId: threadId,
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
      ownerId,
      expect.objectContaining({
        idempotencyKey: `trigger:${occurrenceId}:${mcpToolCallId(`trigger:${occurrenceId}`, requestId, "operation", "trigger_write")}:trigger.create`,
      }),
      threadId,
      {
        accessMode: "full-access",
        operationKey: `trigger:${occurrenceId}:${mcpToolCallId(`trigger:${occurrenceId}`, requestId, "operation", "trigger_write")}:trigger.write`,
      },
    );
  });
  it("finds managed memory passes by system role", async () => {
    const manage = vi.fn(async () => ({
      triggers: [],
    }));
    const { service } = makeService({
      manage,
    });
    await service.handle("trigger-token", {
      input: {
        limit: 1,
        operation: "list",
        systemRole: "memory-light",
      },
      requestId: crypto.randomUUID(),
      tool: "trigger.read",
      type: "trigger.control",
    });
    expect(manage).toHaveBeenCalledWith(
      ownerId,
      {
        limit: 1,
        operation: "list",
        systemRole: "memory-light",
      },
      threadId,
      expect.anything(),
    );
  });
});
function makeService(options: {
  admitTriggerControlRequest?: () => Promise<TriggerControlAdmissionResult>;
  commands?: CommandService;
  listEnvironmentsForUser?: (
    userId: typeof ownerId,
    limit: number,
  ) => Promise<readonly ReturnType<typeof environment>[]>;
  manage?: (owner: typeof ownerId, input: TriggerControlInput) => Promise<unknown>;
  store?: Readonly<Record<string, unknown>>;
  toolContractVersion?: 3;
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
    toolContractVersion: options.toolContractVersion ?? 3,
  };
  const listEnvironmentsForUser = vi.fn(
    options.listEnvironmentsForUser ?? (async () => [environment(environmentId)]),
  );
  const admitTriggerControlRequest = vi.fn(
    options.admitTriggerControlRequest ??
      (async () => ({
        actionClass: "trigger.read",
        wasDuplicate: false,
      })),
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
    listEnvironmentsForUser,
    listHarnessCatalogs: vi.fn(async () => []),
    listHarnessInstances: vi.fn(async () => [
      harness(harnessInstanceId, environmentId, "Opensteer"),
    ]),
    ownerThreadPageForOwner: vi.fn(async () => ({
      threads: [anchor],
      window: windowFor([anchor]),
    })),
    ...options.store,
  } as unknown as OpensteerStore;
  store.listAgentHarnessInstancesForUser = vi.fn(async (requestedBy, input = {}) => {
    const visible = await listEnvironmentsForUser(requestedBy, 65);
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
    service: new TriggerToolsTestClient({
      browser: {
        readablePlaces: async () => [],
      } as never,
      canRunHarness: () => true,
      commands,
      isEnvironmentConnected: () => true,
      store,
      tokens,
      onEvent: () => {},
      folders: {
        resolve: async (_owner, chosen) => ({ folder: chosen ?? folder, environmentId }),
        canExecute: (id) => id === environmentId,
      },
      triggers: {
        manage:
          options.manage ??
          vi.fn(async () => {
            throw new Error("Unexpected Trigger management");
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
    continuationIdentity: null,
    doneAt: null,
    doneReason: null,
    icon: null,
    purpose: "task",
    folder,
    teamOrigin: null,
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
  };
}
function run(value: Thread): Run {
  const seedInputId = createId("message");
  return {
    accessMode: value.accessMode,
    activationInputId: seedInputId,
    assignmentId: null,
    teamRequestId: null,
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
    content: [
      {
        text: "Status?",
        type: "text",
      },
    ],
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
    teamRequestId: null,
    cancelReason: null,
    causalChainId: run.causalChainId,
    createdAt: now,
    deliveredAt: now,
    teamSource: null,
    messageId: value.id,
    policy,
    replyTarget: null,
    runId: run.id,
    state: "claimed",
    threadId: value.threadId,
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
