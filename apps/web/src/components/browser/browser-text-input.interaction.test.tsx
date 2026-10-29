// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrowserEditingStore,
  type BrowserCommand,
  type BrowserFrameStore,
  type BrowserFrameView,
} from "@opensteer/client/host";
import { BrowserSurfaceIdSchema } from "@opensteer/protocol";
import { BrowserViewport } from "./browser-viewport.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const firstSurface = BrowserSurfaceIdSchema.parse("srf_00000000-0000-4000-8000-000000000001");
const secondSurface = BrowserSurfaceIdSchema.parse("srf_00000000-0000-4000-8000-000000000002");
const paints: FrameRequestCallback[] = [];
let root: Root | null = null;

beforeEach(() => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 800, height: 600, close: vi.fn() })),
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => paints.push(callback));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
    clearRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  paints.length = 0;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function frame(surfaceId = firstSurface): BrowserFrameView {
  return {
    data: Uint8Array.from([0xff, 0xd8, 0xff]).buffer,
    header: {
      encoding: "jpeg",
      frameId: 1,
      rasterHeight: 600,
      rasterWidth: 800,
      surfaceId,
      viewportHeight: 600,
      viewportWidth: 800,
    },
  };
}
type ViewOptions = {
  activeSurfaceId: BrowserFrameView["header"]["surfaceId"];
  canInput: boolean;
  occluded: boolean;
  sessionId: string;
  visible: boolean;
};
async function setup(editing?: BrowserEditingStore) {
  let picture: BrowserFrameView | null = frame();
  let pictureSession = "browser-a";
  let options: ViewOptions = {
    activeSurfaceId: firstSurface,
    canInput: true,
    occluded: false,
    sessionId: pictureSession,
    visible: true,
  };
  const changed = new Set<() => void>();
  const frames: BrowserFrameStore = {
    ...(editing ? { editing } : {}),
    get: (id) => (id === pictureSession ? picture : null),
    subscribe: (_id, listener) => {
      changed.add(listener);
      return () => changed.delete(listener);
    },
  };
  const commands: BrowserCommand[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render = (update: Partial<ViewOptions> = {}) =>
    act(() => {
      options = { ...options, ...update };
      root?.render(
        <BrowserViewport
          {...options}
          frames={frames}
          live
          onCommand={(command) => commands.push(command)}
          onOpenLink={() => undefined}
        />,
      );
    });
  const present = () =>
    act(async () => {
      // Let the bitmap promise settle, then submit its scheduled canvas draw.
      for (let index = 0; index < 6; index++) await Promise.resolve();
      for (const paint of paints.splice(0)) paint(performance.now());
    });
  const receive = (next: BrowserFrameView | null, sessionId = options.sessionId) =>
    act(() => {
      picture = next;
      pictureSession = sessionId;
      for (const listener of changed) listener();
    });
  render();
  await present();
  return { commands, container, present, receive, render };
}
function keyboard(container: HTMLElement): HTMLTextAreaElement {
  const input = container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Browser keyboard input"]',
  );
  if (!input) throw new Error("The live browser has no native text entry surface for IME input.");
  input.focus();
  return input;
}
function input(
  target: HTMLTextAreaElement,
  text: string,
  isComposing = false,
  inputType = "insertText",
) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      target,
      text,
    );
    target.dispatchEvent(
      new InputEvent("input", { bubbles: true, data: text, inputType, isComposing }),
    );
  });
}
function composition(
  target: HTMLTextAreaElement,
  type: "compositionstart" | "compositionend",
  data = "",
) {
  const event = new CompositionEvent(type, { bubbles: true, data });
  Object.defineProperty(event, "data", { value: data });
  void act(() => target.dispatchEvent(event));
}
function textCommands(commands: readonly BrowserCommand[]) {
  return commands.filter((command) => command.type === "clipboard.paste");
}

