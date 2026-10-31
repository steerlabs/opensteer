// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import { sharedDisplayStreams } from "@opensteer/client/integrations";
import type { WebSocketClient } from "@opensteer/client/host";
import type { MachineSummary } from "@opensteer/protocol";

/*
 * Ways the live phone Watch can fail in a page, each answered below:
 *
 * - The decoder is configured without the keyframe's codec, with an AVC
 *   description, or without low-latency hardware preference.
 * - A frame is acknowledged before the decoder outputs it.
 * - The picture box keeps a guessed shape instead of the stream's.
 * - Input flows before there is a live picture or before the Host offers
 *   shared input, or the view still offers a Take over mode.
 * - A press lands where the element is rather than where the picture is
 *   drawn inside it; keys and navigation are not delivered in order.
 * - An IME's partial composition is typed, its commit or a paste is lost, or
 *   a shortcut such as Cmd+C is taken from the page.
 * - A view that goes away mid-drag, such as the enlarged picture closing,
 *   leaves the phone's finger down.
 * - Hiding the page leaves the viewer's held input unreleased or the socket open.
 * - Protection leaves the last picture on screen.
 */

interface Recorded {
  readonly sent: Record<string, unknown>[];
  closed: boolean;
  readonly deliver: (message: unknown) => void;
}

const decoder = vi.hoisted(() => ({
  configs: [] as VideoDecoderConfig[],
  outputs: [] as number[],
  /** Decoder output and socket sends, in the order they happened. */
  timeline: [] as string[],
}));

/** Takes each chunk off its queue a moment later, then outputs it, as WebCodecs does. */
class FakeVideoDecoder extends EventTarget {
  static async isConfigSupported(config: VideoDecoderConfig) {
    return { supported: true, config };
  }
  state: CodecState = "unconfigured";
  decodeQueueSize = 0;
  readonly #output: VideoFrameOutputCallback;
  constructor(init: VideoDecoderInit) {
    super();
    this.#output = init.output;
  }
  configure(config: VideoDecoderConfig) {
    decoder.configs.push(config);
    this.state = "configured";
  }
  decode(chunk: { timestamp: number }) {
    this.decodeQueueSize += 1;
    setTimeout(() => {
      this.decodeQueueSize -= 1;
      decoder.timeline.push(`dequeue ${chunk.timestamp}`);
      this.dispatchEvent(new Event("dequeue"));
      decoder.outputs.push(chunk.timestamp);
      decoder.timeline.push(`output ${chunk.timestamp}`);
      this.#output({ timestamp: chunk.timestamp, close: () => undefined } as VideoFrame);
    }, 5);
  }
  reset() {
    this.state = "unconfigured";
  }
  close() {
    this.state = "closed";
  }
}

Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  VideoDecoder: FakeVideoDecoder,
  EncodedVideoChunk: class {
    readonly timestamp: number;
    constructor(init: { timestamp: number }) {
      this.timestamp = init.timestamp;
    }
  },
});
vi.mock("./workspace/workspace-context.js", () => ({
  useWorkspace: () => ({ localMachine: null, nav: {} }),
}));
vi.mock("./workspace/tab-closer.js", () => ({ useTabCloser: () => () => undefined }));
const { ComputerWatchView } = await import("./computer-watch.js");
const { OwnerView } = await import("./workspace/owner-view.js");
const { ownerViewDestination } = await import("./workspace/owner-views.js");

let root: Root | null = null;
let client: MockHostClient;
let sockets: Recorded[];
let requestedEditing: unknown;

