import { createId } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import {
  ProjectCapabilityScopeSchema,
  ProjectExecuteRunSchema,
  ProjectExecuteTriggerSchema,
  ProjectReconcileWatchesSchema,
} from "./project-execution.js";
import { runnerCommandMaxSerializedBytes } from "./runner-execution.js";
import { RunnerCommandSchema } from "./runner.js";

const workspaceId = createId("workspace");
const environmentId = createId("environment");
const authority = {
  version: 1,
  principal: { kind: "project", principalId: "principal:project:test", workspaceId },
  origin: null,
};
const context = {
  accessMode: "full-access",
  assignment: null,
  threadRole: "work",
  threadState: { previousAssignment: null, previousRun: null },
  agentTools: {
    tools: [],
    toolsRevision: "test",
    instructions: "",
    skills: [],
    token: "test",
    url: "https://fixture.invalid/mcp",
  },
  bindingGeneration: 1,
  executionLeaseMs: 90_000,
  egress: {
    maxRequestBytes: 1024,
    maxResponseBytes: 1024,
    relayToken: "test",
    relayUrl: "https://fixture.invalid/egress",
  },
  environmentId,
  harness: {
    config: {},
    driverKind: "codex",
    name: "Codex",
    runtimeRevision: 1,
    sourceId: "openai",
    stateKind: "isolated",
  },
  harnessInstanceId: createId("harnessInstance"),
  history: [],
  historyWindow: { byteCount: 0, hasEarlier: false, itemCount: 0 },
  modelSelection: { modelId: "test", providerId: "openai", options: {} },
  initialContext: null,
  providerSessionId: createId("providerSession"),
  providerSessionReference: null,
  providerSessionStateLayout: "session",
  runId: createId("run"),
  threadId: createId("thread"),
  workspaceId,
  workspaceKind: "project",
  workspaceInstructionsPath: null,
  workspaceAccess: {
    generation: 1,
    kind: "local-directory",
    bindingId: createId("workspaceBinding"),
    ownerEnvironmentId: environmentId,
    storageAuthorityId: createId("storageAuthority"),
    workspaceId,
  },
  authority,
  projectSettingsRevision: 1,
  projectTimeZone: "UTC",
};
const command = {
  type: "run.execute.project",
  commandId: createId("command"),
  correlationId: createId("command"),
  environmentId,
  context,
  inputs: [
    {
      author: { kind: "human", principalId: "principal:test", displayName: "Test" },
      content: [{ type: "text", text: "test" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      kind: "input",
      messageId: createId("message"),
    },
  ],
  reports: { messages: [], omittedCount: 0, throughSequence: null },
};

describe("dormant Project execution", () => {
  it("binds Project storage, roots and environments without changing the legacy command union", () => {
    expect(ProjectExecuteRunSchema.parse(command)).toEqual(command);
    expect(
      ProjectExecuteRunSchema.safeParse({
        ...command,
        context: {
          ...context,
          authority: {
            ...authority,
            origin: {
              userId: createId("user"),
              initiatorGeneration: 1,
              membershipGeneration: 2,
              originConnectionId: "connection",
            },
          },
        },
      }).success,
    ).toBe(true);
    for (const changed of [
      { browserCdp: { url: "https://fixture.invalid/cdp" } },
      { plugins: { versions: [], token: "test", url: "https://fixture.invalid/plugins" } },
      { specialistId: "personal-specialist" },
      { requestedBy: createId("user") },
      { membershipGeneration: 1 },
      { machineAccess: { machines: [] } },
      { voiceCall: {} },
      { requesterTimeZone: "UTC" },
      { workspaceId: createId("workspace") },
      { environmentId: createId("environment") },
      { workspaceKind: "main" },
      { harness: { ...context.harness, driverKind: "native" } },
      { harness: { ...context.harness, stateKind: "native-user" } },
    ])
      expect(
        ProjectExecuteRunSchema.safeParse({ ...command, context: { ...context, ...changed } })
          .success,
      ).toBe(false);
    expect(RunnerCommandSchema.safeParse(command).success).toBe(false);
    expect(RunnerCommandSchema.safeParse({ ...command, type: "run.execute" }).success).toBe(false);
    expect(
      ProjectExecuteRunSchema.safeParse({ ...command, environmentId: createId("environment") })
        .success,
    ).toBe(false);
  });

  it("requires every live binding fence and refuses user and cross-Project scope", () => {
    const scope = {
      authority,
      bindingGeneration: 1,
      environmentId,
      grantId: createId("grant"),
      runId: context.runId,
      runnerBootId: "boot",
      runnerId: createId("runner"),
      threadId: context.threadId,
      workspaceId,
    };
    expect(ProjectCapabilityScopeSchema.parse(scope)).toEqual(scope);
    for (const key of Object.keys(scope))
      expect(
        ProjectCapabilityScopeSchema.safeParse(
          Object.fromEntries(Object.entries(scope).filter(([field]) => field !== key)),
        ).success,
      ).toBe(false);
    expect(
      ProjectCapabilityScopeSchema.safeParse({ ...scope, workspaceId: createId("workspace") })
        .success,
    ).toBe(false);
    expect(
      ProjectCapabilityScopeSchema.safeParse({ ...scope, requestedBy: createId("user") }).success,
    ).toBe(false);
    expect(
      ProjectCapabilityScopeSchema.safeParse({
        ...scope,
        authority: undefined,
        requestedBy: createId("user"),
        membershipGeneration: 1,
      }).success,
    ).toBe(false);
  });
});

const triggerId = createId("trigger");
const revisionId = createId("triggerRevision");
const occurrenceId = createId("triggerOccurrence");
const envelope = { authority, projectSettingsRevision: 1, projectTimeZone: "UTC" };
const programContext = {
  anchorThreadId: context.threadId,
  event: {
    id: occurrenceId,
    payload: null,
    receivedAt: "2026-01-01T00:00:00.000Z",
    source: { kind: "schedule", scheduledFor: "2026-01-01T00:00:00.000Z" },
    trigger: { id: triggerId, revisionId, anchorThreadId: context.threadId, workspaceId },
  },
  executionGeneration: 1,
  mcp: { token: "project-program-token", url: "https://fixture.invalid/mcp" },
  occurrenceId,
  program: { language: "javascript", source: "return null;", toolContractVersion: 3 },
  revisionId,
  triggerId,
  workspaceId,
  workspaceAccess: context.workspaceAccess,
  ...envelope,
};
const programCommand = {
  commandId: createId("command"),
  correlationId: createId("command"),
  environmentId,
  type: "trigger.execute.project",
  context: programContext,
};
const activation = {
  activationId: createId("triggerWatchActivation"),
  anchorThreadId: context.threadId,
  capabilities: { mcp: { ...programContext.mcp, expiresAt: "2026-01-02T00:00:00.000Z" } },
  executionGeneration: 1,
  revisionId,
  triggerId,
  workspaceAccess: context.workspaceAccess,
  workspaceId,
  ...envelope,
};
const reconcile = {
  commandId: createId("command"),
  correlationId: createId("command"),
  environmentId,
  type: "watch.reconcile.project",
  desired: [activation],
  reconcileGeneration: 1,
};

describe("dormant Project programs", () => {
  it("binds the Trigger event and Project storage without admitting private credentials or legacy commands", () => {
    expect(ProjectExecuteTriggerSchema.parse(programCommand)).toEqual(programCommand);
    const human = {
      userId: createId("user"),
      membershipGeneration: 1,
      initiatorGeneration: 2,
      originConnectionId: null,
    };
    expect(
      ProjectExecuteTriggerSchema.safeParse({
        ...programCommand,
        context: { ...programContext, authority: { ...authority, origin: human } },
      }).success,
    ).toBe(true);
    for (const changed of [
      { browserCdp: null },
      { plugins: {} },
      { specialistId: "personal" },
      { createdBy: createId("user") },
      { requestedBy: createId("user") },
      { membershipGeneration: 1 },
      { authority: undefined },
      { workspaceId: createId("workspace") },
      { triggerId: createId("trigger") },
      { revisionId: createId("triggerRevision") },
      { occurrenceId: createId("triggerOccurrence") },
      { anchorThreadId: createId("thread") },
    ])
      expect(
        ProjectExecuteTriggerSchema.safeParse({
          ...programCommand,
          context: { ...programContext, ...changed },
        }).success,
      ).toBe(false);
    expect(
      ProjectExecuteTriggerSchema.safeParse({
        ...programCommand,
        environmentId: createId("environment"),
      }).success,
    ).toBe(false);
    expect(
      ProjectExecuteTriggerSchema.safeParse({
        ...programCommand,
        context: {
          ...programContext,
          event: { ...programContext.event, payload: "x".repeat(runnerCommandMaxSerializedBytes) },
        },
      }).success,
    ).toBe(false);
    expect(RunnerCommandSchema.safeParse(programCommand).success).toBe(false);
    expect(
      RunnerCommandSchema.safeParse({ ...programCommand, type: "trigger.execute" }).success,
    ).toBe(false);
  });

  it("binds each Watch activation, refuses Browser plans and duplicate identities, and permits an empty stop batch", () => {
    expect(ProjectReconcileWatchesSchema.parse(reconcile)).toEqual(reconcile);
    expect(ProjectReconcileWatchesSchema.safeParse({ ...reconcile, desired: [] }).success).toBe(
      true,
    );
    const otherWorkspaceId = createId("workspace");
    const otherActivation = {
      ...activation,
      activationId: createId("triggerWatchActivation"),
      triggerId: createId("trigger"),
      revisionId: createId("triggerRevision"),
      anchorThreadId: createId("thread"),
      workspaceId: otherWorkspaceId,
      authority: {
        ...authority,
        principal: {
          ...authority.principal,
          workspaceId: otherWorkspaceId,
          principalId: "principal:project:other",
        },
      },
      workspaceAccess: { ...activation.workspaceAccess, workspaceId: otherWorkspaceId },
    };
    expect(
      ProjectReconcileWatchesSchema.safeParse({
        ...reconcile,
        desired: [activation, otherActivation],
      }).success,
    ).toBe(true);
    expect(
      ProjectReconcileWatchesSchema.safeParse({
        ...reconcile,
        desired: [
          {
            ...activation,
            capabilities: {
              mcp: {
                ...activation.capabilities.mcp,
                url: "https://fixture.invalid/" + "x".repeat(runnerCommandMaxSerializedBytes),
              },
            },
          },
        ],
      }).success,
    ).toBe(false);
    for (const changed of [
      { capabilities: { ...activation.capabilities, browserCdp: null } },
      { authority: undefined },
      { createdBy: createId("user") },
      { membershipGeneration: 1 },
      { workspaceId: createId("workspace") },
      { workspaceAccess: { ...context.workspaceAccess, workspaceId: createId("workspace") } },
      {
        workspaceAccess: {
          ...context.workspaceAccess,
          ownerEnvironmentId: createId("environment"),
        },
      },
    ])
      expect(
        ProjectReconcileWatchesSchema.safeParse({
          ...reconcile,
          desired: [{ ...activation, ...changed }],
        }).success,
      ).toBe(false);
    expect(
      ProjectReconcileWatchesSchema.safeParse({ ...reconcile, desired: [activation, activation] })
        .success,
    ).toBe(false);
    expect(RunnerCommandSchema.safeParse(reconcile).success).toBe(false);
    expect(RunnerCommandSchema.safeParse({ ...reconcile, type: "watch.reconcile" }).success).toBe(
      false,
    );
  });
});
