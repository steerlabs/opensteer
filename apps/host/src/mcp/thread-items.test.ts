import { expect, it } from "vitest";
import {
  boundedThreadItems,
  itemText,
  messageItem,
  activityItem,
  withheldTool,
} from "./thread-items.js";
import { formatReferenceLink, createId, type Request } from "@opensteer/core";

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
  "saved_login_request",
  "chrome_cookies_request",
  "card_request",
  "opensteer_automation_create",
  "computer_use",
  "computer_use.type",
  "mcp__opensteer__computer_use",
  "opensteer_saved_login_request",
  "computer_use (opensteer MCP Server)",
  "opensteer_automation_update",
  "use_saved_login",
  "copy_chrome_cookies",
  "use_card",
  "trigger_write",
  "mcp__opensteer__computer",
])("withholds %s however an engine spells it", (name) => {
  expect(withheldTool(name)).toBe(true);
});

it.each(["shell", "plugin_call", "opensteer_task_read", "computer_list", "local_server_add"])(
  "keeps %s",
  (name) => {
    expect(withheldTool(name)).toBe(false);
  },
);

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
  expect(item.link).toBe(
    formatReferenceLink(
      "msg_00000000-0000-4000-8000-000000000001" as Parameters<typeof formatReferenceLink>[0],
      "Message",
    ),
  );
});

it("links a Request activity's real Request but never treats its sequence as a message", () => {
  const event = {
    sequence: "42",
    type: "request.opened",
    runId: null,
    createdAt: "2026-11-06T12:00:00.000Z",
  } as Parameters<typeof activityItem>[0];
  const facts = { ownRun: true, named: false, maxChars: 100 };
  expect(activityItem(event, facts)).not.toHaveProperty("link");
  const request = {
    id: createId("request"),
    kind: "harness.input",
    presentation: {
      kind: "choice",
      title: "Choose export",
      options: [{ id: "csv", label: "CSV" }],
    },
  } as Request;
  expect(activityItem(event, { ...facts, request })).toMatchObject({
    itemId: "42",
    link: formatReferenceLink(request.id, "Choose export"),
  });
});