beforeEach(async () => {
  decoder.configs.length = 0;
  decoder.outputs.length = 0;
  decoder.timeline.length = 0;
  sockets = [];
  requestedEditing = null;
  client = new MockHostClient({ latencyMs: 0 });
  await client.load();
  const connect = client.connectComputerDisplay.bind(client);
  vi.spyOn(client, "connectComputerDisplay").mockImplementation(
    (sessionId, options?: { readonly editing?: 1 }) => {
      requestedEditing = options;
      const socket = connect(sessionId);
      const record: Recorded = {
        sent: [],
        closed: false,
        deliver: (message) =>
          listeners.forEach((listener) => listener({ data: JSON.stringify(message) })),
      };
      type Listener = (event: { readonly data: unknown }) => void;
      const listeners: Listener[] = [];
      const add = socket.addEventListener.bind(socket) as (
        type: string,
        listener: Listener,
      ) => void;
      socket.addEventListener = ((type: string, listener: Listener) => {
        if (type === "message") listeners.push(listener);
        add(type, (event) => {
          if (
            type === "message" &&
            sessionId.kind === "owner-view" &&
            typeof event.data === "string"
          ) {
            const message = JSON.parse(event.data);
            if (message.type === "display.state" && message.editingVersion === undefined) {
              const { sharedInput: _sharedInput, ...baseline } = message;
              listener({ data: JSON.stringify(baseline) });
              return;
            }
          }
          listener(event);
        });
      }) as WebSocketClient["addEventListener"];
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        const message = JSON.parse(data as string) as Record<string, unknown>;
        record.sent.push(message);
        decoder.timeline.push(`${String(message.type)} ${String(message.sequence)}`);
        send(data);
      };
      const close = socket.close.bind(socket);
      socket.close = (code, reason) => {
        record.closed = true;
        close(code, reason);
      };
      sockets.push(record);
      return socket;
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
    // A stage twice the phone's width: the picture is centred with 180px either side.
    left: 0,
    top: 0,
    width: 720,
    height: 780,
    right: 720,
    bottom: 780,
    x: 0,
    y: 0,
    toJSON: () => undefined,
  });
  Object.assign(HTMLElement.prototype, {
    setPointerCapture: () => undefined,
    releasePointerCapture: () => undefined,
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  client.dispose();
  document.body.replaceChildren();
  Reflect.deleteProperty(window, "opensteerDesktop");
});

function phone(): { machine: MachineSummary; sessionId: string } {
  const machine = client.getSnapshot().machines.find((item) => item.device?.form === "phone");
  const sessionId = machine?.computerUse?.sessions[0]?.sessionId;
  if (!machine || !sessionId) throw new Error("Missing phone fixture");
  return { machine, sessionId };
}

function show(visible = true) {
  const { machine, sessionId } = phone();
  const element = (
    <ComputerWatchView
      appKey={null}
      hostClient={client}
      hostConnected
      machineId={machine.id}
      machines={[machine]}
      sessionId={sessionId}
      visible={visible}
    />
  );
  if (!root) {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  act(() => root!.render(element));
}

async function settle(ms = 40) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** Waits for the page to reach a state, failing after two seconds rather than hanging. */
async function until(reached: () => boolean) {
  for (let waited = 0; !reached(); waited += 10) {
    if (waited > 2_000) throw new Error("The phone Watch never got there.");
    await settle(10);
  }
  await settle();
}

function inputAvailable(): boolean {
  return document.querySelector("[data-live-page]") !== null;
}

function shown(): boolean {
  return (
    document.querySelector("canvas")?.width === 360 &&
    document.querySelector(".phone-display__picture--hidden") === null
  );
}

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === name || candidate.getAttribute("aria-label") === name,
  );
  if (!found) throw new Error(`No ${name} button`);
  return found;
}

function canvas(): HTMLCanvasElement {
  const found = document.querySelector("canvas");
  if (!found) throw new Error("No canvas");
  return found;
}

/** The keyboard target that has focus while the owner controls the phone. */
function keyboard(): HTMLTextAreaElement {
  const found = document.querySelector<HTMLTextAreaElement>("textarea.phone-display__keyboard");
  if (!found) throw new Error("No keyboard target");
  return found;
}

/** happy-dom has no CompositionEvent; browsers deliver the IME's text as `data`. */
function composition(type: string, data: string): Event {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, "data", { value: data });
  return event;
}

function inputs(): Record<string, unknown>[] {
  return sockets[0]!.sent.filter((message) => message.type === "display.input");
}

function typed(): unknown[] {
  return inputs()
    .flatMap((message) => message.events as { kind: string }[])
    .filter((event) => event.kind === "text");
}

function pointer(type: string, clientX: number, clientY: number, target = canvas()) {
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        button: 0,
        clientX,
        clientY,
        isPrimary: true,
        pointerId: 7,
        pointerType: "mouse",
      }),
    );
  });
}

