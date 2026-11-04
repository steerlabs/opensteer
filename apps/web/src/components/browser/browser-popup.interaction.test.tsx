// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserPopupStore } from "@opensteer/client/host";
import {
  BrowserSurfaceIdSchema,
  DisplayStreamIdSchema,
  type BrowserPopupState,
} from "@opensteer/protocol";
import { BrowserPopup } from "./browser-popup.js";
vi.mock("../native-browser-overlays.js", () => ({ useNativeBrowserOverlay: () => true }));
afterEach(() => document.body.replaceChildren());
const surfaceId = BrowserSurfaceIdSchema.parse("page"),
  streamId = DisplayStreamIdSchema.parse("dsp_00000000-0000-4000-8000-000000000001");
const ref = {
  surfaceId,
  streamId,
  documentGeneration: "d",
  authorityEpoch: "a",
  popupId: "p",
  revision: "1",
};
function fixture(state: BrowserPopupState) {
  const send = vi.fn();
  const store = new BrowserPopupStore(send);
  store.negotiate("s", surfaceId, true);
  store.receive("s", {
    type: "browser.video.attached",
    surfaceId,
    streamId,
    mediaToken: "a".repeat(43),
  });
  store.receive("s", { type: "browser.input.control", surfaceId, streamId, state: "self" });
  store.receive("s", { type: "browser.popup.opened", ...ref, state });
  const div = document.createElement("div");
  document.body.append(div);
  const root = createRoot(div);
  act(() =>
    root.render(<BrowserPopup store={store} sessionId="s" surfaceId={surfaceId} visible />),
  );
  return { send, store, root, div };
}
it("shows groups and disabled rows and commits an empty editable multiple selection", () => {
  const f = fixture({
    kind: "select",
    multiple: true,
    rtl: true,
    items: [
      {
        id: "g",
        kind: "group",
        label: "Group",
        enabled: true,
        selected: false,
        rtl: true,
        directionOverride: false,
      },
      {
        id: "a",
        groupId: "g",
        kind: "option",
        label: "Choice",
        enabled: true,
        selected: true,
        rtl: true,
        directionOverride: true,
      },
      {
        id: "d",
        kind: "option",
        label: "Disabled",
        enabled: false,
        selected: true,
        rtl: false,
        directionOverride: false,
      },
    ],
  });
  const select = f.div.querySelector("select")!;
  expect(select.multiple).toBe(true);
  expect(select.querySelector("optgroup")?.label).toBe("Group");
  expect(select.options[1]?.disabled).toBe(true);
  act(() => {
    for (const o of select.options) o.selected = false;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  act(() => {
    f.div
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(f.send.mock.calls.at(-1)?.[2]).toMatchObject({
    type: "popup.answer",
    answer: { itemIds: [] },
  });
  act(() => f.root.unmount());
});
it("preserves alpha/P3 exact value until explicit Done and discards the draft on revision", () => {
  const original = "color(display-p3 0.9 0.2 0.1 / 0.35)";
  const f = fixture({
    kind: "color",
    rtl: false,
    items: [],
    alpha: true,
    colorSpace: "display-p3",
    value: original,
  });
  expect(f.div.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe(original);
  expect(f.send).not.toHaveBeenCalled();
  act(() =>
    f.store.receive("s", {
      type: "browser.popup.updated",
      ...ref,
      revision: "2",
      state: {
        kind: "color",
        rtl: false,
        items: [],
        alpha: true,
        colorSpace: "display-p3",
        value: "#12345678",
      },
    }),
  );
  expect(f.div.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe("#12345678");
  expect(f.div.textContent).toContain("Choices changed");
  act(() => f.root.unmount());
});
it("suggestion activation prevents proxy blur and submits its opaque ID once", () => {
  const f = fixture({
    kind: "datalist",
    rtl: false,
    items: [
      {
        id: "id",
        kind: "suggestion",
        label: "Shown",
        secondaryLabel: "Detail",
        enabled: true,
        selected: false,
        rtl: false,
        directionOverride: false,
      },
    ],
  });
  const row = f.div.querySelector<HTMLButtonElement>('[role="option"]')!;
  const down = new Event("pointerdown", { bubbles: true, cancelable: true });
  act(() => {
    row.dispatchEvent(down);
  });
  expect(down.defaultPrevented).toBe(true);
  act(() => row.click());
  expect(f.send.mock.calls.at(-1)?.[2]).toMatchObject({ answer: { itemIds: ["id"] } });
  expect(f.div.textContent).toContain("Detail");
  act(() => f.root.unmount());
});
