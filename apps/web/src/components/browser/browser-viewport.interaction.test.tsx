// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import {
  BrowserPopupStore,
  type BrowserCommand,
  type BrowserFrameStore,
} from "@opensteer/client/host";
import { browserVideoFrameView } from "@opensteer/client/host/browser-video";
import { browserVideoTestHeader } from "@opensteer/protocol/test-support/browser-video";
import { BrowserSurfaceIdSchema, TargetedBrowserClientMessageSchema } from "@opensteer/protocol";
import { BrowserViewport } from "./browser-viewport.js";

vi.mock("../remote-editing/remote-editing-proxy.js", () => ({ RemoteEditingProxy: () => null }));
vi.mock("./browser-presenter.js", async () => {
  const { browserVideoTestHeader: header } =
    await import("@opensteer/protocol/test-support/browser-video");
  const { browserVideoFrameView: view } = await import("@opensteer/client/host/browser-video");
  return {
    attachBrowserCanvas: (
      _source: unknown,
      _session: string,
      surface: string,
      _targeted: boolean,
      _canvas: HTMLCanvasElement,
      present: (frame: ReturnType<typeof view>) => void,
    ) => {
      queueMicrotask(() => present(view(surface, header)));
      return () => undefined;
    },
    sampleBrowserVideo: (canvas: HTMLCanvasElement) => ({
      header,
      point: { x: 64, y: 64 },
      rect: canvas.getBoundingClientRect(),
    }),
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});

it("keeps wheel, touch scroll, hover, right/middle buttons and drag on ordered input while guarding left clicks", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  const rect = {
    left: 0,
    top: 0,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    right: 100,
    bottom: 100,
    toJSON: () => ({}),
  };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect);
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: vi.fn(),
  });
  const surface = BrowserSurfaceIdSchema.parse("tab");
  const frame = browserVideoFrameView(surface, browserVideoTestHeader);
  const video = {
    selected: () => true,
    budget: vi.fn(),
    onFrame: () => () => {},
    state: () => null,
    presented: vi.fn(),
    failed: vi.fn(),
    retry: vi.fn(),
    keyframe: vi.fn(),
    click: vi.fn(),
  };
  const popups = new BrowserPopupStore(vi.fn());
  const frames: BrowserFrameStore = { video, popups, get: () => frame, subscribe: () => () => {} };
  const commands: BrowserCommand[] = [];
  const send = (command: BrowserCommand) => {
    TargetedBrowserClientMessageSchema.parse(command);
    commands.push(command);
  };
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () =>
      root.render(
        <BrowserViewport
          activeSurfaceId={surface}
          canInput
          frames={frames}
          live
          visible
          occluded={false}
          targeted
          sessionId="session"
          pageFollowsView={false}
          onCommand={send}
          onOpenLink={() => {}}
        />,
      ),
    );
    const viewport = element.querySelector<HTMLElement>("[data-live-page]")!;
    const pointer = async (type: string, input: PointerEventInit) => {
      await act(async () => {
        viewport.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: 50,
            clientY: 50,
            pointerId: 1,
            pointerType: "mouse",
            ...input,
          }),
        );
        await vi.advanceTimersByTimeAsync(0);
      });
    };
    await act(async () => {
      const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 40 });
      // happy-dom's WheelEvent omits its inherited mouse coordinates.
      Object.defineProperties(wheel, { clientX: { value: 50 }, clientY: { value: 50 } });
      viewport.dispatchEvent(wheel);
    });
    await pointer("pointermove", { buttons: 0 });
    for (const button of [1, 2]) {
      await pointer("pointerdown", { button, buttons: button === 1 ? 4 : 2 });
      await pointer("pointerup", { button, buttons: 0 });
    }
    await pointer("pointerdown", { button: 0, buttons: 1 });
    await pointer("pointermove", { clientX: 70, button: 0, buttons: 1 });
    await pointer("pointerup", { clientX: 70, button: 0, buttons: 0 });
    const hoverCount = commands.filter(
      (c) => c.type === "input.pointer" && c.action === "move" && c.buttons === 0,
    ).length;
    act(() => {
      viewport.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: 50,
          clientY: 50,
          pointerId: 1,
          pointerType: "mouse",
          buttons: 0,
        }),
      );
    });
    await pointer("pointerdown", { button: 0, buttons: 1 });
    await pointer("pointerup", { button: 0, buttons: 0 });
    expect(
      commands.filter((c) => c.type === "input.pointer" && c.action === "move" && c.buttons === 0),
    ).toHaveLength(hoverCount);
    await pointer("pointerdown", { pointerType: "touch", button: 0, buttons: 1 });
    await pointer("pointermove", { pointerType: "touch", clientY: 70, buttons: 1 });
    await pointer("pointerup", { pointerType: "touch", clientY: 70, buttons: 0 });
    expect(video.click).toHaveBeenCalledOnce();
    expect(commands.filter((c) => c.type === "input.wheel")).toHaveLength(2);
    expect(commands).toContainEqual(
      expect.objectContaining({
        type: "input.pointer",
        action: "move",
        buttons: 0,
        geometryRevision: 1,
      }),
    );
    for (const button of ["middle", "right", "left"])
      for (const action of ["down", "up"])
        expect(commands).toContainEqual(
          expect.objectContaining({ type: "input.pointer", button, action, geometryRevision: 1 }),
        );
    await pointer("pointermove", { buttons: 0 });
    act(() => {
      popups.negotiate("session", surface, true);
      popups.receive("session", {
        type: "browser.video.attached",
        surfaceId: surface,
        streamId: browserVideoTestHeader.streamId,
        mediaToken: "a".repeat(43),
      });
      popups.receive("session", {
        type: "browser.input.control",
        surfaceId: surface,
        streamId: browserVideoTestHeader.streamId,
        state: "self",
      });
      popups.receive("session", {
        type: "browser.popup.opened",
        surfaceId: surface,
        streamId: browserVideoTestHeader.streamId,
        documentGeneration: "d",
        authorityEpoch: "e",
        popupId: "p",
        revision: "1",
        state: { kind: "select", multiple: false, rtl: false, items: [] },
      });
    });
    expect(popups.target("session", surface).get().popup).not.toBeNull();
    const beforeLeave = commands.length;
    await pointer("pointerout", { buttons: 0, relatedTarget: document.body });
    expect(commands).toHaveLength(beforeLeave);
  } finally {
    await act(async () => root.unmount());
    delete (HTMLElement.prototype as Partial<HTMLElement>).setPointerCapture;
  }
});