describe("live phone Watch", () => {
  it("decodes the stream, acknowledges once the decoder takes it, and takes the picture's shape", async () => {
    show();
    const name = phone().machine.name;
    expect(document.querySelector('[role="status"]')?.textContent).toBe(`Connecting to ${name}…`);
    await until(
      () =>
        decoder.outputs.length > 0 &&
        sockets[0]?.sent.some((message) => message.type === "display.ack") === true,
    );
    expect(decoder.configs).toEqual([
      { codec: "avc1.42C01E", hardwareAcceleration: "prefer-hardware", optimizeForLatency: true },
    ]);
    expect(decoder.outputs).toEqual([0]);
    expect(sockets[0]?.sent.filter((message) => message.type !== "display.input-reset")).toEqual([
      { type: "display.ack", sequence: 0 },
    ]);
    expect(decoder.timeline.filter((entry) => !entry.startsWith("display.input-reset"))).toEqual([
      "dequeue 0",
      "display.ack 0",
      "output 0",
    ]);
    expect(canvas().parentElement?.getAttribute("style")).toContain("360 / 780");
    expect(canvas().width).toBe(360);
    expect(canvas().height).toBe(780);
    expect(document.querySelector(".computer-watch__status")).toBeNull();
  });

  it("accepts shared input and resets on F6, mapping input into the drawn picture", async () => {
    show();
    await until(shown);
    await until(inputAvailable);
    expect(document.body.textContent).not.toMatch(/Take over|Give back|controlling/);
    expect(document.activeElement).not.toBe(keyboard());
    pointer("pointerdown", 180 + 90, 390);
    expect(document.activeElement).toBe(keyboard());
    pointer("pointermove", 180 + 180, 195);
    pointer("pointerup", 180 + 180, 195);
    act(() => {
      for (const data of ["h", "i"])
        keyboard().dispatchEvent(
          new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            data,
            inputType: "insertText",
          }),
        );
      keyboard().dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
      );
    });
    await until(
      () => decoder.timeline.filter((entry) => entry.startsWith("display.input")).length === 3,
    );
    act(() => button("Back").click());
    const inputs = sockets[0]!.sent.filter((message) => message.type === "display.input");
    expect(inputs.map(({ geometry, sequence }) => ({ geometry, sequence }))).toEqual(
      inputs.map((_, sequence) => ({ geometry: 1, sequence })),
    );
    expect(inputs.every((message) => !("controlId" in message))).toBe(true);
    expect(inputs.flatMap((message) => message.events as unknown[])).toEqual([
      expect.objectContaining({ kind: "pointer", phase: "down", x: 0.25, y: 0.5 }),
      expect.objectContaining({ kind: "pointer", phase: "move", x: 0.5, y: 0.25 }),
      expect.objectContaining({ kind: "pointer", phase: "up", x: 0.5, y: 0.25 }),
      { kind: "text", insert: "hi" },
      { kind: "text", submit: true },
      { kind: "nav", to: "back" },
    ]);
    act(() => keyboard().dispatchEvent(new KeyboardEvent("keydown", { key: "F6", bubbles: true })));
    expect(sockets[0]!.sent.at(-1)).toEqual({ type: "display.input-reset" });
    expect(document.activeElement).not.toBe(keyboard());
    expect(document.body.textContent).not.toContain("Take over");
  });

  it("types an IME's committed text and a paste, never a partial composition", async () => {
    show();
    await until(shown);
    await until(inputAvailable);
    pointer("pointerdown", 270, 390);
    pointer("pointerup", 270, 390);
    const target = keyboard();
    const composing = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      data: "に",
      inputType: "insertCompositionText",
      isComposing: true,
    });
    act(() => {
      target.dispatchEvent(composition("compositionstart", ""));
      target.dispatchEvent(composing);
      target.value = "に";
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Enter",
          isComposing: true,
        }),
      );
    });
    expect(composing.defaultPrevented).toBe(false);
    await settle();
    expect(typed()).toEqual([]);
    act(() => {
      target.dispatchEvent(composition("compositionend", "日本"));
    });
    expect(target.value).toBe("");
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { getData: (type: string) => (type === "text/plain" ? "a pasted line" : "") },
    });
    const copy = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "c",
      metaKey: true,
    });
    act(() => {
      target.dispatchEvent(paste);
      target.dispatchEvent(copy);
    });
    expect(paste.defaultPrevented).toBe(true);
    expect(copy.defaultPrevented).toBe(false);
    await until(() => typed().length === 1);
    expect(typed()).toEqual([{ kind: "text", insert: "日本a pasted line" }]);
  });

  it("ends a drag when the enlarged picture it was in closes", async () => {
    show();
    await until(shown);
    await until(inputAvailable);
    act(() => button("Phone options").click());
    act(() => button("Enlarge").click());
    const enlarged = document.querySelectorAll("canvas")[1];
    if (!enlarged) throw new Error("No enlarged canvas");
    pointer("pointerdown", 180 + 90, 390, enlarged);
    pointer("pointermove", 180 + 180, 195, enlarged);
    act(() => button("Close enlarged picture").click());
    await until(() =>
      inputs().some((message) =>
        (message.events as { phase?: string }[]).some((event) => event.phase === "cancel"),
      ),
    );
    expect(
      inputs()
        .flatMap((message) => message.events as { kind: string; phase?: string }[])
        .map(({ phase }) => phase),
    ).toEqual(["down", "move", "cancel"]);
  });

  it("ignores a press in the letterbox beside the picture", async () => {
    show();
    await until(shown);
    await until(inputAvailable);
    pointer("pointerdown", 90, 390);
    pointer("pointerup", 90, 390);
    expect(sockets[0]!.sent.filter((message) => message.type === "display.input")).toEqual([]);
  });

  it("resets input and closes the socket when the page is hidden", async () => {
    show();
    await until(shown);
    await until(inputAvailable);
    pointer("pointerdown", 270, 390);
    show(false);
    const sent = sockets[0]!.sent;
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: "display.input",
        events: [expect.objectContaining({ phase: "cancel", x: 0.25, y: 0.5 })],
      }),
    );
    expect(sent.at(-1)).toEqual({ type: "display.input-reset" });
    expect(sockets[0]!.closed).toBe(true);
  });

  it("keeps the hidden Watch picture but refuses input before the replacement paints", async () => {
    show();
    await until(shown);
    const firstCanvas = canvas();
    const pool = sharedDisplayStreams(client);
    const visibility = vi.spyOn(document, "visibilityState", "get");
    act(() => {
      visibility.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      pool.suspend(true);
    });
    expect(canvas()).toBe(firstCanvas);
    expect(sockets[0]!.closed).toBe(true);
    const pending: { decoder: FakeVideoDecoder; chunk: { timestamp: number } }[] = [];
    const decode = vi.spyOn(FakeVideoDecoder.prototype, "decode").mockImplementation(function (
      this: FakeVideoDecoder,
      chunk: { timestamp: number },
    ) {
      pending.push({ decoder: this, chunk });
    });
    act(() => {
      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      pool.suspend(false);
    });
    await until(() => pending.length > 0);
    expect(canvas()).toBe(firstCanvas);
    expect(inputAvailable()).toBe(false);
    decode.mockRestore();
    act(() => pending.forEach(({ decoder, chunk }) => decoder.decode(chunk)));
    await until(inputAvailable);
    expect(canvas()).toBe(firstCanvas);
  });

  it("takes the picture off screen when the phone protects it", async () => {
    show();
    await until(shown);
    sockets[0]!.deliver({
      type: "display.state",
      state: "protected",
      reason: "paused",
      generation: 1,
      width: 360,
      height: 780,
    });
    await until(() => !shown());
    // The words the person's own view of the phone says too.
    expect(document.querySelector('[role="status"]')?.textContent).toBe("Pixel 7 is paused.");
    expect(document.querySelector(".phone-display__picture--hidden canvas")).not.toBeNull();
    expect(document.querySelector('button[aria-label^="Enlarge"]')).toBeNull();
  });
});

