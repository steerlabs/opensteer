import { createId } from "@opensteer/core";
import { expect, it, vi } from "vitest";
import type { ProjectCaller } from "./agent-caller.js";
import { ProductToolHandlers, ProjectProductToolHandlers } from "./handlers/product.js";
import { OpensteerMcpService } from "./opensteer-mcp-service.js";

it("refuses Project subagent selectors and unimplemented tools before any authority or target query", async () => {
  const query = vi.fn(() => {
    throw new Error("A refused Project selector must not query");
  });
  const checkLive = vi.fn(async () => {
    query();
  });
  const caller = {
    kind: "project",
    accessMode: "full-access",
    reach: { kind: "workspace", workspaceId: createId("workspace") },
    claims: {},
  } as ProjectCaller;
  const project = new ProjectProductToolHandlers({
    work: { resolveProjectCaller: query, database: { selectFrom: query } },
    publish: () => {},
    environmentConnected: () => true,
  } as unknown as ConstructorParameters<typeof ProjectProductToolHandlers>[0]);
  const human = new ProductToolHandlers({
    store: { database: { selectFrom: query } },
  } as unknown as ConstructorParameters<typeof ProductToolHandlers>[0]);
  const selector = { subagentId: createId("executionNode") };
  const service = new OpensteerMcpService({
    callers: { authenticate: query },
    handlers: {},
    store: { database: { selectFrom: query } },
    publicUrl: new URL("https://project.test.invalid"),
  } as unknown as ConstructorParameters<typeof OpensteerMcpService>[0]);
  const marker = `header.${Buffer.from(JSON.stringify({ aud: "opensteer-project-run-tools" })).toString("base64url")}.signature`;
  for (const name of ["thread_read", "task_cancel"] as const) {
    await expect(
      project.call({ caller, name, input: selector, operationKey: "refused", checkLive }),
    ).rejects.toMatchObject({ code: "forbidden", reason: "project-subagent-not-supported" });
    await expect(
      service.callTool(marker, name, selector, { operationKey: "refused" }),
    ).rejects.toMatchObject({ code: "forbidden", reason: "project-subagent-not-supported" });
  }
  await expect(
    human.assignmentTargets({ caller, input: selector } as unknown as Parameters<
      ProductToolHandlers["assignmentTargets"]
    >[0]),
  ).rejects.toMatchObject({ code: "forbidden", reason: "project-subagent-not-supported" });
  for (const name of ["orchestrator_capabilities", "thread_wait", "pending_request"] as const) {
    await expect(
      project.call({ caller, name, input: {}, operationKey: "refused", checkLive }),
    ).rejects.toMatchObject({ code: "forbidden", reason: "project-tool-not-supported" });
  }
  await expect(
    project.call({
      caller,
      name: "delegate_task",
      input: { task: "Task", mode: "wait" },
      operationKey: "refused",
      checkLive,
    }),
  ).rejects.toMatchObject({ code: "forbidden", reason: "project-wait-not-supported" });
  expect(checkLive).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
  await service.close();
});
