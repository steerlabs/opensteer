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
import { BrowserCursorStore } from "@opensteer/client/host";
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
  vi.useRealTimers();
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
// Happy DOM's WheelEvent omits inherited mouse coordinates.
function wheelEvent(clientX: number, clientY: number, deltaY: number): WheelEvent {
  return Object.assign(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY }), {
    clientX,
    clientY,
  });
}
type ViewOptions = {
  activeSurfaceId: BrowserFrameView["header"]["surfaceId"];
  canInput: boolean;
  occluded: boolean;
  sessionId: string;
  visible: boolean;
  live: boolean;
  inputEpoch: string;
};
async function setup(editing?: BrowserEditingStore, cursor?: BrowserCursorStore) {
  let picture: BrowserFrameView | null = frame();
  let pictureSession = "browser-a";
  let options: ViewOptions = {
    activeSurfaceId: firstSurface,
    canInput: true,
    occluded: false,
    sessionId: pictureSession,
    visible: true,
    live: true,
    inputEpoch: "document-a",
  };
  const changed = new Set<() => void>();
  const frames: BrowserFrameStore = {
    ...(editing ? { editing } : {}),
    ...(cursor ? { cursor } : {}),
    get: (id) => (id === pictureSession ? picture : null),
    subscribe: (_id, listener) => {
      changed.add(listener);
      return () => changed.delete(listener);
    },
  };
  const commands: BrowserCommand[] = [];
  let reject = false;
  const send = (command: BrowserCommand) => {
    commands.push(command);
    return !reject;
  };
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render = (update: Partial<ViewOptions> = {}) =>
    act(() => {
      options = { ...options, ...update };
      root?.render(
        <BrowserViewport
          {...options}
          documentId="doc"
          frames={frames}
          phoneLayout
          onCommand={send}
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
  return {
    commands,
    container,
    present,
    receive,
    render,
    reject: () => {
      reject = true;
    },
  };
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
    const menu = container.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu.contains(document.activeElement)).toBe(true);
    void act(() =>
      menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(
      container.querySelector('[aria-label="Browser keyboard input"]'),
    );
  });
  it.each(["pointercancel", "lostpointercapture"])(
    "cancels a held drag without flushing a pending move on %s",
    async (ending) => {
      const { commands, container, present } = await setup();
      const viewport = container.querySelector<HTMLElement>(".browser-canvas")!;
      Object.assign(viewport, { setPointerCapture: vi.fn() });
      vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
        width: 400,
        height: 300,
        top: 0,
        left: 0,
      } as DOMRect);
      const pointer = (type: string, x = 200) =>
        act(() => {
          viewport.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              button: 0,
              buttons: type === "pointerup" ? 0 : 1,
              clientX: x,
              clientY: 150,
              pointerId: 1,
              pointerType: "mouse",
            }),
          );
        });
      pointer("pointerdown");
      commands.length = 0;
      pointer("pointermove", 220);
      pointer(ending, 220);
      await present();
      const inputCommands = () => commands.filter((command) => command.type.startsWith("input."));
      expect(inputCommands()).toEqual([{ type: "input.cancel", surfaceId: firstSurface }]);
      pointer("pointerup", 220);
      expect(inputCommands()).toHaveLength(1);
      pointer("pointerdown");
      expect(commands.at(-1)).toMatchObject({
        type: "input.pointer",
        action: "down",
        clickCount: 1,
      });
    },
  );

  it("clears remote hover on leave while preserving captured drags and resetting dragged click chains", async () => {
    const { commands, container, present } = await setup();
    const viewport = container.querySelector<HTMLElement>(".browser-canvas")!;
    Object.assign(viewport, { setPointerCapture: vi.fn() });
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
      width: 400,
      height: 300,
      top: 0,
      left: 0,
    } as DOMRect);
    const pointer = (type: string, x = 200) =>
      act(() => {
        viewport.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            button: 0,
            clientX: x,
            clientY: 150,
            pointerId: 1,
            pointerType: "mouse",
          }),
        );
      });
    pointer("pointermove");
    await present();
    pointer("pointerout", 410);
    expect(commands.at(-1)).toMatchObject({
      type: "input.pointer",
      action: "leave",
      button: "none",
    });
    pointer("pointerdown");
    pointer("pointermove", 220);
    const count = commands.length;
    pointer("pointerout", 410);
    expect(commands).toHaveLength(count);
    pointer("pointerup", 220);
    pointer("lostpointercapture", 220);
    expect(commands.at(-1)).toMatchObject({ type: "input.pointer", action: "up", clickCount: 1 });
    pointer("pointerdown");
    expect(commands.at(-1)).toMatchObject({ type: "input.pointer", action: "down", clickCount: 1 });
    pointer("pointermove", 410);
    pointer("pointerup", 410);
    expect(commands.filter((command) => command.type.startsWith("input.")).slice(-2)).toMatchObject(
      [
        { type: "input.pointer", action: "up" },
        { type: "input.pointer", action: "leave", button: "none" },
      ],
    );
  });

  it("keeps click counts on their press and resets them when the target changes", async () => {
    const { commands, container, render, receive, present } = await setup();
    const viewport = container.querySelector<HTMLElement>(".browser-canvas")!;
    Object.assign(viewport, { setPointerCapture: vi.fn() });
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
      width: 400,
      height: 300,
      top: 0,
      left: 0,
    } as DOMRect);
    const click = (button = 0) =>
      act(() => {
        for (const type of ["pointerdown", "pointerup"])
          viewport.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              button,
              clientX: 200,
              clientY: 150,
              pointerId: 1,
              pointerType: "mouse",
            }),
          );
      });
    click();
    click();
    click(2);
    expect(
      commands.flatMap((command) =>
        command.type === "input.pointer" && command.action === "up" ? [command.clickCount] : [],
      ),
    ).toEqual([1, 2, 1]);
    void act(() =>
      viewport.dispatchEvent(
        new PointerEvent("pointerout", { bubbles: true, pointerId: 1, clientX: 410, clientY: 150 }),
      ),
    );
    expect(commands.at(-1)).toMatchObject({ type: "input.pointer", action: "leave" });
    render({ activeSurfaceId: secondSurface });
    receive(frame(secondSurface));
    await present();
    click();
    expect(commands.at(-1)).toMatchObject({
      type: "input.pointer",
      action: "up",
      surfaceId: secondSurface,
      clickCount: 1,
    });
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

