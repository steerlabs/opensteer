import { createId, ModelSelectionSchema, type Thread } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import type { ConnectionCaller } from "../mcp/agent-caller.js";
import { ThreadService } from "./thread-service.js";
describe("new Thread access ceilings", () => {
  it("permits narrower work and forwards the caller's live authority", async () => {
    const actor: ConnectionCaller = {
      kind: "connection",
      key: "connection:test",
      connectionId: "test",
      userId: createId("user"),
      accessMode: "auto",
    };
    const thread = {
      id: createId("thread"),
      accessMode: "approval-required",
    } as Thread;
    const result = {
      thread,
      wasDuplicate: true,
      asOfSequence: "0",
    };
    const createThread = vi.fn(async () => result);
    const service = new ThreadService({
      store: {
        getWorkspaceForOwner: async () => ({}),
        findThreadCreationByIdempotency: async () => result,
      },
      commands: {
        createThread,
      },
    } as unknown as ThreadService["options"]);
    const command = {
      type: "thread.create" as const,
      environmentId: createId("environment"),
      harnessInstanceId: createId("harnessInstance"),
      modelSelection: ModelSelectionSchema.parse({
        providerId: "openai",
        modelId: "test",
        options: {},
      }),
      title: "Narrow work",
      folder: { computerId: createId("runner"), path: "/chosen-folder" },
      idempotencyKey: "narrow",
      accessMode: "approval-required" as const,
    };
    expect((await service.create(actor, command)).thread).toEqual(thread);
    expect(createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        accessMode: "approval-required",
        authority: expect.objectContaining({
          kind: "connection",
          accessMode: "auto",
          connectionId: "test",
        }),
      }),
    );
    await expect(
      service.create(actor, {
        ...command,
        accessMode: "full-access",
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(createThread).toHaveBeenCalledOnce();
  });
});
