import { ContentPartSchema, createId } from "@opensteer/core";
import { transcriptMessageRefsMaxBytes } from "@opensteer/protocol/transcript";
import { expect, test } from "vitest";
import { describeTranscriptMessage } from "./transcript-store.js";

const page = (index: number, url = `https://example.com/${index}`) => ({
  type: "browser-page" as const,
  sessionId: `bsn_${crypto.randomUUID()}`,
  tabId: `tab-${index}`,
  title: `Page ${index}`,
  url,
});
const author = {
  kind: "human" as const,
  displayName: "Person",
  principalId: "principal-person",
  userId: createId("user"),
};
const describe = (content: Parameters<typeof describeTranscriptMessage>[0]["content"]) =>
  describeTranscriptMessage({
    kind: "input",
    content,
    author,
    edited: false,
    admittedSeed: false,
    seedInRun: false,
    assigned: false,
  });

test("a message card carries its attachments, pages and places in order, bounded per kind and in bytes", () => {
  const machineId = createId("device");
  const attachment = (index: number) => ({
    type: "artifact" as const,
    artifactId: `artifact-${index}`,
    mediaType: "image/png",
    name: `shot-${index}.png`,
  });
  const content = ContentPartSchema.array().parse([
    { type: "text", text: "Look at these" },
    ...Array.from({ length: 8 }, (_, index) => attachment(index)),
    ...Array.from({ length: 6 }, (_, index) => page(index)),
    { type: "phone", machineId, display: "main", name: "Pixel" },
  ]);
  const card = describe(content);
  expect(card.refs).toEqual({
    attachments: content.slice(1, 7),
    pages: content.slice(9, 13),
    places: [content.at(-1)],
  });
  expect(card.view.preview).toBe("Look at these");
  expect(describe([{ type: "text", text: "Only words" }]).refs).toBeNull();

  const wide = describe(
    ContentPartSchema.array().parse(
      Array.from({ length: 4 }, (_, index) =>
        page(index, `https://example.com/${"x".repeat(1900)}`),
      ),
    ),
  );
  expect(wide.refs?.pages?.length).toBe(1);
  expect(Buffer.byteLength(JSON.stringify(wide.refs))).toBeLessThanOrEqual(
    transcriptMessageRefsMaxBytes,
  );
});

test("the converter's raw parts project to the same references as live content", () => {
  const content = ContentPartSchema.array().parse([
    { type: "text", text: "Same" },
    page(1),
    page(2),
  ]);
  const live = describe(content);
  const converted = describe({
    hasContent: true,
    hasRichParts: true,
    text: "Same",
    richParts: JSON.parse(JSON.stringify(content.slice(1))) as unknown[],
  });
  expect(converted.refs).toEqual(live.refs);
  expect(converted.view).toEqual(live.view);
});

test("a card is truncated only when its body holds more than the card draws", () => {
  const two = ContentPartSchema.array().parse([{ type: "text", text: "Here" }, page(1), page(2)]);
  expect(describe(two).view.truncated).toBeUndefined();
  const many = ContentPartSchema.array().parse([
    { type: "text", text: "Here" },
    ...Array.from({ length: 6 }, (_, index) => page(index)),
  ]);
  expect(describe(many).view.truncated).toBe(true);
});
