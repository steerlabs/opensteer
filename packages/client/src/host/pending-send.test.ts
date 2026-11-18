import { DeviceIdSchema } from "@opensteer/core";
import { createId } from "@opensteer/core";
import { createBrowserSessionId, hostApi } from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import {
  messageDraftParts,
  browserPagePart,
  type PendingSendCommand,
  type PendingSendScope,
} from "./pending-send.js";

const scope: PendingSendScope = {
  deploymentId: "deployment-test",
  userId: createId("user"),
  threadId: createId("thread"),
};

function page() {
  return {
    sessionId: createBrowserSessionId(),
    tabId: "surface-selected",
    title: "Selected page",
    url: "https://example.com/products?size=small",
  };
}

function command(included?: ReturnType<typeof page>, body = "Read this page"): PendingSendCommand {
  return {
    content: [...(included ? [browserPagePart(included)] : []), { type: "text", text: body }],
    delivery: "queue",
    idempotencyKey: "current-page-send",
    threadId: scope.threadId,
    type: "thread.sendMessage",
  };
}

describe("durable current-page sends", () => {
  it("keeps the page as its own part, so the person's words stay only their words", () => {
    const included = page();
    const saved = command(included);
    const read = hostApi["commands.dispatch"].payload.parse(saved);
    expect(read).toEqual(saved);
    if (read.type !== "thread.sendMessage") throw new Error("Expected a personal message");
    expect(read.content).toEqual([
      { type: "browser-page", ...included },
      { type: "text", text: "Read this page" },
    ]);
    expect(hostApi["commands.dispatch"].payload.parse(read)).toEqual(read);
  });

  it("bounds what the page said and never cuts its address", () => {
    const included = page();
    expect(browserPagePart({ ...included, title: "x".repeat(400) }).title).toHaveLength(256);
    expect(
      browserPagePart({ ...included, url: `https://example.com/${"x".repeat(5000)}` }).url,
    ).toBe("https://example.com");
    expect(() => browserPagePart({ ...included, sessionId: "some-other-browser" })).toThrow();
  });
});

it("recovers all place parts in order and retains the exact pending submission", () => {
  const content = [
    browserPagePart(page()),
    { type: "text", text: "Read all of these" },
    {
      type: "computer-app",
      machineId: DeviceIdSchema.parse(createId("runner")),
      app: { bundleId: "com.apple.Notes", displayName: "Notes", teamId: null },
      name: "Mac",
    },
    browserPagePart(page()),
    {
      type: "phone",
      machineId: DeviceIdSchema.parse(createId("runner")),
      display: "main",
      name: "Pixel",
    },
  ] as const;
  const submission = { ...command(), content: [...content] };
  expect(hostApi["commands.dispatch"].payload.parse(submission)).toEqual(submission);
  expect(messageDraftParts(content)).toEqual({
    body: "Read all of these",
    attachments: [],
    places: content.filter((part) => part.type !== "text"),
  });
});
