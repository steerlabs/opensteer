import { expect, it, vi } from "vitest";
import { BrowserPasskeys, passkeyNotice } from "./browser-passkeys.js";
const requestId = "e2799da2-9fe9-438e-a160-47e275ee2703";
it("opts in only after Host capability negotiation and never claims from a notice viewer", async () => {
  const present = vi.fn(async () => {});
  const native = new BrowserPasskeys({ mode: "native", present });
  expect(native.optIn([])).toBeUndefined();
  expect(native.optIn(["browser-passkeys-v1"])).toBe("native");
  native.receive("session", "tab", { type: "browser.snapshot", passkeys: "native" });
  native.receive("session", "tab", {
    type: "browser.passkey.offer",
    requestId,
    rpId: "example.test",
    op: "get",
    surfaceId: "tab",
    agent: true,
    deadline: Date.now() + 1000,
  });
  expect(native.get("session", "tab")).toMatchObject({
    kind: "offer",
    agent: true,
    rpId: "example.test",
  });
  await native.continue("session", "tab");
  expect(present).toHaveBeenCalledExactlyOnceWith(requestId);
  native.receive("session", "tab", { type: "browser.passkey.withdrawn", requestId });
  expect(native.get("session", "tab")).toBeNull();
  const notice = new BrowserPasskeys();
  expect(notice.optIn(["browser-passkeys-v1"])).toBe("notice");
  notice.receive("session", "tab", { type: "browser.snapshot", passkeys: "notice" });
  notice.receive("session", "tab", { type: "browser.passkey.notice", surfaceId: "tab" });
  expect(notice.get("session", "tab")).toMatchObject({ kind: "notice" });
  await notice.continue("session", "tab");
  expect(present).toHaveBeenCalledTimes(1);
  notice.disconnect("session", "tab");
  expect(notice.get("session", "tab")).toBeNull();
  expect(passkeyNotice).toBe(
    "Passkeys work when you open this tab in the Opensteer app on your Mac",
  );
});
it("ignores messages without opt-in, clears on disconnect and scopes requests to a surface", () => {
  const store = new BrowserPasskeys();
  const listener = vi.fn();
  store.subscribe("session", "tab", listener);
  const offer = {
    type: "browser.passkey.offer" as const,
    requestId,
    surfaceId: "tab",
    rpId: "example.test",
    op: "get" as const,
    deadline: Date.now() + 1000,
  };
  store.receive("session", "tab", offer);
  expect(store.get("session", "tab")).toBeNull();
  store.receive("session", "tab", { type: "browser.snapshot", passkeys: "notice" });
  store.receive("session", "other", offer);
  expect(listener).not.toHaveBeenCalled();
  store.receive("session", "tab", offer);
  expect(store.get("session", "tab")).toMatchObject({ kind: "notice" });
  expect(listener).toHaveBeenCalledTimes(1);
  store.disconnect("session", "tab");
});