const editingContext = {
  contextId: "00000000-0000-4000-8000-000000000001",
  field: { kind: "text", multiline: true, sensitive: false, inputMode: "text" },
  caret: { x: 0.25, y: 0.5, height: 0.025 },
};
async function negotiatedPhone() {
  show();
  await until(shown);
  act(() =>
    sockets[0]!.deliver({
      type: "display.state",
      state: "live",
      sharedInput: 1,
      generation: 1,
      width: 360,
      height: 780,
      editingVersion: 1,
    }),
  );
  await until(inputAvailable);
  act(() =>
    sockets[0]!.deliver({ type: "display.editing", generation: 1, context: editingContext }),
  );
  await settle();
  const field = document.querySelector<HTMLTextAreaElement>("textarea.remote-keyboard-input");
  if (!field) throw new Error("Negotiated phone did not use the shared editing proxy");
  return field;
}
function proxyInput(
  field: HTMLTextAreaElement,
  value: string,
  inputType = "insertText",
  composing = false,
) {
  act(() => {
    field.value = value;
    field.setSelectionRange(value.length, value.length);
    field.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType, isComposing: composing }),
    );
  });
}
function remoteEvents() {
  return inputs().flatMap((message) => message.events as Record<string, unknown>[]);
}
function hardware(field: HTMLElement, key: string, code: string, extra: KeyboardEventInit = {}) {
  act(() =>
    field.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, code, ...extra }),
    ),
  );
}
function trustedPaste(field: HTMLElement, items: Record<string, string>) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    isTrusted: { value: true },
    clipboardData: {
      value: { types: Object.keys(items), files: [], getData: (type: string) => items[type] ?? "" },
    },
  });
  act(() => field.dispatchEvent(event));
}

