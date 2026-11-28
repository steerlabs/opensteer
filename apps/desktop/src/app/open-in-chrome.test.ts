import { describe, expect, it, vi } from "vitest";
import { openInChrome } from "./open-in-chrome.js";

describe("opening the Chrome connect page", () => {
  const page = "http://127.0.0.1:4000/connect/chrome#osc1.abc";

  it("asks macOS for Google Chrome itself, not the default browser", async () => {
    const run = vi.fn(async () => undefined);
    await expect(openInChrome(page, run)).resolves.toEqual({ opened: true });
    expect(run).toHaveBeenCalledExactlyOnceWith("/usr/bin/open", ["-b", "com.google.Chrome", page]);
  });

  it("says Chrome isn't installed when macOS can't find it, and opens nothing else", async () => {
    const run = vi.fn(async () => {
      throw Object.assign(new Error("Unable to find application with bundle identifier"), {
        code: 1,
      });
    });
    await expect(openInChrome(page, run)).resolves.toEqual({
      opened: false,
      reason: "chrome-not-installed",
    });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
