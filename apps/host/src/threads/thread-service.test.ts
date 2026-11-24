import { createId, ModelSelectionSchema, type Thread } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import type { ConnectionCaller } from "../mcp/agent-caller.js";
import { dispatchCommand, type CommandAuthority } from "../commands/dispatch.js";
import { ThreadService } from "./thread-service.js";
describe("new Thread access ceilings", () => {
  it("permits narrower work and forwards the caller's live authority", async () => {
    const actor: ConnectionCaller = {
      kind: "connection",
      grant: { scope: "everything" },
      grantRevision: 1,
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
      idempotencyKey: "narrow",
      accessMode: "approval-required" as const,
    };
    // An agent's task write is a command the door admitted (rule 2, A3): without the door's
    // authority it is refused before the store is reached.
    await expect(service.create(actor, command)).rejects.toMatchObject({
      code: "internal",
      message: "An agent's task write goes through the command door",
    });
    expect(createThread).not.toHaveBeenCalled();
    // The door's authority, as the door hands it to the handler it runs.
    let door: CommandAuthority | null = null;
    await dispatchCommand(actor, command as never, {
      registry: {
        "thread.create": {
          accepts: "any",
          run: async (
            _actor: unknown,
            _command: unknown,
            on: { authority: CommandAuthority | null },
          ) => {
            door = on.authority;
            return { type: "thread.create" };
          },
        },
      } as never,
      admit: async () => ({ answer: "now", face: 0, execution: null }),
      scope: async () => ({
        scope: "everything",
        grant: { scope: "everything" },
        mode: "auto",
      }),
    });
    expect(door).not.toBeNull();
    expect((await service.create(actor, command, {}, door!)).thread).toEqual(thread);
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
      service.create(
        actor,
        {
          ...command,
          accessMode: "full-access",
        },
        {},
        door!,
      ),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(createThread).toHaveBeenCalledOnce();
  });
});
