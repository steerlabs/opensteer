import { describe, expect, it } from "vitest";
import {
  browserSiteForTab,
  chromeConnectPageUrl,
  splitChromeConnectFragment,
} from "./browser-sign-in.js";

describe("browserSiteForTab", () => {
  it("offers no site for a page that failed to load, whatever address it shows", () => {
    const url = "https://www.example.com/account";
    expect(browserSiteForTab({ url })).toBe("https://example.com");
    expect(browserSiteForTab({ navigationFailed: true, url })).toBeNull();
  });
});

describe("the desktop's local hand-off to Chrome", () => {
  const loopback = "http://127.0.0.1:4310";
  const invitation = "opensteer-browser-source:eyJ2ZXJzaW9uIjoyfQ";
  const folder = "/Users/someone/Library/Application Support/Opensteer/Browser Extension";
  const fragment = (url: string) => url.slice(url.indexOf("#"));

  it("names the managed folder to a loopback page, next to the unchanged invitation", () => {
    expect(
      splitChromeConnectFragment(
        fragment(chromeConnectPageUrl(loopback, invitation, folder)),
        loopback,
      ),
    ).toEqual({ extensionDirectory: folder, invitation });
    expect(
      splitChromeConnectFragment(fragment(chromeConnectPageUrl(loopback, invitation)), loopback),
    ).toEqual({ extensionDirectory: null, invitation });
  });

  it("never names a folder to a remote page or accepts a relative one", () => {
    const named = fragment(chromeConnectPageUrl(loopback, invitation, folder));
    expect(splitChromeConnectFragment(named, "https://home.example.com")).toEqual({
      extensionDirectory: null,
      invitation,
    });
    expect(
      splitChromeConnectFragment(
        `#${invitation}&folder=${encodeURIComponent("relative")}`,
        loopback,
      ),
    ).toEqual({ extensionDirectory: null, invitation });
  });
});
