// @vitest-environment happy-dom
import { act, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserSessionIdSchema, BrowserSurfaceIdSchema } from "@opensteer/core";
import {
  DesktopBrowserPresentationIdSchema,
  type DesktopBrowserPresentationEvent,
} from "@opensteer/protocol/desktop";
import { useBrowserPresentationWait } from "@opensteer/client/react";
import { useNativeBrowserPresentation } from "./native-browser-presentation.js";

const bridge = vi.hoisted(() => ({
  present: vi.fn(),
  update: vi.fn(),
  release: vi.fn(async () => {}),
  listeners: new Set<(event: DesktopBrowserPresentationEvent) => void>(),
}));
vi.mock("../../desktop/desktop-bridge.js", () => ({
  desktopBridge: () => ({
    browserPresentation: {
      present: bridge.present,
      update: bridge.update,
      release: bridge.release,
      onEvent: (listener: (event: DesktopBrowserPresentationEvent) => void) => {
        bridge.listeners.add(listener);
        return () => bridge.listeners.delete(listener);
      },
    },
  }),
}));
vi.mock("../native-browser-overlays.js", () => ({
  nativeBrowserPresented: vi.fn(),
  nativeBrowserPresentationPending: () => () => {},
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  bridge.listeners.clear();
  document.body.replaceChildren();
});

it("releases a native mount with no paint at the action deadline and retries that same page", async () => {
  vi.useFakeTimers();
  bridge.present.mockReset();
  bridge.release.mockClear();
  const sessionId = BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000001");
  const surfaceId = BrowserSurfaceIdSchema.parse("page-1");
  const target = () => ({
    presentationId: DesktopBrowserPresentationIdSchema.parse(crypto.randomUUID()),
    revision: 0,
  });
  bridge.present.mockImplementation(async () => target());
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    top: 0,
    left: 0,
    bottom: 600,
    right: 800,
    toJSON: () => ({}),
  });
  const deadline = Date.now() + 1000;
  const client = { browserPresentationDeadline: () => deadline };
  function Page() {
    const stage = useRef<HTMLDivElement>(null);
    const wait = useBrowserPresentationWait(client, sessionId, surfaceId, true);
    const native = useNativeBrowserPresentation({
      active: !wait.error,
      handoff: wait.error ? "terminal" : "admitted",
      admissionId: "admitted",
      sessionId,
      surfaceId,
      stageRef: stage,
    });
    useEffect(() => {
      if (native.placement) wait.presented();
    }, [native.placement, wait.presented]);
    return (
      <div ref={stage}>
        {wait.error ? (
          <>
            <span role="alert">{wait.error}</span>
            <button onClick={wait.retry}>Retry viewing</button>
          </>
        ) : (
          "Opening"
        )}
      </div>
    );
  }
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<Page />));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20);
  });
  expect(bridge.present).toHaveBeenCalledOnce();
  const first = await bridge.present.mock.results[0]!.value;
  const oldListener = [...bridge.listeners][0]!;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(980);
  });
  expect(container.textContent).toContain("could not be shown");
  expect(bridge.release).toHaveBeenCalledWith(first);
  act(() =>
    oldListener({
      type: "placed",
      presentationId: first.presentationId,
      revision: 0,
    } as unknown as DesktopBrowserPresentationEvent),
  );
  expect(container.textContent).toContain("could not be shown");
  act(() => container.querySelector("button")!.click());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20);
  });
  expect(bridge.present).toHaveBeenCalledTimes(2);
  expect(bridge.present).toHaveBeenLastCalledWith({
    sessionId,
    surfaceId,
    rect: { x: 0, y: 0, width: 800, height: 600 },
  });
});
