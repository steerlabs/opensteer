import { createId, createToolOutput, imageGenerationToolName } from "@opensteer/core";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { withGeneratedImageReplies, withStoredImages } from "./image-generation-events.js";
import { createToolImageStore } from "./output-images.js";
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
it("keeps a stopped reply unchanged even after one generation finished", async () => {
  const stop: HarnessEvent = { type: "run.interrupted", data: { status: "interrupted" } };
  const events = await collect([
    started("a"),
    started("b"),
    message,
    completed("a"),
    completed("b", true),
    stop,
  ]);
  expect(events.slice(-2)).toEqual([message, stop]);
});
it("refuses network paths without touching them", async () => {
  const store = createToolImageStore(join(tmpdir(), "unused-runner"));
  for (const path of ["//attacker/share/a.png", "/\\attacker/share/a.png", "\\\\attacker\\a.png"])
    expect(await store.putFile!(path)).toBeUndefined();
});
it.skipIf(process.platform === "win32")(
  "refuses a FIFO an engine names instead of waiting on it",
  async () => {
    const { execFileSync } = await import("node:child_process");
    const root = await mkdtemp(join(tmpdir(), "stored-fifo-"));
    try {
      const fifo = join(root, "image.png");
      execFileSync("mkfifo", [fifo]);
      const store = createToolImageStore(join(root, "runner"));
      expect(await store.putFile!(fifo)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
it("keeps the answer and a later generation's image in one reply", async () => {
  const events = await collect([
    started("a"),
    message,
    completed("a"),
    started("b"),
    completed("b"),
    terminal,
  ]);
  const replies = events.filter((event) => event.type === "assistant.message");
  expect(replies).toMatchObject([
    { data: { content: [{ text: "Done\n\n![](</tmp/a.png>)\n\n![](</tmp/b.png>)" }] } },
  ]);
  expect(events.at(-1)).toEqual(terminal);
});
it("releases a turn's reply when the next turn begins", async () => {
  const next: HarnessEvent = { type: "run.phase", data: { phase: "turn" } };
  const events = await collect([started("a"), message, completed("a"), next]);
  expect(events.slice(-2)).toMatchObject([
    { type: "assistant.message", data: { content: [{ text: "Done\n\n![](</tmp/a.png>)" }] } },
    next,
  ]);
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

it("moves engine-saved images into the Runner store and keeps unreadable ones as reported", async () => {
  const root = await mkdtemp(join(tmpdir(), "stored-images-"));
  try {
    const store = createToolImageStore(join(root, "runner"));
    const saved = join(root, "engine-home", "generated.png");
    await mkdir(join(root, "engine-home"));
    await writeFile(saved, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]));
    async function* stream(): AsyncIterable<HarnessEvent> {
      yield {
        type: "tool.completed",
        data: {
          callId: "g",
          isError: false,
          output: createToolOutput("done", [
            { path: saved, mediaType: "image/png", generated: true },
            { path: join(root, "missing.png"), mediaType: "image/png" },
          ]),
        },
      };
    }
    const result: HarnessEvent[] = [];
    for await (const event of withStoredImages(stream(), store)) result.push(event);
    const images = result[0]?.type === "tool.completed" ? result[0].data.output.images : [];
    expect(images?.[0]).toMatchObject({ mediaType: "image/png", generated: true });
    expect(images?.[0]?.path).toMatch(new RegExp(`^${store.directory}/[a-f0-9]{64}\\.png$`));
    expect(images?.[1]).toEqual({ path: join(root, "missing.png"), mediaType: "image/png" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
