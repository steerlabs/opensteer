import { createId } from "@opensteer/core";

import { afterEach, describe, expect, it, vi } from "vitest";
import { browserPageSite, isBrowserPageSite } from "./browser.js";
import {
  ClientToHostMessageSchema,
  HostToClientMessageSchema,
  ThreadEventPageSchema,
} from "./client.js";

const timestamps = {
  createdAt: "2026-08-12T12:00:00.000Z",
  updatedAt: "2026-08-12T12:01:00.000Z",
} as const;

it("skips future history event types but still rejects malformed known events", () => {
  const reader = ThreadEventPageSchema.shape.events;
  expect(reader.parse([{ type: "future.event", sequence: "42", data: { future: true } }])).toEqual(
    [],
  );
  expect(reader.safeParse([{ type: "place.entered", data: {} }]).success).toBe(false);
});

describe("browser tab sites", () => {
  afterEach(() => vi.unstubAllGlobals());

  const bareSchemes = ["chrome-error:", "chrome:", "devtools:", "file:", "data:", "blob:"];
  const accepted = [
    "",
    "https://example.com",
    "http://localhost:3000",
    "http://[::1]:3000",
    "about:blank",
    "about:srcdoc",
    ...bareSchemes,
    "view-source:",
    "mailto:",
    "chrome-extension:",
  ];
  const rejected = [
    "https://example.com/",
    "https://example.com/private/path",
    "https://example.com?token=private",
    "https://example.com#private",
    "https://user:password@example.com",
    "http://",
    "https://exa mple.com",
    "example.com",
    "chrome-error://chromewebdata/",
    "file:///Users/person/private.html",
    "data:text/html,private",
    "blob:https://example.com/private",
  ];
  const catalogFrame = (url: string) => ({
    type: "host.tabs",
    stream: {
      op: "rows",
      rows: [
        {
          tabId: "surface-1",
          kind: "page",
          title: "example.com",
          url,
          profile: null,
          computer: { computerId: createId("runner"), name: "Mac" },
          groupId: null,
          state: "open",
          openedBy: "person",
          usedBy: [],
          createdAt: timestamps.createdAt,
          updatedAt: timestamps.updatedAt,
        },
      ],
    },
  });

  // Chromium refuses `new URL("chrome-error:")`, which Node and Hermes accept.
  const stubUrlThatRefusesEverything = () =>
    vi.stubGlobal(
      "URL",
      class {
        constructor() {
          throw new TypeError("Invalid URL");
        }
      },
    );

  it.each(accepted)("admits %j whatever the runtime's URL says", (site) => {
    stubUrlThatRefusesEverything();
    expect(isBrowserPageSite(site)).toBe(true);
  });

  it.each(rejected)("keeps %j out of the Host's catalog", (site) => {
    stubUrlThatRefusesEverything();
    expect(isBrowserPageSite(site)).toBe(false);
  });

  it.each(["chrome-error:", "chrome:", "devtools:"])(
    "reads a Host frame naming %s on a runtime whose URL refuses it",
    (site) => {
      stubUrlThatRefusesEverything();
      expect(HostToClientMessageSchema.safeParse(catalogFrame(site)).success).toBe(true);
    },
  );

  it("reads a site a newer Host may send, since the Host decides what a site is", () => {
    expect(
      HostToClientMessageSchema.safeParse(catalogFrame("https://example.com/not-today")).success,
    ).toBe(true);
  });

  it.each([
    ["https://example.com/private?token=1#x", "https://example.com"],
    ["http://localhost:3000/a", "http://localhost:3000"],
    ["about:blank", "about:blank"],
    ["chrome-error://chromewebdata/", ""],
    ["chrome://newtab/", "chrome:"],
    ["devtools://devtools/bundled/inspector.html", "devtools:"],
    ["file:///Users/person/private.html", "file:"],
    ["data:text/html,private", "data:"],
    ["blob:https://example.com/private", "blob:"],
    ["not a url", ""],
  ])("produces only what the catalog admits from %s", (address, site) => {
    expect(browserPageSite(address)).toBe(site);
    expect(isBrowserPageSite(browserPageSite(address))).toBe(true);
  });
});

it("accepts app invalidation", () => {
  const notice = {
    type: "host.apps.changed",
    appIds: ["app_00000000-0000-4000-8000-000000000001"],
  };
  expect(HostToClientMessageSchema.parse(notice)).toEqual(notice);
});

it("admits shared tab streams and per-socket repair", () => {
  const groupId = "bsn_00000000-0000-4000-8000-000000000001";
  for (const frame of [
    { type: "client.browser.resync" },
    { type: "client.browser.resync", groupId },
  ])
    expect(ClientToHostMessageSchema.parse(frame)).toEqual(frame);
  const frame = { type: "host.tabs", stream: { op: "begin", generation: "g" } };
  expect(HostToClientMessageSchema.parse(frame)).toEqual(frame);
});
