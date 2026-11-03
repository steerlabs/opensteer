import { OpensteerError } from "@opensteer/core";
import { describeStore } from "./store.integration.test-support.js";
import { AgentOperationReceipts } from "./agent-control-admission-receipts.js";
import { expect, vi } from "vitest";
import { createHash } from "node:crypto";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
describeStore("MCP operation receipts", (it) => {
  it("rechecks the source and target access modes in the domain receipt transaction", async ({
    storeFixture,
  }) => {
    const { store, database } = storeFixture;
    const source = await storeFixture.startRunFixture("mcp-receipt-modes");
    const { thread: target } = await store.createThread({
      accessMode: "full-access",
      createdBy: source.userId,
      environmentId: source.environmentId,
      harnessInstanceId: source.harnessInstance.id,
      idempotencyKey: "mcp-receipt-mode-target",
      modelSelection: source.thread.modelSelection,
      title: "Target",
      workspaceId: source.workspace.id,
    });
    await database
      .updateTable("threads")
      .set({ accessMode: "auto" })
      .where("id", "=", source.thread.id)
      .execute();
    const input = {
      action: "thread.message" as const,
      accessMode: "auto" as const,
      targetThreadIds: [target.id],
      bindingGeneration: source.bindingGeneration,
      environmentId: source.environmentId,
      membershipGeneration: 1,
      requestedBy: source.userId,
      requestFingerprint: digest("mode-input"),
      requestId: crypto.randomUUID(),
      runId: source.run.id,
      runnerBootId: source.runnerBootId,
      runnerId: source.runnerId,
      sourceThreadId: source.thread.id,
      workspaceId: source.workspace.id,
    };
    await expect(store.admitRunToolCall(input)).rejects.toMatchObject({
      code: "forbidden",
    });
    await database
      .updateTable("threads")
      .set({ accessMode: "auto" })
      .where("id", "=", target.id)
      .execute();
    await expect(store.admitRunToolCall(input)).resolves.toMatchObject({
      wasDuplicate: false,
    });
    await database
      .updateTable("threads")
      .set({ accessMode: "approval-required" })
      .where("id", "=", source.thread.id)
      .execute();
    await expect(store.admitRunToolCall(input)).rejects.toMatchObject({
      code: "forbidden",
    });
  });
  it("recovers the committed person_message result after losing the outer receipt response", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("mcp-person-result-recovery");
    const receipts = new AgentOperationReceipts(storeFixture.database);
    const admission = {
      action: "person.message" as const,
      bindingGeneration: f.bindingGeneration,
      environmentId: f.environmentId,
      membershipGeneration: 1,
      requestedBy: f.userId,
      requestFingerprint: digest("recover-message"),
      requestId: crypto.randomUUID(),
      runId: f.run.id,
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
      sourceThreadId: f.thread.id,
      workspaceId: f.workspace.id,
    };
    const publish = async () => ({
      messageId: (
        await storeFixture.store.publishPersonMessage({ admission, message: "Saved result" })
      ).message.id,
    });
    const recover = vi.fn(publish);
    const input = {
      callerKey: `run:${f.run.id}`,
      operationKey: "recover-message",
      tool: "person_message",
      fingerprint: digest("recover-message"),
      check: async () => {},
      invoke: vi.fn(async () => {
        await publish();
        throw new Error("Outer receipt response was lost");
      }),
      recover,
    };
    await expect(receipts.execute(input)).rejects.toThrow("Outer receipt response was lost");
    const stored = await publish();
    await expect(receipts.execute(input)).resolves.toEqual(stored);
    await expect(receipts.execute(input)).resolves.toEqual(stored);
    expect(input.invoke).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(
      await storeFixture.database
        .selectFrom("messages")
        .select("id")
        .where("addressedToUserId", "=", f.userId)
        .execute(),
    ).toHaveLength(1);
  });
  it("persists an exact result across store recreation, rejects conflicting input and rechecks replay authority", async ({
    storeFixture,
  }) => {
    const first = new AgentOperationReceipts(storeFixture.database);
    const invoke = vi.fn(async () => ({ messageId: "stable-result" }));
    let live = true;
    const input = {
      callerKey: "run:receipt-test",
      operationKey: "stable",
      tool: "person_message",
      fingerprint: digest("first"),
      check: async () => {
        if (!live)
          throw new OpensteerError({ code: "forbidden", message: "Run grant was revoked" });
      },
      invoke,
    };
    expect(await first.execute(input)).toEqual({ messageId: "stable-result" });
    const restarted = new AgentOperationReceipts(storeFixture.database);
    expect(await restarted.execute(input)).toEqual({ messageId: "stable-result" });
    expect(invoke).toHaveBeenCalledTimes(1);
    await expect(
      restarted.execute({ ...input, fingerprint: digest("different") }),
    ).rejects.toMatchObject({ code: "conflict" });
    live = false;
    await expect(restarted.execute(input)).rejects.toMatchObject({ code: "forbidden" });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("namespaces keys by caller and tool and does not repeat an unconfirmed effect", async ({
    storeFixture,
  }) => {
    const receipts = new AgentOperationReceipts(storeFixture.database);
    const input = {
      callerKey: "program:first",
      operationKey: "same",
      tool: "integration_call",
      fingerprint: digest("input"),
      check: async () => {},
      invoke: vi.fn(async () => ({ done: true })),
    };
    await receipts.execute(input);
    await receipts.execute({ ...input, callerKey: "program:second" });
    await receipts.execute({ ...input, tool: "other" });
    expect(input.invoke).toHaveBeenCalledTimes(3);
    const failed = {
      ...input,
      operationKey: "unconfirmed",
      invoke: vi.fn(async () => {
        throw new Error("Provider response was lost");
      }),
    };
    await expect(receipts.execute(failed)).rejects.toThrow("response was lost");
    await expect(receipts.execute(failed)).rejects.toMatchObject({
      code: "conflict",
      retryable: true,
    });
    expect(failed.invoke).toHaveBeenCalledTimes(1);
  });
});
