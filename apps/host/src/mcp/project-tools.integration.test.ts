import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createId, ThreadIdSchema } from "@opensteer/core";
import { describeStore } from "@opensteer/database/test-support/store";
import { prepareProjectAdmission } from "@opensteer/database/test-support/project";
import { assertActiveProjectBinding, readProjectRunBinding } from "@opensteer/database";
import { expect } from "vitest";
import { SignedTokenService } from "../identity/host-keys.js";
import { ProjectCapabilityTokenService } from "../agents/run-capability.js";
import { ProjectCallerResolver } from "./agent-caller.js";
import { OpensteerMcpService } from "./opensteer-mcp-service.js";
import { ProjectProductToolHandlers } from "./handlers/product.js";
import type { AgentToolHandlers } from "./handlers/index.js";

describeStore("Project MCP tools", (it) => {
  it("acts as its Project through signed MCP authority, pages shared history and cancels only its own child task", async ({
    storeFixture,
  }) => {
    const {
      database,
      store: work,
      prepared,
      project,
      origin,
    } = await prepareProjectAdmission(storeFixture, true);
    const grant = await database
      .selectFrom("grants")
      .select("id")
      .where("runId", "=", prepared.run.id)
      .executeTakeFirstOrThrow();
    const original = await readProjectRunBinding(database, {
      runId: prepared.run.id,
      grantId: grant.id,
    });
    if (!original) throw new Error("Fixture has no Project binding");
    const binding = original.binding;
    const deployment = await database
      .selectFrom("deployments")
      .select(["id", "activeHostInstanceId"])
      .executeTakeFirstOrThrow();
    if (!deployment.activeHostInstanceId) throw new Error("Fixture has no Host");
    const capabilities = new ProjectCapabilityTokenService({
      tokens: new SignedTokenService(generateKeyPairSync("ed25519"), {
        deploymentId: deployment.id,
        hostInstanceId: deployment.activeHostInstanceId,
      }),
      authorizer: {
        assertProjectBinding: async (scope) => {
          await assertActiveProjectBinding(database, scope, { runnerIsAttached: () => true });
        },
      },
    });
    const resolver = new ProjectCallerResolver({
      capabilities,
      resolve: (scope) => work.resolveProjectCaller(scope),
    });
    const token = await capabilities.issue(binding, "opensteer-project-run-tools");
    const caller = await resolver.authenticate(token);
    expect(caller).toMatchObject({
      kind: "project",
      principal: binding.authority.principal,
      origin,
      reach: { kind: "workspace", workspaceId: project.workspace.id },
    });
    expect(caller).not.toHaveProperty("userId");
    const published: string[] = [];
    let legacyCalls = 0;
    const legacy = new Proxy(
      {},
      {
        get() {
          legacyCalls += 1;
          throw new Error("Project work reached a legacy human handler");
        },
      },
    ) as unknown as AgentToolHandlers;
    const service = new OpensteerMcpService({
      callers: resolver,
      handlers: legacy,
      projectTools: new ProjectProductToolHandlers({
        work,
        publish: (events) => published.push(...events.map((event) => event.type)),
        environmentConnected: () => true,
      }),
      store: storeFixture.store,
      publicUrl: new URL("https://project.test.invalid"),
    });
    const call = (name: string, input: object, operationKey = randomUUID()) =>
      service.callTool(token, name, input, { operationKey });
    try {
      await expect(call("request_list", {})).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        call("thread_list", { workspaceId: createId("workspace") }),
      ).rejects.toMatchObject({ code: "forbidden" });
      const key = randomUUID();
      const first = await call(
        "thread_delegate",
        { title: "First child", task: "First objective" },
        key,
      );
      expect(typeof first).toBe("object");
      if (
        typeof first !== "object" ||
        typeof first.assignmentId !== "string" ||
        typeof first.threadId !== "string"
      )
        throw new Error("Task output has no identity");
      expect(
        await call("thread_delegate", { title: "First child", task: "First objective" }, key),
      ).toEqual(first);
      const second = await call("thread_delegate", {
        title: "Second child",
        task: "Second objective",
      });
      if (typeof second !== "object") throw new Error("Second task output is invalid");
      expect(first.assignmentId).not.toBe(second.assignmentId);
      expect(
        await database
          .selectFrom("threads")
          .select(["createdBy", "createdByPrincipalId"])
          .where("id", "=", ThreadIdSchema.parse(first.threadId))
          .executeTakeFirstOrThrow(),
      ).toEqual({ createdBy: project.userId, createdByPrincipalId: project.principalId });
      const page = await call("thread_list", { parentThreadId: "self", limit: 1 });
      if (typeof page !== "object") throw new Error("Thread list output is invalid");
      expect(page).toMatchObject({ hasMore: true });
      const next = await call("thread_list", {
        parentThreadId: "self",
        limit: 1,
        before: page.nextBefore,
      });
      if (typeof next !== "object") throw new Error("Next Thread list output is invalid");
      expect(next).toMatchObject({ hasMore: false });
      expect(JSON.stringify(page.threads)).not.toBe(JSON.stringify(next.threads));
      await call("thread_message", {
        threadId: first.threadId,
        message: "First published report",
        delivery: "report",
      });
      await call("thread_message", {
        threadId: first.threadId,
        message: "Second published report",
        delivery: "report",
      });
      const read = await call("thread_read", { threadId: first.threadId, limit: 1 });
      if (typeof read !== "object") throw new Error("Thread read output is invalid");
      expect(read).toMatchObject({ hasMore: true });
      expect(JSON.stringify(read.items)).toContain("Second published report");
      const earlier = await call("thread_read", {
        threadId: first.threadId,
        limit: 1,
        before: read.nextBefore,
      });
      expect(JSON.stringify(earlier)).toContain("First published report");
      const activity = await call("thread_read", {
        threadId: first.threadId,
        view: "activity",
        limit: 1,
      });
      expect(JSON.stringify(activity)).toContain("Second published report");
      expect(await call("task_cancel", { assignmentId: first.assignmentId })).toMatchObject({
        status: "cancelled",
      });
      expect(await call("task_status", { assignmentId: second.assignmentId })).toMatchObject({
        status: "open",
      });
      expect(
        (
          await database
            .selectFrom("runs")
            .select("status")
            .where("id", "=", binding.runId)
            .executeTakeFirstOrThrow()
        ).status,
      ).toBe("running");
      expect(published).toContain("assignment.updated");
      expect(legacyCalls).toBe(0);
      await database
        .updateTable("users")
        .set({ authorityGeneration: "2" })
        .where("id", "=", project.userId)
        .execute();
      await expect(call("thread_list", {})).rejects.toMatchObject({ code: "forbidden" });
      expect(legacyCalls).toBe(0);
    } finally {
      await service.close();
    }
  });
});
