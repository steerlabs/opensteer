import { describe, expect, test } from "vitest";

import {
  BrowserCoreError,
  allBrowserCapabilities,
  hasCapability,
  mergeBrowserCapabilities,
  noBrowserCapabilities,
  staleNodeRefError,
  unsupportedCapabilityError,
  createDocumentEpoch,
  createDocumentRef,
  createNodeRef,
} from "../../packages/browser-core/src/index.js";

describe("browser-core capabilities", () => {
  test("starts with no capabilities and can merge targeted overrides", () => {
    const none = noBrowserCapabilities();
    const merged = mergeBrowserCapabilities(none, {
      executor: {
        navigation: true,
        executionControl: {
          pause: true,
        },
      },
      events: {
        console: true,
      },
    });

    expect(hasCapability(none, "executor.navigation")).toBe(false);
    expect(hasCapability(merged, "executor.navigation")).toBe(true);
    expect(hasCapability(merged, "executor.executionControl.pause")).toBe(true);
    expect(hasCapability(merged, "executor.executionControl.resume")).toBe(false);
    expect(hasCapability(merged, "events.console")).toBe(true);
  });

  test("can represent a fully capable backend", () => {
    const capabilities = allBrowserCapabilities();

    expect(hasCapability(capabilities, "inspector.domSnapshot")).toBe(true);
    expect(hasCapability(capabilities, "transport.sessionHttp")).toBe(true);
    expect(hasCapability(capabilities, "events.download")).toBe(true);
  });
});

describe("browser-core errors", () => {
  test("creates normalized capability and stale-node errors", () => {
    const unsupported = unsupportedCapabilityError("events.dialog");
    const stale = staleNodeRefError({
      documentRef: createDocumentRef("doc-1"),
      documentEpoch: createDocumentEpoch(2),
      nodeRef: createNodeRef("node-1"),
    });

    expect(unsupported).toBeInstanceOf(BrowserCoreError);
    expect(unsupported.code).toBe("unsupported-capability");
    expect(unsupported.capability).toBe("events.dialog");
    expect(unsupported.details).toEqual({ capability: "events.dialog" });

    expect(stale.code).toBe("stale-node-ref");
    expect(stale.details).toMatchObject({
      documentRef: "document:doc-1",
      documentEpoch: 2,
      nodeRef: "node:node-1",
    });
  });
});
