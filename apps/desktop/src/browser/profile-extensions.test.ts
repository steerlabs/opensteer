import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { whenReady: () => new Promise(() => undefined) },
  BaseWindow: class {},
  dialog: {},
  nativeImage: {},
  session: {},
  webContents: {},
}));

const { isExtensionId, siteAccess } = await import("./profile-extensions.js");

describe("an extension's site access, as Chrome words it at install", () => {
  it("names every website for broad host access or content scripts", () => {
    expect(siteAccess({ host_permissions: ["<all_urls>"] })).toBe(
      "It can read and change your data on all websites.",
    );
    expect(siteAccess({ content_scripts: [{ matches: ["*://*/*"] }] })).toBe(
      "It can read and change your data on all websites.",
    );
  });

  it("names a few sites, then counts the rest", () => {
    expect(siteAccess({ host_permissions: ["https://*.example.com/*"] })).toBe(
      "It can read and change your data on example.com.",
    );
    expect(
      siteAccess({
        host_permissions: ["https://a.test/*"],
        content_scripts: [{ matches: ["https://b.test/*"] }],
      }),
    ).toBe("It can read and change your data on a.test and b.test.");
    expect(
      siteAccess({
        host_permissions: ["https://a.test/*", "https://b.test/*", "https://c.test/*"],
      }),
    ).toBe("It can read and change your data on a.test and 2 other sites.");
  });

  it("reads Manifest V2 host permissions and says nothing without site access", () => {
    expect(siteAccess({ manifest_version: 2, permissions: ["storage", "https://a.test/*"] })).toBe(
      "It can read and change your data on a.test.",
    );
    expect(siteAccess({ permissions: ["storage"] })).toBeNull();
    expect(siteAccess(null)).toBeNull();
  });
});

it("recognizes Chrome extension IDs", () => {
  expect(isExtensionId("abcdefghijklmnopabcdefghijklmnop")).toBe(true);
  expect(isExtensionId("abcdefghijklmnopabcdefghijklmnoq")).toBe(false);
  expect(isExtensionId("short")).toBe(false);
});
