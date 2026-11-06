// @vitest-environment happy-dom
import { act, type CSSProperties, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserPopupStore } from "@opensteer/client/host";
import {
  BrowserSurfaceIdSchema,
  DisplayStreamIdSchema,
  type BrowserPopupState,
} from "@opensteer/protocol";
import type { BrowserPopupNativeAction } from "../../modules/browser-popup/index.js";
import { BrowserPopup } from "./browser-popup.js";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const native = vi.hoisted(() => ({
  present: vi.fn(async (_id: string, _revision: string, _state: unknown) => true),
  update: vi.fn(async (_id: string, _revision: string, _state: unknown) => true),
  dismiss: vi.fn(async (_id: string) => undefined),
  listener: null as null | ((event: BrowserPopupNativeAction) => void),
  background: null as null | ((state: string) => void),
  supported: true,
}));
vi.mock("../../modules/browser-popup/index.js", () => {
  const module = {
    popupPresentationVersion: 1,
    present: native.present,
    update: native.update,
    dismiss: native.dismiss,
    addListener: (_: string, fn: (e: BrowserPopupNativeAction) => void) => {
      native.listener = fn;
      return {
        remove: () => {
          if (native.listener === fn) native.listener = null;
        },
      };
    },
  };
  return { browserPopupNative: () => (native.supported ? module : null) };
});
vi.mock("react-native", () => ({
  View: ({ children, style }: { children: ReactNode; style?: CSSProperties }) => (
    <div style={style}>{children}</div>
  ),
  useWindowDimensions: () => ({ fontScale: 1.5 }),
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Pressable: ({
    children,
    onPress,
    disabled,
  }: {
    children: ReactNode;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onPress} disabled={disabled}>
      {children}
    </button>
  ),
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AppState: {
    addEventListener: (_: string, fn: (s: string) => void) => {
      native.background = fn;
      return {
        remove: () => {
          native.background = null;
        },
      };
    },
  },
}));
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
beforeEach(() => {
  native.present.mockClear();
  native.update.mockClear();
  native.dismiss.mockClear();
  native.supported = true;
});
afterEach(() => document.body.replaceChildren());
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
  act(() => root.render(<BrowserPopup store={store} sessionId="s" surfaceId={surfaceId} active />));
  return { send, store, root, div };
}
const select: BrowserPopupState = { kind: "select", multiple: true, rtl: false, items: [] };
it("reserves the same typing strip through picker, control and suggestion changes", () => {
  const f = fixture(select);
  const strip = f.div.firstElementChild as HTMLElement;
  expect(strip.style.height).toBe("108px");
  act(() =>
    f.store.receive("s", {
      type: "browser.popup.updated",
      ...ref,
      revision: "2",
      state: { kind: "datalist", rtl: false, items: [] },
    }),
  );
  expect(strip.style.height).toBe("108px");
  act(() =>
    f.store.receive("s", {
      type: "browser.input.control",
      surfaceId,
      streamId,
      state: "other",
    }),
  );
  expect(strip.style.height).toBe("108px");
  act(() => f.root.unmount());
});
it("keeps Cancel alive during a pending native commit and fences Done after background", () => {
  const f = fixture(select);
  const id = native.present.mock.calls[0]?.[0] as string;
  act(() =>
    native.listener?.({
      presentationId: id,
      revision: "1",
      action: "commit",
      answer: { itemIds: [] },
    }),
  );
  act(() =>
    native.listener?.({
      presentationId: id,
      revision: "1",
      action: "commit",
      answer: { itemIds: [] },
    }),
  );
  expect(f.send.mock.calls.filter((c) => c[2].type === "popup.answer")).toHaveLength(1);
  const late = native.listener;
  act(() => native.background?.("background"));
  expect(f.store.target("s", surfaceId).get().popup).toBeNull();
  act(() =>
    late?.({ presentationId: id, revision: "1", action: "commit", answer: { itemIds: [] } }),
  );
  expect(f.send.mock.calls.filter((c) => c[2].type === "popup.answer")).toHaveLength(1);
  expect(native.dismiss).toHaveBeenCalled();
  act(() => f.root.unmount());
});
it("replaces a native draft on revision and rejects its older callback", () => {
  const f = fixture(select);
  const id = native.present.mock.calls[0]?.[0] as string;
  act(() =>
    f.store.receive("s", { type: "browser.popup.updated", ...ref, revision: "2", state: select }),
  );
  expect(native.update).toHaveBeenCalled();
  act(() =>
    native.listener?.({
      presentationId: id,
      revision: "1",
      action: "commit",
      answer: { itemIds: [] },
    }),
  );
  expect(f.send).not.toHaveBeenCalled();
  act(() => f.root.unmount());
});
