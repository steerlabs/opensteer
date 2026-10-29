import { describe, expect, it } from "vitest";
import { normalizeNavigationInput } from "./browser-chrome.js";

describe("normalizeNavigationInput", () => {
  it("keeps full URLs and upgrades bare domains to https", () => {
    expect(normalizeNavigationInput("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(normalizeNavigationInput("example.com")).toBe("https://example.com/");
    expect(normalizeNavigationInput("localhost:3000/admin")).toBe("http://localhost:3000/admin");
  });

  it("turns plain words into a Google search", () => {
    expect(normalizeNavigationInput("chocolate cake recipe")).toBe(
      "https://www.google.com/search?q=chocolate%20cake%20recipe",
    );
    expect(normalizeNavigationInput("weather")).toBe("https://www.google.com/search?q=weather");
  });

  it("refuses non-web schemes and empty input", () => {
    expect(normalizeNavigationInput("javascript:alert(1)")).toBeNull();
    expect(normalizeNavigationInput("file:///etc/passwd")).toBeNull();
    expect(normalizeNavigationInput("   ")).toBeNull();
  });
});
