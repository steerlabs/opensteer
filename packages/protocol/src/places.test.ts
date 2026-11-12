import { createBrowserSessionId } from "@opensteer/protocol/browser";
import { describe, expect, it } from "vitest";
import { ContentPartSchema, contentSaysSomething, createId } from "@opensteer/core";
import { BrowserTabIconResultSchema, TargetedBrowserClientMessageSchema } from "./browser.js";
import { PlaceActivitySchema } from "./places.js";

describe("place wire contracts", () => {
  it("validates scoped icon bytes", () => {
    expect(
      BrowserTabIconResultSchema.safeParse({ favicon: "data:image/png;base64,aGVsbG8=" }).success,
    ).toBe(true);
    expect(
      BrowserTabIconResultSchema.safeParse({ favicon: "data:image/svg+xml;base64,aGVsbG8=" })
        .success,
    ).toBe(false);
  });
  it("requires an exact page target for stream and page control commands", () => {
    for (const command of [
      { type: "stream.subscribe" },
      { type: "navigation.reload" },
      { type: "dialog.respond", dialogId: crypto.randomUUID(), accept: true },
    ]) {
      expect(TargetedBrowserClientMessageSchema.safeParse(command).success).toBe(false);
      expect(
        TargetedBrowserClientMessageSchema.safeParse({ ...command, surfaceId: "tab-x" }).success,
      ).toBe(true);
    }
  });
  it("validates normalized geometry and receipt/expiry ordering", () => {
    const activity = {
      place: { kind: "browser", sessionId: createBrowserSessionId(), surfaceId: "tab-x" },
      threadId: createId("thread"),
      runId: createId("run"),
      generation: 1,
      seq: 1,
      order: 1,
      at: 1000,
      expiresAt: 2000,
      pointer: null,
      geometryRevision: 1,
    };
    expect(PlaceActivitySchema.safeParse(activity).success).toBe(true);
    expect(PlaceActivitySchema.safeParse({ ...activity, pointer: { x: 1.1, y: 0 } }).success).toBe(
      false,
    );
    expect(PlaceActivitySchema.safeParse({ ...activity, expiresAt: 999 }).success).toBe(false);
  });
  it("preserves old browser parts and supports explicit native references", () => {
    const page = {
      type: "browser-page",
      sessionId: createBrowserSessionId(),
      tabId: "tab-x",
      title: "Page",
      url: "https://example.com/path",
    };
    expect(ContentPartSchema.safeParse(page).success).toBe(true);
    expect(ContentPartSchema.safeParse({ ...page, auto: true }).success).toBe(true);
    expect(
      ContentPartSchema.safeParse({ ...page, auto: true, documentId: "document-1" }).success,
    ).toBe(true);
    const native = [
      {
        type: "computer-app",
        machineId: createId("runner"),
        app: { bundleId: "com.apple.Notes", displayName: "Notes", teamId: null },
        name: "Notes",
      },
      { type: "phone", machineId: createId("runner"), display: "main", name: "Pixel" },
    ];
    for (const part of native) {
      expect(ContentPartSchema.safeParse(part).success).toBe(true);
      expect(contentSaysSomething([part])).toBe(true);
      expect(ContentPartSchema.safeParse({ ...part, auto: true }).success).toBe(false);
    }
  });
});
