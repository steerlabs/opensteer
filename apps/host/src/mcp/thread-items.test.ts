import { expect, it } from "vitest";
import {
  boundedThreadItems,
  itemText,
  messageItem,
  activityItem,
  withheldTool,
} from "./thread-items.js";
import { formatReferenceLink, createId } from "@opensteer/core";

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

it("links Request activity using its real Request ID and returns the stable item ID", () => {
  const requestId = createId("request");
  const itemId = `request:${requestId}`;
  expect(
    activityItem(
      {
        id: itemId,
        position: "42",
        type: "request.opened",
        requestId,
        requestKind: "harness.input",
        requestStatus: "pending",
        question: null,
        title: "Choose export",
        runId: null,
        createdAt: "2026-11-06T12:00:00.000Z",
      },
      { named: false, maxChars: 100 },
    ),
  ).toMatchObject({
    itemId,
    status: "pending",
    text: "harness.input",
    link: formatReferenceLink(requestId, "Choose export"),
  });
});

it("formats non-secret settled person.question cards with their real outcome status", () => {
  const answeredId = createId("request");
  expect(
    activityItem(
      {
        id: `request:${answeredId}`,
        position: "43",
        type: "request.resolved",
        requestId: answeredId,
        requestKind: "person.question",
        requestStatus: "fulfilled",
        question: {
          outcome: "answered",
          detail: "Draft reply to Acme",
          answers: [{ prompt: "Send this?", answer: ["Yes, send it"] }],
        },
        title: "Reply to Acme",
        runId: null,
        createdAt: "2026-11-06T12:01:00.000Z",
      },
      { named: false, maxChars: 500 },
    ),
  ).toMatchObject({
    itemId: `request:${answeredId}`,
    status: "fulfilled",
    text: "Draft reply to Acme\n\nQuestion: Send this?\nAnswer: Yes, send it",
  });

  const dismissedId = createId("request");
  expect(
    activityItem(
      {
        id: `request:${dismissedId}`,
        position: "44",
        type: "request.resolved",
        requestId: dismissedId,
        requestKind: "person.question",
        requestStatus: "declined",
        question: {
          outcome: "dismissed",
          answers: [{ prompt: "Check billing portal?", answer: [] }],
        },
        title: "Billing check",
        runId: null,
        createdAt: "2026-11-06T12:02:00.000Z",
      },
      { named: false, maxChars: 500 },
    ),
  ).toMatchObject({
    itemId: `request:${dismissedId}`,
    status: "declined",
    text: "Question: Check billing portal?\n\nDismissed by the person without answering.",
  });

  // Long prompts report textTruncated: true and resume seamlessly on the same canonical text.
  const longId = createId("request");
  const longPrompt = "P".repeat(10_000);
  const longItem = {
    id: `request:${longId}`,
    position: "45",
    type: "request.resolved" as const,
    requestId: longId,
    requestKind: "person.question",
    requestStatus: "fulfilled" as const,
    question: {
      outcome: "answered" as const,
      answers: [
        {
          prompt: longPrompt,
          options: [{ label: "Proceed", description: "Submit now" }],
          answer: ["Proceed"],
        },
      ],
    },
    title: "Long question",
    runId: null,
    createdAt: "2026-11-06T12:03:00.000Z",
  };
  const preview = activityItem(longItem, { named: false, maxChars: 20_000 });
  expect(preview.textTruncated).toBe(true);
  expect(preview.nextTextOffset).toBe(4_096);
  const rest = activityItem(longItem, {
    named: true,
    maxChars: 20_000,
    offset: preview.nextTextOffset!,
  });
  expect(rest.textTruncated).toBe(false);
  expect(rest.nextTextOffset).toBeNull();
  expect(`${preview.text}${rest.text}`).toBe(
    `Question: ${longPrompt}\nOptions: Proceed — Submit now\nAnswer: Proceed`,
  );
});
