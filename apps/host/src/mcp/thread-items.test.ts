import { expect, it } from "vitest";
import { boundedThreadItems, itemText, messageItem, withheldTool } from "./thread-items.js";

it("keeps the newest item past the byte bound, so paging always advances", () => {
  const large = "\u0001".repeat(50_000);
  expect(boundedThreadItems([large, "older"])).toEqual([large]);
});

it("cuts text that escapes past the item bound and still pages to its end", () => {
  const text = "\u0001".repeat(50_000);
  const first = itemText(text, 50_000);
  expect(Buffer.byteLength(JSON.stringify(first.text), "utf8")).toBeLessThanOrEqual(192 * 1024);
  expect(first).toMatchObject({ textTruncated: true });
  const rest = itemText(text, 50_000, first.nextTextOffset!);
  expect(first.text!.length + rest.text!.length).toBe(text.length);
  expect(rest).toMatchObject({ textTruncated: false, nextTextOffset: null });
});

it("pages text by code point without splitting a surrogate pair", () => {
  expect(itemText("a😀b", 2)).toEqual({ text: "a😀", textTruncated: true, nextTextOffset: 2 });
  expect(itemText("a😀b", 2, 2)).toEqual({ text: "b", textTruncated: false, nextTextOffset: null });
});

it.each([
  "sign_in",
  "use_card",
  "trigger_write",
  "computer",
  "computer.type",
  "mcp__opensteer__computer",
  "opensteer_sign_in",
  "computer (opensteer MCP Server)",
])("withholds %s however an engine spells it", (name) => {
  expect(withheldTool(name)).toBe(true);
});

it.each(["shell", "integration_call", "thread_read", "computers_list"])("keeps %s", (name) => {
  expect(withheldTool(name)).toBe(false);
});

it("names a file a message carries", () => {
  const item = messageItem(
    {
      author: { kind: "human", displayName: "Tim", principalId: "principal:test" },
      content: [
        { type: "artifact", artifactId: "art_1", mediaType: "application/pdf", name: "menu.pdf" },
      ],
      createdAt: "2026-11-06T12:00:00.000Z",
      id: "msg_00000000-0000-4000-8000-000000000001",
      kind: "input",
      runId: null,
      sequence: "1",
      threadId: "thr_00000000-0000-4000-8000-000000000001",
    } as Parameters<typeof messageItem>[0],
    100,
  );
  expect(item.text).toBe("[file: menu.pdf (application/pdf)]");
});