describe("browser text entry through the presented page", async () => {
  it("enables password field Paste while disabling menu Copy and Cut", async () => {
    const editing = new BrowserEditingStore(vi.fn());
    editing.negotiate("browser-a", 1);
    const { container } = await setup(editing);
    const viewport = container.querySelector<HTMLElement>(".browser-canvas")!;
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
      width: 400,
      height: 300,
      top: 0,
      left: 0,
    } as DOMRect);
    act(() => {
      editing.receive("browser-a", {
        type: "browser.editing",
        surfaceId: firstSurface,
        context: {
          contextId: "00000000-0000-4000-8000-000000000001",
          field: { kind: "text", multiline: false, sensitive: true, inputMode: "text" },
          caret: null,
        },
      });
      editing.receive("browser-a", {
        type: "browser.contextmenu",
        surfaceId: firstSurface,
        editable: true,
        selection: true,
        x: 0.5,
        y: 0.5,
      });
    });
    expect(
      Object.fromEntries(
        [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].map((item) => [
          item.textContent,
          item.disabled,
        ]),
      ),
    ).toMatchObject({ Paste: false, Copy: true, Cut: true });
  });
  it("focuses native text entry on a page click while preserving frame coordinates", async () => {
    const { commands, container } = await setup();
    const viewport = container.querySelector<HTMLElement>(".browser-canvas")!;
    Object.assign(viewport, { setPointerCapture: vi.fn() });
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
      width: 400,
      height: 300,
      top: 0,
      left: 0,
    } as DOMRect);
    void act(() =>
      viewport.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: 200,
          clientY: 150,
          pointerId: 1,
        }),
      ),
    );
    expect(document.activeElement).toBe(
      container.querySelector('textarea[aria-label="Browser keyboard input"]'),
    );
    expect(commands.at(-1)).toMatchObject({
      type: "input.pointer",
      action: "down",
      surfaceId: firstSurface,
      x: 0.5,
      y: 0.5,
      viewportWidth: 800,
      viewportHeight: 600,
    });
  });

  it("sends printable text once and keeps navigation keys on their physical key path", async () => {
    const { commands, container } = await setup();
    const target = keyboard(container);
    void act(() =>
      target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, code: "KeyA", key: "a" })),
    );
    input(target, "a");
    expect(textCommands(commands)).toEqual([]);
    expect(commands.filter((command) => command.type === "input.key" && command.text)).toEqual([
      {
        type: "input.key",
        surfaceId: firstSurface,
        action: "down",
        key: "a",
        code: "KeyA",
        modifiers: [],
        text: "a",
      },
    ]);
    await act(async () => {
      await Promise.resolve();
    });
    expect(target.value).toBe("");
    for (const type of ["keydown", "keyup"])
      void act(() =>
        target.dispatchEvent(
          new KeyboardEvent(type, { bubbles: true, code: "ArrowDown", key: "ArrowDown" }),
        ),
      );
    expect(
      commands.flatMap((command) =>
        command.type === "input.key" && command.key === "ArrowDown" ? [command.action] : [],
      ),
    ).toEqual(["down", "up"]);
  });

  it("commits an IME word once after ignoring interim input and the duplicate final input", async () => {
    const { commands, container } = await setup();
    const target = keyboard(container);
    composition(target, "compositionstart");
    void act(() =>
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Process",
          code: "KeyG",
          isComposing: true,
        }),
      ),
    );
    input(target, "한", true, "insertCompositionText");
    input(target, "한글", true, "insertCompositionText");
    expect(textCommands(commands)).toEqual([]);
    composition(target, "compositionend", "한글");
    input(target, "한글", false, "insertCompositionText");
    expect(textCommands(commands)).toEqual([
      { type: "clipboard.paste", surfaceId: firstSurface, text: "한글" },
    ]);
  });

  it("refuses synthetic clipboard events without sending a remote clipboard shortcut", async () => {
    const { commands, container } = await setup();
    const target = keyboard(container);
    act(() => {
      target.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "v", code: "KeyV", metaKey: true }),
      );
      const paste = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(paste, "clipboardData", {
        value: { getData: () => "local clipboard" },
      });
      target.dispatchEvent(paste);
    });
    expect(textCommands(commands)).toEqual([]);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("trusted");
    expect(
      commands.filter((command) => command.type === "input.key" && command.key === "v"),
    ).toEqual([]);
  });

  it("does not commit unfinished text after a click moves focus within the same page", async () => {
    const { commands, container } = await setup();
    const target = keyboard(container);
    composition(target, "compositionstart");
    input(target, "한", true, "insertCompositionText");
    const viewport = container.querySelector<HTMLElement>(".browser-canvas")!;
    Object.assign(viewport, { setPointerCapture: vi.fn() });
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
      width: 400,
      height: 300,
      top: 0,
      left: 0,
    } as DOMRect);
    void act(() =>
      viewport.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: 200,
          clientY: 150,
          pointerId: 1,
        }),
      ),
    );
    composition(target, "compositionend", "한글");
    input(target, "한글", false, "insertCompositionText");
    const clicked = commands.findIndex(
      (command) => command.type === "input.pointer" && command.action === "down",
    );
    expect(clicked).toBeGreaterThanOrEqual(0);
    expect(textCommands(commands.slice(0, clicked))).toEqual([
      { type: "clipboard.paste", surfaceId: firstSurface, text: "한" },
    ]);
    expect(textCommands(commands.slice(clicked + 1))).toEqual([]);
    const current = keyboard(container);
    void act(() =>
      current.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "한", code: "KeyG" }),
      ),
    );
    input(current, "한");
    expect(textCommands(commands.slice(clicked + 1))).toEqual([]);
    expect(
      commands.slice(clicked + 1).filter((command) => command.type === "input.key" && command.text),
    ).toEqual([
      {
        type: "input.key",
        surfaceId: firstSurface,
        action: "down",
        key: "한",
        code: "KeyG",
        modifiers: [],
        text: "한",
      },
    ]);
  });

  it.each(["tab", "session", "frame", "hidden", "occluded", "disabled"] as const)(
    "fences late IME events when its %s becomes unavailable",
    async (change) => {
      const { commands, container, receive, render } = await setup();
      const target = keyboard(container);
      composition(target, "compositionstart");
      input(target, "private draft", true, "insertCompositionText");
      if (change === "tab") render({ activeSurfaceId: secondSurface });
      if (change === "session") render({ sessionId: "browser-b" });
      if (change === "frame") receive(null);
      if (change === "hidden") render({ visible: false });
      if (change === "occluded") render({ occluded: true });
      if (change === "disabled") render({ canInput: false });
      composition(target, "compositionend", "private draft");
      input(target, "private draft", false, "insertCompositionText");
      expect(textCommands(commands)).toEqual(
        change === "tab" || change === "session"
          ? [{ type: "clipboard.paste", surfaceId: firstSurface, text: "private draft" }]
          : [],
      );
    },
  );

  it("does not carry unfinished text into the next presented tab", async () => {
    const { commands, container, present, receive, render } = await setup();
    const previous = keyboard(container);
    composition(previous, "compositionstart");
    input(previous, "old tab draft", true, "insertCompositionText");
    render({ activeSurfaceId: secondSurface });
    receive(frame(secondSurface));
    await present();
    composition(previous, "compositionend", "old tab draft");
    input(previous, "old tab draft", false, "insertCompositionText");
    expect(textCommands(commands)).toEqual([
      { type: "clipboard.paste", surfaceId: firstSurface, text: "old tab draft" },
    ]);
    const current = keyboard(container);
    input(current, "next page");
    expect(textCommands(commands)).toEqual([
      { type: "clipboard.paste", surfaceId: firstSurface, text: "old tab draft" },
      { type: "clipboard.paste", surfaceId: secondSurface, text: "next page" },
    ]);
  });
});
