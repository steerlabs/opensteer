import { createId } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { ProjectCapabilityScopeSchema, ProjectExecuteRunSchema } from "./project-execution.js";
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
  browserCdp: { url: "https://fixture.invalid/cdp" },
  plugins: { versions: [], token: "test", url: "https://fixture.invalid/plugins" },
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
