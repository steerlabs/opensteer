import { AgentEventViewSchema, createId } from "@opensteer/core";
import { expect, it, vi } from "vitest";
import { withEventClientSendKeys } from "./client-send-keys.js";

it("adds the send key to each event without copying the later placed message onto creation", async () => {
  const threadId = createId("thread");
  const createdAt = "2026-08-23T20:00:00.000Z";
  const message = {
    id: createId("message"),
    threadId,
    runId: null,
    author: {
      kind: "human",
      userId: createId("user"),
      principalId: "person",
      displayName: "Person",
    },
    kind: "input",
    content: [{ type: "text", text: "Original" }],
    createdAt,
    sequence: "1",
  };
  const base = { threadId, runId: null, environmentId: createId("environment"), createdAt };
  const created = AgentEventViewSchema.parse({
    ...base,
    eventId: createId("event"),
    type: "message.created",
    sequence: "1",
    data: { input: null, message },
  });
  const placed = AgentEventViewSchema.parse({
    ...base,
    eventId: createId("event"),
    type: "message.placed",
    sequence: "2",
    data: { message: { ...message, sequence: "2", content: [{ type: "text", text: "Edited" }] } },
  });
  const read = vi.fn(async () => new Map([[message.id, "send-key"]]));
  expect(await withEventClientSendKeys([created, placed], read)).toMatchObject([
    {
      sequence: "1",
      data: {
        input: null,
        message: {
          content: [{ type: "text", text: "Original" }],
          sequence: "1",
          clientSendKey: "send-key",
        },
      },
    },
    {
      sequence: "2",
      data: {
        message: {
          content: [{ type: "text", text: "Edited" }],
          sequence: "2",
          clientSendKey: "send-key",
        },
      },
    },
  ]);
  expect(read).toHaveBeenCalledTimes(1);
});