it("applies only the current pointer cursor and resets on leave, scroll, geometry and reconnect", async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
  });
  const cursor = new BrowserCursorStore();
  const { container, commands, receive, present, render } = await setup(undefined, cursor);
  const stage = container.querySelector<HTMLElement>(".browser-canvas")!;
  vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({
    width: 800,
    height: 600,
    left: 0,
    top: 0,
  } as DOMRect);
  const hover = () =>
    act(() =>
      stage.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          pointerType: "mouse",
          clientX: 100,
          clientY: 100,
        }),
      ),
    );
  const hint = (sequence: number, shape = "pointer") =>
    act(() =>
      cursor.receive("browser-a", {
        type: "browser.cursor",
        surfaceId: firstSurface,
        consumerToken: "00000000-0000-4000-8000-000000000001",
        cursorSequence: sequence,
        documentId: "doc",
        geometryRevision: 0,
        captureRevision: 0,
        cursor: shape,
      } as Parameters<BrowserCursorStore["receive"]>[1]),
    );
  const sequence = () => {
    const command = commands.filter((c) => c.type === "input.pointer").at(-1);
    if (command?.type !== "input.pointer" || command.cursorSequence === undefined)
      throw new Error("Hover did not carry a cursor sequence");
    return command.cursorSequence;
  };
  try {
    await hover();
    await act(async () => {
      for (const paint of paints.splice(0)) paint(performance.now());
    });
    await hint(sequence());
    expect(stage.style.cursor).toBe("pointer");
    await hint(sequence() - 1, "text");
    expect(stage.style.cursor).toBe("pointer");
    await act(() =>
      stage.dispatchEvent(
        new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
      ),
    );
    expect(stage.style.cursor).toBe("default");
    await hint(sequence());
    expect(stage.style.cursor).toBe("default");
    await hover();
    await act(async () => {
      for (const paint of paints.splice(0)) paint(performance.now());
    });
    await hint(sequence(), "text");
    expect(stage.style.cursor).toBe("text");
    await act(() => stage.dispatchEvent(wheelEvent(100, 100, 10)));
    expect(stage.style.cursor).toBe("default");
    await hint(sequence());
    expect(stage.style.cursor).toBe("default");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(commands.some((c) => c.type === "cursor.query")).toBe(true);
    await hover();
    await act(async () => {
      for (const paint of paints.splice(0)) paint(performance.now());
    });
    await hint(sequence());
    expect(stage.style.cursor).toBe("pointer");
    receive({ ...frame(), header: { ...frame().header, geometryRevision: 1 } });
    await present();
    expect(stage.style.cursor).toBe("default");
    render({ canInput: false });
    expect(stage.style.cursor).toBe("default");
  } finally {
    vi.useRealTimers();
  }
});

