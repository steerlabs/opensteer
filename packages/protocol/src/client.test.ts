import { HostBootstrapSchema } from "./bootstrap.js";
import { createId, type Workspace } from "@opensteer/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserTabCatalogSchema,
  BrowserTabSummarySchema,
  browserPageSite,
  isBrowserPageSite,
} from "./browser.js";
import {
  HostToClientMessageSchema,
  ThreadEventPageSchema,
  workspaceViewFromWorkspace,
} from "./client.js";

const timestamps = {
  createdAt: "2026-08-12T12:00:00.000Z",
  updatedAt: "2026-08-12T12:01:00.000Z",
} as const;

describe("workspaceViewFromWorkspace", () => {
  it("projects a local Workspace without exposing its binding", () => {
    const workspace: Workspace = {
      backing: {
        bindingId: createId("workspaceBinding"),
        generation: 1,
        kind: "local-directory",
        ownerEnvironmentId: createId("environment"),
        storageAuthorityId: createId("storageAuthority"),
      },

      createdBy: createId("user"),
      icon: null,
      homeThreadId: null,
      voiceThreadId: null,
      id: createId("workspace"),
      kind: "main",
      name: "Main",
      status: "ready",
      storageIssue: null,
      ...timestamps,
    };

    const view = workspaceViewFromWorkspace(workspace);

    expect(view).toMatchObject({
      capacity: { kind: "host-filesystem" },
      location: { kind: "machine", name: null },
    });
    expect(view).not.toHaveProperty("backing");
    expect(view).not.toHaveProperty("createdBy");
  });
});

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
  const catalogFrame = (site: string) => ({
    type: "host.browser-tabs-changed",
    sessionId: "bsn_00000000-0000-4000-8000-000000000001",
    catalog: {
      generation: 1,
      revision: 1,
      tabs: [
        {
          availability: "ready",
          documentId: null,
          iconRef: null,
          id: "surface-1",
          navigationFailed: true,
          occupants: [],
          openerId: null,
          order: 0,
          site,
          title: "example.com",
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
    expect(BrowserTabSummarySchema.shape.site.safeParse(site).success).toBe(true);
  });

  it.each(rejected)("keeps %j out of the Host's catalog", (site) => {
    stubUrlThatRefusesEverything();
    expect(isBrowserPageSite(site)).toBe(false);
    expect(BrowserTabSummarySchema.shape.site.safeParse(site).success).toBe(false);
    expect(BrowserTabCatalogSchema.safeParse(catalogFrame(site).catalog).success).toBe(false);
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

it("accepts app tab invalidation and bounds the bootstrap app catalog", () => {
  expect(HostToClientMessageSchema.parse({ type: "host.app-tabs-changed" })).toEqual({
    type: "host.app-tabs-changed",
  });
  const tab = {
    appId: "app_00000000-0000-4000-8000-000000000001",
    title: "Budget",
    workspaceId: createId("workspace"),
    threadId: createId("thread"),
    openedAt: timestamps.createdAt,
    latestVersion: 2,
  };
  expect(HostBootstrapSchema.shape.appTabs.parse([tab])).toEqual([tab]);
  expect(HostBootstrapSchema.shape.appTabs.safeParse(Array(501).fill(tab)).success).toBe(false);
});
