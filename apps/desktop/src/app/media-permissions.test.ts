import type { Session, WebContents } from "electron";
import { expect, it, vi } from "vitest";
import { configureDesktopPermissions } from "./media-permissions.js";
import { DesktopAppOriginPolicy } from "./navigation-policy.js";

function fixture() {
  const session = {
    setPermissionCheckHandler: vi.fn<Session["setPermissionCheckHandler"]>(),
    setPermissionRequestHandler: vi.fn<Session["setPermissionRequestHandler"]>(),
  };
  const ask = vi.fn().mockResolvedValue(true);
  const contents = { isDestroyed: vi.fn(() => false), getURL: vi.fn(() => "app://opensteer/") };
  configureDesktopPermissions(
    session,
    new DesktopAppOriginPolicy(),
    { permitsRequest: (origin) => origin === "app://opensteer" },
    ask,
  );
  return {
    ask,
    contents,
    wc: contents as unknown as WebContents,
    check: session.setPermissionCheckHandler.mock.calls[0]![0]!,
    request: session.setPermissionRequestHandler.mock.calls[0]![0]!,
  };
}
const audio = {
  isMainFrame: true,
  requestingUrl: "app://opensteer/",
  securityOrigin: "app://opensteer",
  mediaTypes: ["audio"] as Array<"audio" | "video">,
};

it("checks only main-frame app audio, preserving USB checks", () => {
  const f = fixture();
  const details = { ...audio, mediaType: "audio" as const };
  expect(f.check(f.wc, "media", "app://opensteer", details)).toBe(true);
  for (const extra of [
    { mediaType: "video" as const },
    { mediaType: "unknown" as const },
    { isMainFrame: false },
    { requestingUrl: "https://evil.test" },
  ]) {
    expect(f.check(f.wc, "media", "app://opensteer", { ...details, ...extra })).toBe(false);
  }
  expect(f.check(f.wc, "media", "https://evil.test", details)).toBe(false);
  expect(f.check(f.wc, "media", "app://opensteer", audio)).toBe(false);
  expect(f.check(null, "media", "app://opensteer", details)).toBe(false);
  expect(f.check(f.wc, "usb", "app://opensteer", details)).toBe(true);
  expect(f.check(f.wc, "display-capture", "app://opensteer", details)).toBe(false);
  expect(f.ask).not.toHaveBeenCalled();
});

it("requests OS consent only for exactly audio from the main app page", async () => {
  const f = fixture();
  for (const extra of [
    { mediaTypes: [] },
    { mediaTypes: ["video"] },
    { mediaTypes: ["audio", "video"] },
    { mediaTypes: undefined },
    { isMainFrame: false },
    { securityOrigin: "https://evil.test" },
    { requestingUrl: "https://evil.test" },
  ]) {
    const callback = vi.fn();
    f.request(f.wc, "media", callback, {
      ...audio,
      ...extra,
    } as Electron.MediaAccessPermissionRequest);
    expect(callback).toHaveBeenCalledWith(false);
  }
  const denied = vi.fn();
  f.request(f.wc, "display-capture", denied, audio);
  expect(denied).toHaveBeenCalledWith(false);
  expect(f.ask).not.toHaveBeenCalled();
  for (const granted of [true, false]) {
    f.ask.mockResolvedValueOnce(granted);
    const callback = vi.fn();
    f.request(f.wc, "media", callback, audio);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(granted));
  }
  f.ask.mockRejectedValueOnce(new Error("unavailable"));
  const failed = vi.fn();
  f.request(f.wc, "media", failed, audio);
  await vi.waitFor(() => expect(failed).toHaveBeenCalledWith(false));
});

it("denies consent that resolves after destruction or navigation away", async () => {
  const f = fixture();
  let resolve!: (allowed: boolean) => void;
  f.ask.mockImplementationOnce(
    () =>
      new Promise<boolean>((done) => {
        resolve = done;
      }),
  );
  const callback = vi.fn();
  f.request(f.wc, "media", callback, audio);
  f.contents.getURL.mockReturnValue("https://evil.test");
  resolve(true);
  await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(false));
  f.contents.isDestroyed.mockReturnValue(true);
  expect(f.check(f.wc, "media", "app://opensteer", { ...audio, mediaType: "audio" })).toBe(false);
});
