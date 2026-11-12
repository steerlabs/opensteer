import { expect, it } from "vitest";
import { createId } from "@opensteer/core";
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
    folderSkillsDigest: "home:folder",
    workspacePath: "/task",
    writableRoots: ["/task", "/agent-home"],
  };
  const before = warmEngineKey(input);
  context.agentTools.token = "rotated";
  expect(warmEngineKey(input)).toBe(before);
  for (const change of [
    { ...input, instructions: "Changed home instructions" },
    { ...input, folderSkillsDigest: "home:changed" },
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
