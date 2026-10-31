import { createId, ModelSelectionSchema } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import { describe, expect, it, vi } from "vitest";
import { KeyedAdmissionQueue } from "./admission-queue.js";
import { CommandService } from "./command-service.js";

/*
 * Cancelling an Assignment changes its worker Thread and every Thread below it.
 * Failure mode: the cancellation runs ahead of a message sent earlier to one of
 * those Threads, which then lands after the cancellation as new, unassigned
 * work.
 */
describe("command ordering across an Assignment", () => {
  it("re-admits cancellation after an in-flight delegation adds a descendant", async () => {
    const worker = createId("thread");
    const grandchild = createId("thread");
    const environmentId = createId("environment");
    const order: string[] = [];
    let subtree = [worker];
    let releaseDelegation!: () => void;
    const delegationHeld = new Promise<void>((resolve) => {
      releaseDelegation = resolve;
    });
    let finishDelegation!: () => void;
    const committedDelegationHeld = new Promise<void>((resolve) => {
      finishDelegation = resolve;
    });
    let releaseMessage!: () => void;
    const messageHeld = new Promise<void>((resolve) => {
      releaseMessage = resolve;
    });
    const store = {
      assignmentTreeThreadIds: vi.fn(async () => [...subtree]),
      delegateThread: vi.fn(async () => {
        order.push("delegation start");
        await delegationHeld;
        subtree = [worker, grandchild];
        order.push("delegation committed");
        await committedDelegationHeld;
        return { events: [], run: { environmentId }, wasDuplicate: false };
      }),
      cancelAssignment: vi.fn(async () => {
        order.push("cancel");
        return { events: [], interruptCommands: [] };
      }),
      enqueueThreadInput: vi.fn(async () => {
        order.push("message start");
        await messageHeld;
        order.push("message end");
        return { command: null, events: [], wasDuplicate: false };
      }),
    } as unknown as OpensteerStore;
    const admission = new KeyedAdmissionQueue({
      maxInFlight: 4,
      maxQueuedBytes: 1_000_000,
      maxQueuedCommands: 10,
    });
    const commands = new CommandService({
      admission,
      onExecutionQueued: vi.fn(),
      onWorkspaceEvent: vi.fn(),
      store,
    });
    const delegation = commands.delegateThread({
      accessMode: "auto",
      createdBy: createId("user"),
      environmentId,
      harnessInstanceId: createId("harnessInstance"),
      idempotencyKey: "delegate",
      modelSelection: ModelSelectionSchema.parse({
        modelId: "test",
        options: {},
        providerId: "openai",
      }),
      origin: { kind: "run", parentRunId: createId("run"), parentThreadId: worker },
      task: [{ type: "text", text: "Delegate" }],
      title: "Descendant",
      workspaceId: createId("workspace"),
    });
    await vi.waitFor(() => expect(order).toEqual(["delegation start"]));
    const cancellation = commands.cancelAssignment({
      assignmentId: createId("delegation"),
      idempotencyKey: "cancel",
      requestedBy: createId("user"),
    });
    await vi.waitFor(() => expect(admission.queuedCommands).toBe(1));
    releaseDelegation();
    await vi.waitFor(() => expect(order).toContain("delegation committed"));
    // The descendant exists, but publishing the delegation still holds its parent's key.
    const message = commands.enqueueThreadInput({
      content: [{ text: "One more thing", type: "text" }],
      idempotencyKey: "earlier-message",
      policy: "queue",
      requestedBy: createId("user"),
      source: { kind: "human" },
      threadId: grandchild,
    });
    await vi.waitFor(() => expect(order).toContain("message start"));
    finishDelegation();
    await delegation;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const beforeRelease = [...order];
    releaseMessage();
    await Promise.all([message, cancellation]);
    expect(beforeRelease).toEqual(["delegation start", "delegation committed", "message start"]);
    expect(order).toEqual([
      "delegation start",
      "delegation committed",
      "message start",
      "message end",
      "cancel",
    ]);
    expect(store.assignmentTreeThreadIds).toHaveBeenCalledTimes(3);
  });

  it("cancels an Assignment only after earlier commands for its Threads", async () => {
    const worker = createId("thread");
    const grandchild = createId("thread");
    const assignmentId = createId("delegation");
    const order: string[] = [];
    let releaseMessage!: () => void;
    const messageHeld = new Promise<void>((resolve) => {
      releaseMessage = resolve;
    });
    const store = {
      assignmentTreeThreadIds: vi.fn(async () => [worker, grandchild]),
      cancelAssignment: vi.fn(async () => {
        order.push("cancel");
        return { events: [], interruptCommands: [] };
      }),
      enqueueThreadInput: vi.fn(async () => {
        order.push("message start");
        await messageHeld;
        order.push("message end");
        return { command: null, events: [], wasDuplicate: false };
      }),
    } as unknown as OpensteerStore;
    const commands = new CommandService({
      admission: new KeyedAdmissionQueue({
        maxInFlight: 4,
        maxQueuedBytes: 1_000_000,
        maxQueuedCommands: 10,
      }),
      onExecutionQueued: vi.fn(),
      onWorkspaceEvent: vi.fn(),
      store,
    });

    const message = commands.enqueueThreadInput({
      content: [{ text: "One more thing", type: "text" }],
      idempotencyKey: "earlier-message",
      policy: "queue",
      requestedBy: createId("user"),
      source: { kind: "human" },
      threadId: grandchild,
    });
    await vi.waitFor(() => expect(order).toEqual(["message start"]));
    const cancellation = commands.cancelAssignment({
      assignmentId,
      idempotencyKey: "cancel",
      requestedBy: createId("user"),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["message start"]);

    releaseMessage();
    await Promise.all([message, cancellation]);
    expect(order).toEqual(["message start", "message end", "cancel"]);
  });
});

describe("committed input hooks", () => {
  it("registers only a new commit before publication and wakeup, and cannot fail durable work", async () => {
    const order: string[] = [];
    let duplicate = false;
    const environmentId = createId("environment");
    const store = {
      enqueueThreadInput: vi.fn(async () => {
        order.push("commit");
        return {
          events: [{ workspaceId: createId("workspace") }],
          command: { environmentId },
          wasDuplicate: duplicate,
        };
      }),
    } as unknown as OpensteerStore;
    const admission = new KeyedAdmissionQueue({
      maxInFlight: 1,
      maxQueuedBytes: 10000,
      maxQueuedCommands: 4,
    });
    const commands = new CommandService({
      store,
      admission,
      onWorkspaceEvent: () => {
        order.push("publish");
      },
      onExecutionQueued: () => {
        order.push("wake");
      },
    });
    const input = {
      content: [{ text: "Hello", type: "text" as const }],
      idempotencyKey: "commit-hook",
      policy: "queue" as const,
      requestedBy: createId("user"),
      source: { kind: "human" as const },
      threadId: createId("thread"),
    };
    const onCommitted = vi.fn(() => {
      order.push("context");
      throw new Error("Interaction ended");
    });
    try {
      await expect(commands.enqueueThreadInput(input, { onCommitted })).resolves.toMatchObject({
        wasDuplicate: false,
      });
      expect(order).toEqual(["commit", "context", "publish", "wake"]);
      duplicate = true;
      order.length = 0;
      await expect(commands.enqueueThreadInput(input, { onCommitted })).resolves.toMatchObject({
        wasDuplicate: true,
      });
      expect(order).toEqual(["commit", "publish"]);
      expect(onCommitted).toHaveBeenCalledOnce();
    } finally {
      await admission.close();
    }
  });
});
