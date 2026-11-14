import { createId, imageGenerationToolName } from "@opensteer/core";
import { appendImageEmbeds } from "@opensteer/shared/markdownImages";
import type { HarnessEvent } from "./types.js";

/** Adapters settle generation calls before ending a turn; only this layer embeds their files. */
export async function* withGeneratedImageReplies(
  events: AsyncIterable<HarnessEvent>,
): AsyncIterable<HarnessEvent> {
  const running = new Set<string>();
  let paths: string[] = [];
  let held: Extract<HarnessEvent, { type: "assistant.message" }> | undefined;
  function reply(stopped: boolean): HarnessEvent | undefined {
    const current = held;
    held = undefined;
    const images = paths;
    paths = [];
    if (stopped) return current;
    if (current) {
      if (!images.length) return current;
      const text = current.data.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      const suffix = appendImageEmbeds(text, images).slice(text.length);
      const lastText = current.data.content.findLastIndex((part) => part.type === "text");
      const content = current.data.content.map((part, index) =>
        index === lastText && part.type === "text" ? { ...part, text: part.text + suffix } : part,
      );
      if (lastText === -1 && suffix) content.push({ type: "text", text: suffix });
      return { ...current, data: { ...current.data, content } };
    }
    return images.length
      ? {
          type: "assistant.message",
          data: {
            messageId: createId("message"),
            content: [{ type: "text", text: appendImageEmbeds("", images) }],
          },
        }
      : undefined;
  }
  for await (const event of events) {
    if (
      event.type === "tool.started" &&
      event.data.tool.name === imageGenerationToolName &&
      !event.data.nodeId
    )
      running.add(event.data.callId);
    if (
      event.type === "tool.completed" &&
      running.delete(event.data.callId) &&
      !event.data.isError
    ) {
      paths.push(
        ...(event.data.output.images ?? [])
          .filter((image) => image.generated)
          .map((image) => image.path),
      );
    }
    if (event.type === "assistant.message" && (running.size || paths.length)) {
      if (held) yield held;
      held = event;
      continue;
    }
    if (
      event.type === "run.interrupted" ||
      event.type === "run.failed" ||
      event.type === "run.completed" ||
      (event.type === "run.phase" && event.data.phase === "background")
    ) {
      const final = reply(event.type === "run.interrupted");
      if (final) yield final;
      running.clear();
    }
    yield event;
    if (event.type === "tool.completed" && !running.size && held) {
      const final = reply(false);
      if (final) yield final;
    }
  }
  const final = reply(running.size > 0);
  if (final) yield final;
}