describe("negotiated phone viewer wire", () => {
  it("opts in and sends one text-bearing key, a verified replacement and separate deletes", async () => {
    const field = await negotiatedPhone();
    expect(requestedEditing).toEqual({ editing: 1 });
    hardware(field, "e", "KeyE");
    proxyInput(field, "e");
    proxyInput(field, "é", "insertReplacementText");
    hardware(field, "ArrowLeft", "ArrowLeft");
    hardware(field, "Backspace", "Backspace");
    hardware(field, "Backspace", "Backspace");
    expect(remoteEvents()).toEqual([
      {
        kind: "key",
        action: "down",
        key: "e",
        code: "KeyE",
        modifiers: [],
        location: 0,
        repeat: false,
        text: "e",
      },
      {
        kind: "edit",
        edit: { contextId: editingContext.contextId, before: "e", after: "", text: "é" },
      },
      { kind: "command", command: "moveBackward" },
      { kind: "command", command: "deleteBackward" },
      { kind: "command", command: "deleteBackward" },
    ]);
  });
  it("cancels composition and resets input when the keyboard blurs", async () => {
    const field = await negotiatedPhone();
    act(() => field.focus());
    act(() => field.dispatchEvent(composition("compositionstart", "")));
    proxyInput(field, "に", "insertCompositionText", true);
    act(() => field.blur());
    act(() => field.dispatchEvent(composition("compositionend", "に")));
    expect(remoteEvents()).toEqual([]);
    expect(sockets[0]!.sent.at(-1)).toEqual({ type: "display.input-reset" });
    expect(document.querySelector("[data-remote-preedit]")).toBeNull();
  });
  it("keeps preedit local at the mapped caret and commits once at the old context", async () => {
    const field = await negotiatedPhone();
    act(() => field.dispatchEvent(composition("compositionstart", "")));
    proxyInput(field, "に", "insertCompositionText", true);
    expect(remoteEvents()).toEqual([]);
    expect(document.querySelector("[data-remote-preedit]")?.textContent).toBe("に");
    expect(field.style.left).toBe("270px");
    expect(field.style.top).toBe("390px");
    act(() =>
      sockets[0]!.deliver({
        type: "display.editing",
        generation: 1,
        context: { ...editingContext, contextId: "00000000-0000-4000-8000-000000000002" },
      }),
    );
    act(() => field.dispatchEvent(composition("compositionend", "に")));
    expect(remoteEvents()).toEqual([
      {
        kind: "edit",
        edit: { contextId: editingContext.contextId, before: "", after: "", text: "に" },
      },
    ]);
  });
  it("routes negotiated Cut through the clipboard port and refuses it for old phones", async () => {
    const write = vi.fn(async () => undefined);
    Object.defineProperty(window, "opensteerDesktop", {
      configurable: true,
      value: { writeViewerClipboard: write },
    });
    const field = await negotiatedPhone();
    act(() => field.dispatchEvent(new Event("cut", { bubbles: true, cancelable: true })));
    await settle();
    expect(remoteEvents()).toEqual([]);
    act(() =>
      sockets[0]!.deliver({
        type: "display.state",
        state: "live",
        sharedInput: 1,
        generation: 1,
        width: 1080,
        height: 1920,
        editingVersion: 1,
        displayCut: 1,
      }),
    );
    act(() => field.dispatchEvent(new Event("cut", { bubbles: true, cancelable: true })));
    const batch = inputs().at(-1)!;
    expect(batch.events).toEqual([{ kind: "cut", contextId: editingContext.contextId }]);
    act(() =>
      sockets[0]!.deliver({
        type: "display.clipboard",
        sequence: batch.sequence,
        outcome: "cut",
        text: "selected",
      }),
    );
    await settle();
    expect(write).toHaveBeenCalledWith([
      { type: "text/plain", bytes: new TextEncoder().encode("selected") },
    ]);
  });
  it.each(["clipboard-first", "receipt-first"])(
    "shows the native Cut refusal reason (%s)",
    async (order) => {
      const field = await negotiatedPhone();
      act(() =>
        sockets[0]!.deliver({
          type: "display.state",
          state: "live",
          sharedInput: 1,
          generation: 1,
          width: 1080,
          height: 1920,
          editingVersion: 1,
          displayCut: 1,
        }),
      );
      act(() => field.dispatchEvent(new Event("cut", { bubbles: true, cancelable: true })));
      const sequence = inputs().at(-1)!.sequence;
      const clipboard = { type: "display.clipboard", sequence, outcome: "refused" };
      const receipt = {
        type: "display.input.result",
        sequence,
        outcome: "refused",
        reason: "sensitive",
      };
      for (const message of order === "clipboard-first"
        ? [clipboard, receipt]
        : [receipt, clipboard])
        act(() => sockets[0]!.deliver(message));
      await settle();
      expect(document.body.textContent).toContain("This field protects its text.");
      expect(document.body.textContent).not.toContain("couldn’t copy the selection");
    },
  );
  it("offers Cut from the phone menu only after negotiation", async () => {
    await negotiatedPhone();
    act(() =>
      sockets[0]!.deliver({
        type: "display.state",
        state: "live",
        sharedInput: 1,
        generation: 1,
        width: 1080,
        height: 1920,
        editingVersion: 1,
        displayCut: 1,
      }),
    );
    const canvas = document.querySelector("canvas")!;
    act(() =>
      canvas.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 20,
        }),
      ),
    );
    const cut = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (item) => item.textContent === "Cut",
    );
    expect(cut).toBeDefined();
    act(() => cut!.click());
    expect(inputs().at(-1)?.events).toEqual([{ kind: "cut", contextId: editingContext.contextId }]);
  });
  it("enables password field Paste while disabling menu Copy and Cut", async () => {
    await negotiatedPhone();
    act(() => {
      sockets[0]!.deliver({
        type: "display.state",
        state: "live",
        sharedInput: 1,
        generation: 1,
        width: 360,
        height: 780,
        editingVersion: 1,
        displayCut: 1,
      });
      sockets[0]!.deliver({
        type: "display.editing",
        generation: 1,
        context: {
          ...editingContext,
          field: { ...editingContext.field, sensitive: true },
        },
      });
    });
    await settle();
    act(() =>
      document.querySelector("canvas")!.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 20,
        }),
      ),
    );
    expect(
      Object.fromEntries(
        [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].map((item) => [
          item.textContent,
          item.disabled,
        ]),
      ),
    ).toMatchObject({ Paste: false, Copy: true, Cut: true });
  });
  it("routes copy through the viewer clipboard port and ignores unsolicited or late copy", async () => {
    const write = vi.fn(async () => undefined);
    Object.defineProperty(window, "opensteerDesktop", {
      configurable: true,
      value: { writeViewerClipboard: write },
    });
    const field = await negotiatedPhone();
    act(() => field.dispatchEvent(new Event("copy", { bubbles: true, cancelable: true })));
    const batch = inputs().at(-1)!;
    expect(batch.events).toEqual([{ kind: "copy" }]);
    act(() =>
      sockets[0]!.deliver({
        type: "display.clipboard",
        sequence: batch.sequence,
        outcome: "copied",
        text: "selected",
      }),
    );
    await settle();
    expect(write).toHaveBeenCalledWith([
      { type: "text/plain", bytes: new TextEncoder().encode("selected") },
    ]);
    act(() =>
      sockets[0]!.deliver({
        type: "display.clipboard",
        sequence: 999,
        outcome: "copied",
        text: "unsolicited",
      }),
    );
    act(() => field.dispatchEvent(new KeyboardEvent("keydown", { key: "F6", bubbles: true })));
    act(() =>
      sockets[0]!.deliver({
        type: "display.clipboard",
        sequence: batch.sequence,
        outcome: "copied",
        text: "late",
      }),
    );
    await settle();
    expect(write).toHaveBeenCalledTimes(1);
  });
  it("pastes plain text, sends rich metadata for refusal, and shows limited/stale reasons", async () => {
    const field = await negotiatedPhone();
    trustedPaste(field, { "text/plain": "one\ntwo 🦊" });
    trustedPaste(field, { "text/plain": "rich", "text/html": "<b>rich</b>" });
    expect(remoteEvents()).toEqual([
      { kind: "paste", text: "one\ntwo 🦊" },
      {
        kind: "paste",
        items: [
          { type: "text/plain", size: 4 },
          { type: "text/html", size: 11 },
        ],
      },
    ]);
    const batch = inputs().at(-1)!;
    act(() =>
      sockets[0]!.deliver({
        type: "display.input.result",
        sequence: batch.sequence,
        outcome: "refused",
        reason: "unsupported",
      }),
    );
    expect(document.querySelector(".phone-display__control")?.textContent).toContain(
      "This device doesn’t support this edit.",
    );
    hardware(field, "z", "KeyZ");
    act(() =>
      sockets[0]!.deliver({
        type: "display.input.result",
        sequence: inputs().at(-1)!.sequence,
        outcome: "stale",
        reason: "stale",
      }),
    );
    expect(document.querySelector(".phone-display__control")?.textContent).toContain(
      "The field changed. Try again.",
    );
  });
  it("fences editing to current pixels and resets input on F6", async () => {
    const field = await negotiatedPhone();
    act(() =>
      sockets[0]!.deliver({
        type: "display.state",
        state: "live",
        sharedInput: 1,
        generation: 2,
        width: 360,
        height: 780,
        editingVersion: 1,
      }),
    );
    hardware(field, "x", "KeyX");
    expect(remoteEvents()).toEqual([]);
    hardware(field, "F6", "F6");
    expect(sockets[0]!.sent.at(-1)).toEqual({ type: "display.input-reset" });
  });
});

