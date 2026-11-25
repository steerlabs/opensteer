import { describe, expect, it } from "vitest";
import {
  isDynamicExtensionHop,
  recordDynamicExtensionRequestHop,
  recordExtensionRedirect,
  takeDynamicExtensionRequestHop,
  takeExtensionRedirect,
} from "./extension-redirects.js";

const dynamic = "chrome-extension://e7c508fa-1f5c-471b-9065-5bf03292faaa";
const id = "abcdefghijklmnopabcdefghijklmnop";
const staticBase = `chrome-extension://${id}`;

describe("Chromium's rewrite of an extension's dynamic address", () => {
  it("is a hop from a dynamic host to an extension id with the same path and query", () => {
    expect(isDynamicExtensionHop(`${dynamic}/dyn.html?a=1`, `${staticBase}/dyn.html?a=1`)).toBe(
      true,
    );
    expect(isDynamicExtensionHop(`${dynamic}/dyn.html`, `${staticBase}/nonwar.html`)).toBe(false);
    expect(isDynamicExtensionHop(`${dynamic}/dyn.html?a=1`, `${staticBase}/dyn.html`)).toBe(false);
    expect(isDynamicExtensionHop("https://evil.test/dyn.html", `${staticBase}/dyn.html`)).toBe(
      false,
    );
    expect(isDynamicExtensionHop(`${staticBase}/dyn.html`, `${staticBase}/dyn.html`)).toBe(false);
    expect(isDynamicExtensionHop(`${dynamic}/dyn.html`, `${dynamic}/dyn.html`)).toBe(false);
    expect(isDynamicExtensionHop("not a url", `${staticBase}/dyn.html`)).toBe(false);
  });

  it("is told apart from a web response's redirect and taken once", () => {
    recordExtensionRedirect(1, 7, `${dynamic}/dyn.html`, `${staticBase}/dyn.html`);
    expect(takeExtensionRedirect(1, 7, `${staticBase}/dyn.html`)).toEqual({
      from: undefined,
      dynamicHop: true,
    });
    expect(takeExtensionRedirect(1, 7, `${staticBase}/dyn.html`)).toBeUndefined();
    recordExtensionRedirect(1, 7, "https://idp.test/auth", `${staticBase}/callback.html`);
    expect(takeExtensionRedirect(1, 8, `${staticBase}/callback.html`)).toBeUndefined();
    expect(takeExtensionRedirect(1, 7, `${staticBase}/callback.html`)).toEqual({
      from: "https://idp.test",
      dynamicHop: false,
    });
  });

  it("follows a subresource request by its id and address, once", () => {
    recordDynamicExtensionRequestHop(42, `${staticBase}/dyn.txt`);
    expect(takeDynamicExtensionRequestHop(43, `${staticBase}/dyn.txt`)).toBe(false);
    expect(takeDynamicExtensionRequestHop(42, `${staticBase}/nonwar.txt`)).toBe(false);
    expect(takeDynamicExtensionRequestHop(42, `${staticBase}/dyn.txt`)).toBe(true);
    expect(takeDynamicExtensionRequestHop(42, `${staticBase}/dyn.txt`)).toBe(false);
  });
});
