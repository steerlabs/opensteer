import { describe, expect, it, vi } from "vitest";
import { BrowserPopupStore, browserClickStatus } from "./browser-popup.js";
import {
  BrowserSurfaceIdSchema,
  DisplayStreamIdSchema,
  type BrowserPopupRef,
} from "@opensteer/protocol";
const surface = BrowserSurfaceIdSchema.parse("surf_00000000-0000-4000-8000-000000000001");
const streamId = DisplayStreamIdSchema.parse("dsp_00000000-0000-4000-8000-000000000001");
const ref: BrowserPopupRef = {
  surfaceId: surface,
  streamId,
  documentGeneration: "d",
  authorityEpoch: "a",
  popupId: "p",
  revision: "1",
};
const state = {
  kind: "select" as const,
  multiple: false,
  rtl: false,
  items: [
    {
      id: "i",
      kind: "option" as const,
      label: "synthetic-secret-canary",
      enabled: true,
      selected: false,
      rtl: false,
      directionOverride: false,
    },
  ],
};
function fixture() {
  const send = vi.fn();
  const store = new BrowserPopupStore(send);
  const target = store.target("session", surface);
  store.negotiate("session", surface, true);
  store.receive("session", {
    type: "browser.video.attached",
    surfaceId: surface,
    streamId,
    mediaToken: "a".repeat(43),
  });
  store.receive("session", {
    type: "browser.input.control",
    surfaceId: surface,
    streamId,
    state: "self",
  });
  store.receive("session", { type: "browser.popup.opened", ...ref, state });
  return { store, target, send };
}
describe("controller-local popup state", () => {
  it("invalidates drafts on revision and never sends an old answer as a new revision", () => {
    const f = fixture();
    f.store.receive("session", { type: "browser.popup.updated", ...ref, revision: "2", state });
    expect(f.target.answer(ref, { itemIds: ["i"] })).toBe(false);
    expect(f.target.get().notice).toBe("Choices changed. Choose again.");
    expect(f.send).not.toHaveBeenCalled();
  });
  it("retains a successor after the old popup closes and fences callbacks on disconnect", () => {
    const f = fixture();
    const next = { ...ref, popupId: "next" };
    f.store.receive("session", { type: "browser.popup.opened", ...next, state });
    f.store.receive("session", { type: "browser.popup.closed", ...ref, reason: "applied" });
    expect(f.target.get().popup?.ref.popupId).toBe("next");
    f.store.disconnect("session", surface);
    expect(f.target.get().popup).toBeNull();
    expect(f.target.answer(next, { itemIds: ["i"] })).toBe(false);
    expect(f.send).not.toHaveBeenCalled();
  });
  it("submits once, then resolves uncertain without replay", () => {
    vi.useFakeTimers();
    const f = fixture();
    expect(f.target.answer(ref, { itemIds: ["i"] })).toBe(true);
    expect(f.target.answer(ref, { itemIds: ["i"] })).toBe(false);
    vi.runAllTimers();
    expect(f.target.get().popup).toBeNull();
    expect(f.send.mock.calls.filter((c) => c[2].type === "popup.answer")).toHaveLength(1);
    f.store.dispose();
    vi.useRealTimers();
  });
  it("uses coarse refusal messages with no automatic retry", () => {
    expect(browserClickStatus({ outcome: "refused", reason: "stale" })).toBe(
      "The page changed. Tap again.",
    );
  });
});