async function macOwner() {
  const machine = client
    .getSnapshot()
    .machines.find((machine) =>
      machine.computerUse?.sessions.some((session) => !session.display && session.apps.length),
    );
  const app = machine?.computerUse?.sessions.find((session) => !session.display)?.apps[0];
  if (!machine || !app) throw new Error("No Mac fixture");
  const view = await client.openComputerView(machine.id, { kind: "app", app });
  await settle();
  const destination = ownerViewDestination(view);
  if (destination.kind !== "app") throw new Error("No owner app destination");
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <OwnerView
        destination={destination}
        hostClient={client}
        hostConnected
        marks={null}
        leading={null}
        place={null}
        trailing={null}
      />,
    ),
  );
  await until(() => decoder.outputs.length > 0);
}
async function negotiatedMacOwner() {
  await macOwner();
  expect(document.querySelector(".owner-view__view-only")?.textContent).toBe("View only");
  act(() =>
    sockets[0]!.deliver({
      type: "display.state",
      state: "live",
      sharedInput: 1,
      generation: 1,
      width: 360,
      height: 780,
      editingVersion: 1,
    }),
  );
  expect(document.querySelector(".owner-view__view-only")).toBeNull();
  await until(() => document.querySelector("textarea.remote-keyboard-input") !== null);
  act(() =>
    sockets[0]!.deliver({ type: "display.editing", generation: 1, context: editingContext }),
  );
  return document.querySelector<HTMLTextAreaElement>("textarea.remote-keyboard-input")!;
}
describe("Mac owner viewer", () => {
  it("keeps a new Runner's baseline resolved Desktop/helper view passive", async () => {
    await macOwner();
    expect(requestedEditing).toEqual({ editing: 1 });
    expect(document.querySelector(".owner-view__view-only")?.textContent).toBe("View only");
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (button) => button.textContent === "Take over",
      ),
    ).toBe(false);
    expect(remoteEvents()).toEqual([]);
    act(() =>
      sockets[0]!.deliver({
        type: "display.state",
        state: "live",
        generation: 1,
        width: 360,
        height: 780,
        editingVersion: 1,
      }),
    );
    expect(document.body.textContent).not.toContain("Take over");
    act(() =>
      sockets[0]!.deliver({
        type: "display.state",
        state: "protected",
        generation: 3,
        width: 0,
        height: 0,
      }),
    );
    act(() =>
      sockets[0]!.deliver({
        type: "display.state",
        state: "live",
        generation: 4,
        width: 360,
        height: 780,
      }),
    );
    expect(document.querySelector(".owner-view__view-only")?.textContent).toBe("View only");
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (button) => button.textContent === "Take over",
      ),
    ).toBe(false);
    expect(remoteEvents()).toEqual([]);
  });

  it("accepts negotiated Mac input without a button and resets on F6", async () => {
    const field = await negotiatedMacOwner();
    expect(requestedEditing).toEqual({ editing: 1 });
    expect(document.body.textContent).not.toMatch(/Take over|Give back|controlling/);
    hardware(field, "a", "KeyA");
    expect(remoteEvents()).toMatchObject([{ kind: "key", text: "a" }]);
    hardware(field, "F6", "F6");
    expect(sockets[0]!.sent.at(-1)).toEqual({ type: "display.input-reset" });
  });
  it("sends hover, right and middle buttons, modifiers, click counts, drag and scroll in current geometry", async () => {
    await negotiatedMacOwner();
    for (const [type, button, buttons, x] of [
      ["pointermove", -1, 0, 270],
      ["pointerdown", 2, 2, 270],
      ["pointermove", -1, 2, 360],
      ["pointerup", 2, 0, 360],
      ["pointerdown", 1, 4, 270],
      ["pointerup", 1, 0, 270],
    ] as const)
      act(() => {
        canvas().dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerType: "mouse",
            pointerId: 7,
            isPrimary: true,
            button,
            buttons,
            detail: 0,
            shiftKey: true,
            clientX: x,
            clientY: 390,
          }),
        );
        canvas().dispatchEvent(
          new MouseEvent(type.replace("pointer", "mouse"), {
            bubbles: true,
            cancelable: true,
            button,
            buttons,
            detail: 2,
            shiftKey: true,
            clientX: x,
            clientY: 390,
          }),
        );
      });
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 78 });
    // happy-dom's WheelEvent inherits UIEvent and omits MouseEvent coordinates.
    Object.defineProperties(wheel, { clientX: { value: 270 }, clientY: { value: 390 } });
    act(() => canvas().dispatchEvent(wheel));
    expect(remoteEvents().some((event) => event.kind === "scroll")).toBe(false);
    act(() => {
      for (const batch of inputs())
        sockets[0]!.deliver({
          type: "display.input.result",
          sequence: batch.sequence,
          outcome: "dispatched",
        });
    });
    await until(() => remoteEvents().some((event) => event.kind === "scroll"));
    expect(remoteEvents()).toEqual([
      { kind: "mouse", phase: "move", button: "none", modifiers: ["shift"], x: 0.25, y: 0.5 },
      {
        kind: "mouse",
        phase: "down",
        button: "right",
        clickCount: 2,
        modifiers: ["shift"],
        x: 0.25,
        y: 0.5,
      },
      { kind: "mouse", phase: "move", button: "right", modifiers: ["shift"], x: 0.5, y: 0.5 },
      {
        kind: "mouse",
        phase: "up",
        button: "right",
        clickCount: 2,
        modifiers: ["shift"],
        x: 0.5,
        y: 0.5,
      },
      {
        kind: "mouse",
        phase: "down",
        button: "middle",
        clickCount: 2,
        modifiers: ["shift"],
        x: 0.25,
        y: 0.5,
      },
      {
        kind: "mouse",
        phase: "up",
        button: "middle",
        clickCount: 2,
        modifiers: ["shift"],
        x: 0.25,
        y: 0.5,
      },
      { kind: "scroll", x: 0.25, y: 0.5, dx: 0, dy: 0.1 },
    ]);
    expect(inputs().every((batch) => batch.geometry === 1)).toBe(true);
  });
  it("releases held mouse and keys before reset when leaving the view", async () => {
    const field = await negotiatedMacOwner();
    hardware(field, "F2", "F2");
    act(() =>
      canvas().dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          pointerType: "mouse",
          pointerId: 7,
          isPrimary: true,
          button: 0,
          buttons: 1,
          clientX: 270,
          clientY: 390,
        }),
      ),
    );
    act(() =>
      canvas().dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: 1,
          detail: 1,
          clientX: 270,
          clientY: 390,
        }),
      ),
    );
    act(() => root!.unmount());
    root = null;
    expect(remoteEvents()).toContainEqual(
      expect.objectContaining({ kind: "mouse", phase: "cancel", button: "left" }),
    );
    expect(remoteEvents()).toContainEqual(
      expect.objectContaining({ kind: "key", action: "up", code: "F2" }),
    );
    expect(sockets[0]!.sent.at(-1)).toEqual({ type: "display.input-reset" });
    expect(sockets[0]!.closed).toBe(true);
  });
});

