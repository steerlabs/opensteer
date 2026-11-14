import { createId, createToolOutput, imageGenerationToolName } from "@opensteer/core";
import { expect, it } from "vitest";
import { withGeneratedImageReplies } from "./image-generation-events.js";
import type { HarnessEvent } from "./types.js";
const message: HarnessEvent = {
  type: "assistant.message",
  data: { messageId: createId("message"), content: [{ type: "text", text: "Done" }] },
};
const started = (id: string): HarnessEvent => ({
  type: "tool.started",
  data: { callId: id, arguments: {}, tool: { namespace: "test", name: imageGenerationToolName } },
});
const completed = (id: string, failed = false): HarnessEvent => ({
  type: "tool.completed",
  data: {
    callId: id,
    isError: failed,
    output: createToolOutput("done", [
      { path: `/tmp/${id}.png`, mediaType: "image/png", generated: true },
    ]),
  },
});
const terminal: HarnessEvent = { type: "run.completed", data: { status: "completed" } };
async function collect(events: HarnessEvent[]) {
  async function* stream() {
    yield* events;
  }
  const result: HarnessEvent[] = [];
  for await (const event of withGeneratedImageReplies(stream())) result.push(event);
  return result;
}
it("holds the reply through two generations and keeps streaming progress", async () => {
  const delta: HarnessEvent = { type: "assistant.delta", data: { text: "progress" } };
  const events = await collect([
    started("a"),
    started("b"),
    message,
    delta,
    completed("a"),
    completed("b"),
    terminal,
  ]);
  expect(events.map((e) => e.type)).toEqual([
    "tool.started",
    "tool.started",
    "assistant.delta",
    "tool.completed",
    "tool.completed",
    "assistant.message",
    "run.completed",
  ]);
  expect(events[5]).toMatchObject({
    data: { content: [{ text: "Done\n\n![](</tmp/a.png>)\n\n![](</tmp/b.png>)" }] },
  });
});
it("creates one image-only reply", async () => {
  const events = await collect([started("a"), completed("a"), terminal]);
  expect(events.filter((e) => e.type === "assistant.message")).toMatchObject([
    { data: { content: [{ text: "![](</tmp/a.png>)" }] } },
  ]);
});
it("emits a stopped reply unchanged", async () => {
  const stop: HarnessEvent = { type: "run.interrupted", data: { status: "interrupted" } };
  const events = await collect([started("a"), message, stop]);
  expect(events).toEqual([started("a"), message, stop]);
});
it("passes through turns without generation", async () => {
  expect(await collect([message, terminal])).toEqual([message, terminal]);
});
it("never embeds a failed generation", async () => {
  expect(await collect([started("a"), message, completed("a", true), terminal])).toEqual([
    started("a"),
    completed("a", true),
    message,
    terminal,
  ]);
});
