import { beforeEach, describe, expect, it, vi } from "vitest";
const clipboard = vi.hoisted(() => ({
  setStringAsync: vi.fn(async () => true),
  setImageAsync: vi.fn(async () => undefined),
  StringFormat: { HTML: "html", PLAIN_TEXT: "plainText" },
}));
vi.mock("expo-clipboard", () => clipboard);
import { createMobileClipboardPort } from "../src/clipboard.js";
const item = (type: string, text: string) => ({ type, bytes: new TextEncoder().encode(text) });
beforeEach(() => vi.clearAllMocks());
describe("Expo clipboard port", () => {
  it("writes HTML through the native API and leaves empty results untouched", async () => {
    const port = createMobileClipboardPort();
    expect(await port.write([])).toBe("empty");
    expect(clipboard.setStringAsync).not.toHaveBeenCalled();
    expect(await port.write([item("text/plain", "hi"), item("text/html", "<b>hi</b>")])).toBe(
      "written",
    );
    expect(clipboard.setStringAsync).toHaveBeenCalledWith("<b>hi</b>", { inputFormat: "html" });
  });
  it("serializes writes and exposes native refusal", async () => {
    clipboard.setStringAsync.mockResolvedValueOnce(false);
    const port = createMobileClipboardPort();
    expect(await port.write([item("text/plain", "one")])).toBe("refused");
    expect(await port.write([item("application/pdf", "two")])).toBe("unsupported");
  });
});