describe("phone owner controls", () => {
  it("follows lease input and power availability, including a locked screen-off phone", async () => {
    const pool = sharedDisplayStreams(client);
    const retain = pool.retain.bind(pool);
    const power = vi.fn(() => true);
    let available = false;
    let cached: import("@opensteer/client/integrations").DisplaySnapshot | null = null;
    let previous: import("@opensteer/client/integrations").DisplaySnapshot | null = null;
    vi.spyOn(pool, "retain").mockImplementation((target) => {
      const lease = retain(target);
      return {
        ...lease,
        power,
        getSnapshot: () => {
          const snapshot = lease.getSnapshot();
          if (previous !== snapshot) {
            previous = snapshot;
            cached = {
              ...snapshot,
              input: available ? "available" : "unavailable",
              power: available ? "available" : "unavailable",
            };
          }
          return cached!;
        },
      };
    });
    const { machine } = phone();
    const approved = await client.listApprovedComputerApps();
    const target = approved.find(
      (app) => app.machineId === machine.id && app.target.kind === "phone",
    )?.target;
    if (!target) throw new Error("Missing approved phone");
    const view = await client.openComputerView(machine.id, target);
    const destination = ownerViewDestination(view);
    if (destination.kind !== "phone") throw new Error("Missing phone destination");
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root!.render(
        <OwnerView
          destination={destination}
          hostClient={client}
          hostConnected
          marks={null}
          leading={null}
          trailing={null}
          place={null}
        />,
      ),
    );
    await until(() => decoder.outputs.length > 0);
    expect(container.textContent).toContain("View only");
    expect(container.querySelector('button[aria-label="Back"]')).toBeNull();
    available = true;
    act(() =>
      sockets[0]!.deliver({
        type: "display.state",
        state: "live",
        sharedInput: 1,
        generation: 1,
        width: 360,
        height: 780,
        editingVersion: 1,
      }),
    );
    expect(container.textContent).not.toContain("View only");
    act(() => button("Back").click());
    expect(remoteEvents()).toContainEqual({ kind: "nav", to: "back" });
    act(() => button("Lock phone").click());
    expect(power).toHaveBeenLastCalledWith("lock");
    act(() =>
      sockets[0]!.deliver({
        type: "display.state",
        state: "screen-off",
        reason: "locked-screen",
        generation: 1,
        width: 360,
        height: 780,
      }),
    );
    expect(container.textContent).toContain("Unlock on the phone");
    act(() => button("Wake phone").click());
    expect(power).toHaveBeenLastCalledWith("wake");
  });
});