describe("browser viewport finger input", () => {
  beforeEach(() =>
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] }),
  );
  async function ready() {
    const view = await setup();
    const viewport = view.container.querySelector<HTMLElement>(".browser-canvas")!;
    Object.assign(viewport, { setPointerCapture: vi.fn() });
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 400,
      height: 300,
    } as DOMRect);
    const finger = (type: string, y = 150, id = 1) =>
      void act(() =>
        viewport.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerType: "touch",
            pointerId: id,
            button: 0,
            clientX: 200,
            clientY: y,
          }),
        ),
      );
    const inputs = () => view.commands.filter((command) => command.type.startsWith("input."));
    view.commands.length = 0;
    return { ...view, viewport, finger, inputs };
  }
  it("defers tap, consumes long press, and measures scroll slop from the original contact", async () => {
    const { finger, commands, inputs, present, container } = await ready();
    finger("pointerdown");
    expect(container.querySelector(".browser-touch-contact")).not.toBeNull();
    expect(inputs()).toEqual([]);
    finger("pointerup");
    expect(container.querySelector(".browser-touch-contact")).toBeNull();
    expect(inputs()).toMatchObject([
      { type: "input.pointer", action: "down", button: "left" },
      { action: "up" },
    ]);
    commands.length = 0;
    finger("pointerdown");
    act(() => {
      vi.advanceTimersByTime(500);
    });
    finger("pointerup");
    expect(inputs()).toMatchObject([
      { type: "input.pointer", action: "down", button: "right" },
      { action: "up", button: "right" },
    ]);
    commands.length = 0;
    finger("pointerdown");
    for (const y of [148, 146, 144, 140]) {
      act(() => {
        vi.advanceTimersByTime(16);
      });
      finger("pointermove", y);
    }
    finger("pointerup", 140);
    act(() => {
      vi.advanceTimersByTime(16);
    });
    await present();
    expect(inputs().every((command) => command.type === "input.wheel")).toBe(true);
    expect(inputs().length).toBeGreaterThan(1);
  });
  it.each([
    "new touch",
    "pinch",
    "navigation",
    "geometry",
    "background",
    "disconnect",
    "rejection",
    "cancel",
    "visibility",
    "stage resize",
    "unmount",
  ])("cancels fling on %s", async (reason) => {
    const { finger, inputs, commands, render, receive, reject, present } = await ready();
    finger("pointerdown");
    act(() => {
      vi.advanceTimersByTime(16);
    });
    finger("pointermove", 130);
    act(() => {
      vi.advanceTimersByTime(16);
    });
    finger("pointermove", 110);
    finger("pointerup", 110);
    act(() => {
      vi.advanceTimersByTime(16);
    });
    await present();
    expect(inputs().filter((command) => command.type === "input.wheel")).toHaveLength(3);
    if (reason === "new touch") finger("pointerdown");
    if (reason === "pinch") {
      finger("pointerdown");
      finger("pointerdown", 150, 2);
    }
    if (reason === "navigation") render({ inputEpoch: "next-document" });
    if (reason === "geometry")
      receive({ ...frame(), header: { ...frame().header, geometryRevision: 2 } });
    if (reason === "background")
      void act(() => document.dispatchEvent(new Event("visibilitychange")));
    if (reason === "background") void act(() => window.dispatchEvent(new Event("blur")));
    if (reason === "disconnect") render({ live: false });
    if (reason === "rejection") reject();
    if (reason === "cancel") finger("pointercancel");
    if (reason === "visibility") {
      vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      void act(() => document.dispatchEvent(new Event("visibilitychange")));
    }
    if (reason === "stage resize") {
      const viewport = document.querySelector<HTMLElement>(".browser-canvas")!;
      vi.mocked(viewport.getBoundingClientRect).mockReturnValue({
        left: 10,
        top: 0,
        width: 350,
        height: 300,
      } as DOMRect);
      void act(() => window.dispatchEvent(new Event("focus")));
    }
    if (reason === "unmount")
      act(() => {
        root?.unmount();
        root = null;
      });
    commands.length = 0;
    for (let i = 0; i < 4; i++) {
      act(() => {
        vi.advanceTimersByTime(16);
      });
      await present();
    }
    expect(inputs().filter((command) => command.type === "input.wheel")).toHaveLength(
      reason === "rejection" ? 1 : 0,
    );
  });
  it("offers one-shot Drag/select and cancels a held drag before pinch, then waits for every finger to lift", async () => {
    const { container, finger, commands, inputs } = await ready();
    const drag = () =>
      void act(() =>
        [...container.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent === "Drag/select")!
          .click(),
      );
    drag();
    finger("pointerdown");
    finger("pointermove", 100);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    finger("pointerup", 100);
    expect(inputs()).toMatchObject([
      { type: "input.pointer", action: "down" },
      { action: "move", button: "none", buttons: 1, y: 1 / 3 },
      { action: "up" },
    ]);
    commands.length = 0;
    finger("pointerdown");
    finger("pointerup");
    expect(inputs()).toHaveLength(2);
    commands.length = 0;
    drag();
    finger("pointerdown");
    finger("pointerdown", 100, 2);
    expect(inputs().at(-1)).toMatchObject({ type: "input.cancel" });
    commands.length = 0;
    finger("pointerup", 100, 2);
    finger("pointermove", 90);
    finger("pointerup", 90);
    expect(inputs()).toEqual([]);
    finger("pointerdown");
    finger("pointerup");
    expect(inputs()).toHaveLength(2);
  });
  it("zooms and pans locally with two fingers, maps the next tap through that transform, and never resizes the page", async () => {
    const { viewport, finger, inputs, commands } = await ready();
    finger("pointerdown", 100);
    finger("pointerdown", 200, 2);
    finger("pointermove", 50);
    finger("pointermove", 250, 2);
    expect(viewport.style.getPropertyValue("--browser-touch-scale")).toBe("2");
    expect(inputs()).toEqual([]);
    finger("pointerup", 50);
    finger("pointerup", 250, 2);
    commands.length = 0;
    finger("pointerdown", 100);
    finger("pointerup", 100);
    expect(inputs()).toMatchObject([
      { type: "input.pointer", action: "down", x: 0.5, y: 5 / 12 },
      { action: "up" },
    ]);
    expect(commands.some((command) => command.type.startsWith("viewport."))).toBe(false);
  });
  it("keeps released touch inertia through capture loss and stops it on native wheel after changing targets", async () => {
    const { finger, inputs, commands, render, receive, present, viewport } = await ready();
    render({ activeSurfaceId: secondSurface });
    receive(frame(secondSurface));
    await present();
    commands.length = 0;
    finger("pointerdown");
    act(() => {
      vi.advanceTimersByTime(16);
    });
    finger("pointermove", 130);
    act(() => {
      vi.advanceTimersByTime(16);
    });
    finger("pointermove", 110);
    finger("pointerup", 110);
    finger("lostpointercapture", 110);
    act(() => {
      vi.advanceTimersByTime(16);
    });
    await present();
    expect(inputs().filter((command) => command.type === "input.wheel")).toHaveLength(3);
    expect(
      inputs().every((command) => "surfaceId" in command && command.surfaceId === secondSurface),
    ).toBe(true);
    commands.length = 0;
    void act(() => viewport.dispatchEvent(wheelEvent(200, 150, 40)));
    act(() => {
      vi.advanceTimersByTime(16);
    });
    await present();
    expect(inputs()).toMatchObject([
      { type: "input.wheel", surfaceId: secondSurface, deltaY: 40, x: 0.5, y: 0.5 },
    ]);
  });

  it("leaves desktop wheel momentum alone", async () => {
    const { viewport, inputs, present } = await ready();
    void act(() => viewport.dispatchEvent(wheelEvent(200, 150, 40)));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    await present();
    expect(inputs()).toHaveLength(1);
  });
});
