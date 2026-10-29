import { createBrowserSessionId } from "@opensteer/protocol/browser";
import { describe, expect, it } from "vitest";
import { ContentPartSchema, contentSaysSomething, createId } from "@opensteer/core";
import {
  BrowserTabCatalogSchema,
  BrowserTabIconResultSchema,
  TargetedBrowserClientMessageSchema,
} from "./browser.js";
import { PlaceActivitySchema } from "./places.js";

const tab = {
  id: "tab-x",
  title: "Private page",
  site: "https://example.com",
  iconRef: null,
  order: 1,
  openerId: null,
  availability: "ready",
  occupants: [],
};
const catalog = { generation: 1, revision: 1, tabs: [tab] };

describe("place wire contracts", () => {
  it("bounds and validates the origin-only catalog, explicit removal and scoped icon bytes", () => {
    expect(BrowserTabCatalogSchema.safeParse(catalog).success).toBe(true);
    expect(BrowserTabCatalogSchema.safeParse({ ...catalog, tabs: [] }).success).toBe(true);
    for (const tabs of [
      [tab, tab],
      Array.from({ length: 65 }, (_, index) => ({ ...tab, id: `tab-${index}`, order: index })),
      [{ ...tab, site: "https://example.com/private?q=secret" }],
      [{ ...tab, favicon: "bytes" }],
    ]) {
      expect(BrowserTabCatalogSchema.safeParse({ ...catalog, tabs }).success).toBe(false);
    }
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
      home: false,
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
