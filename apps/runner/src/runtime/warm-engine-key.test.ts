import { expect, it } from "vitest";
import { createId, ModelIdSchema, SequenceSchema, TeamSourceSchema } from "@opensteer/core";
import { warmEngineKey } from "./warm-engine-pool.js";
it("invalidates warm reuse for tool inventory, instructions, roots and discovered skills while preserving per-Run credential rebinding", () => {
  const context = {
    threadId: createId("thread"),
    requestedBy: createId("user"),
    harnessInstanceId: createId("harnessInstance"),
    harness: { driverKind: "codex" },
    providerSessionId: createId("providerSession"),
    providerSessionStateLayout: "thread",
    accessMode: "full-access",
    taskPurpose: "task",
    modelSelection: { modelId: "test", providerId: "test", options: {} },
    plugins: { versions: [] },
    agentTools: {
      toolsRevision: "v1",
      tools: ["thread_read"],
      instructions: "Task guide",
      skills: ["opensteer:memory"],
      url: "http://127.0.0.1/mcp",
      token: "first",
    },
    browserCdp: { url: "http://127.0.0.1/cdp" },
  } as unknown as Parameters<typeof warmEngineKey>[0]["context"];
  const input = {
    context,
    attachmentRoot: null,
    baseEnvironment: {},
    instructions: "Agent home instructions",
    machineAccessLaunch: "",
    providerSessionReference: null,
    runtimeBoundary: "native-user",
    skills: undefined,
    homeSkillsDigest: "home:folder",
    workspacePath: "/task",
    writableRoots: ["/task", "/agent-home"],
  };
  const before = warmEngineKey(input);
  const teamTurnContext = {
    kind: "team" as const,
    source: TeamSourceSchema.parse({
      teamId: createId("deployment"),
      channelId: createId("teamChannel"),
      threadRootId: "1",
      messageId: "2",
      audience: {
        teamName: "Acme",
        channelName: "Support",
        channelKind: "public",
        memberCount: 12,
        peopleOnly: false,
      },
    }),
    instructionsMarkdown: "Current channel configuration",
    instructionsRevision: SequenceSchema.parse("1"),
  };
  const team = { ...input, context: { ...context, teamTurnContext } };
  const privateTurn = {
    ...input,
    context: { ...context, teamTurnContext: { kind: "private" as const } },
  };
  expect(warmEngineKey(team)).toBe(warmEngineKey(privateTurn));
  expect(warmEngineKey(team)).toBe(before);
  const effortInput = {
    ...input,
    perTurnEffortOption: "effort",
    context: {
      ...context,
      modelSelection: { ...context.modelSelection, options: { effort: "high" } },
    },
  };
  expect(warmEngineKey(effortInput)).toBe(
    warmEngineKey({ ...input, perTurnEffortOption: "effort" }),
  );
  expect(warmEngineKey({ ...effortInput, perTurnEffortOption: undefined })).not.toBe(before);
  expect(
    warmEngineKey({
      ...effortInput,
      context: {
        ...effortInput.context,
        modelSelection: { ...context.modelSelection, options: { effort: "high", speed: "fast" } },
      },
    }),
  ).not.toBe(warmEngineKey(effortInput));
  context.agentTools.token = "rotated";
  expect(warmEngineKey(input)).toBe(before);
  for (const change of [
    { ...input, baseEnvironment: { MODE: "changed" } },
    { ...input, runtimeBoundary: "isolated-service" },
    { ...input, providerSessionReference: "different-thread" },
    { ...input, context: { ...context, harnessInstanceId: createId("harnessInstance") } },
    {
      ...input,
      context: {
        ...context,
        modelSelection: {
          ...context.modelSelection,
          modelId: ModelIdSchema.parse("different-model"),
        },
      },
    },
    { ...input, instructions: "Changed home instructions" },
    { ...input, homeSkillsDigest: "home:changed" },
    { ...input, writableRoots: ["/task", "/another-home"] },
    {
      ...input,
      context: {
        ...context,
        agentTools: { ...context.agentTools, instructions: "Changed channel instructions" },
      },
    },
    {
      ...input,
      context: {
        ...context,
        agentTools: { ...context.agentTools, tools: [...context.agentTools.tools, "team_read"] },
      },
    },
  ])
    expect(warmEngineKey(change)).not.toBe(before);
});
