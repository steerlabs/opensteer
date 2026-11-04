import { describe, expect, it } from "vitest";
import { browserSiteForTab } from "./browser-sign-in.js";

describe("browserSiteForTab", () => {
  it("offers no site for a page that failed to load, whatever address it shows", () => {
    const url = "https://www.example.com/account";
    expect(browserSiteForTab({ url })).toBe("https://example.com");
    expect(browserSiteForTab({ navigationFailed: true, url })).toBeNull();
  });
});
