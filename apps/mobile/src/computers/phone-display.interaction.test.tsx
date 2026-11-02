// @vitest-environment happy-dom
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { encodeDisplayViewerFrame } from "@opensteer/protocol";
import type { HostClient, WebSocketClient } from "@opensteer/client/host";
import { sharedDisplayStreams, type DisplaySnapshot } from "@opensteer/client/integrations";
import type { EditingProxyEvent } from "@opensteer/client/editing";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const state = vi.hoisted(() => ({
  dispatch: vi.fn(),
  os: "android",
  recovery: undefined as number | undefined,
  needsKeyframe: null as
    null | ((event: { nativeEvent: { epoch: string; pictureGone?: boolean } }) => void),
  binaryVersion: 1,
  geometry: "side:display@0",
  epoch: "",
  ready: null as
    null | ((event: { nativeEvent: { epoch: string; width: number; height: number } }) => void),
  touch: null as null | Record<
    string,
    (event: {
      nativeEvent: { locationX: number; locationY: number; timestamp: number; touches: unknown[] };
    }) => void
  >,
  layout: null as
    null | ((event: { nativeEvent: { layout: { width: number; height: number } } }) => void),
  proxy: null as null | { onEvent(event: EditingProxyEvent): unknown; context: unknown },
  copy: vi.fn(async () => true),
  appState: null as null | ((value: string) => void),
  /** Frames the native decoder received, as bytes or as base64 for an older binary. */
  decoded: [] as { epoch: string; bytes?: number[]; data?: string }[],
  decodeResult: null as null | (() => Promise<boolean>),
}));
vi.mock("../ui/pane.js", () => ({ usePaneGeometry: () => state.geometry }));
vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return state.os;
    },
  },
  PixelRatio: { get: () => 1 },
  AppState: {
    currentState: "active",
    addEventListener: (_: string, callback: (v: string) => void) => {
      state.appState = callback;
      return {
        remove() {
          state.appState = null;
        },
      };
    },
  },
  StyleSheet: { create: (v: unknown) => v, absoluteFill: {}, hairlineWidth: 1 },
  ActivityIndicator: () => null,
  View: (props: {
    children?: ReactNode;
    testID?: string;
    onLayout?: typeof state.layout;
    onTouchStart?: unknown;
  }) => {
    if (props.testID === "display-input") {
      state.touch = props as typeof state.touch;
      state.layout = props.onLayout ?? null;
    }
    return <div>{props.children}</div>;
  },
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
    disabled,
  }: {
    children: ReactNode;
    onPress(): void;
    accessibilityLabel?: string;
    disabled?: boolean;
  }) => (
    <button aria-label={accessibilityLabel} onClick={onPress} disabled={disabled}>
      {children}
    </button>
  ),
}));
vi.mock("expo", async () => {
  const React = await import("react");
  return {
    requireOptionalNativeModule: (name: string) =>
      name === "PhoneDisplay"
        ? { binaryPresentationVersion: state.binaryVersion, decoderRecoveryVersion: state.recovery }
        : null,
    requireNativeView: () =>
      React.forwardRef(
        (
          props: { onReady: typeof state.ready; onNeedsKeyframe: typeof state.needsKeyframe },
          ref,
        ) => {
          state.ready = props.onReady;
          state.needsKeyframe = props.onNeedsKeyframe;
          React.useImperativeHandle(ref, () => ({
            reset: async (epoch: string) => {
              state.epoch = epoch;
            },
            decode: async (frame: { epoch: string; data: string }) => {
              state.epoch = frame.epoch;
              state.decoded.push({ epoch: frame.epoch, data: frame.data });
              return state.decodeResult ? state.decodeResult() : true;
            },
            decodeBytes: async (bytes: Uint8Array, metadata: { epoch: string }) => {
              state.epoch = metadata.epoch;
              state.decoded.push({ epoch: metadata.epoch, bytes: [...bytes] });
              return state.decodeResult ? state.decodeResult() : true;
            },
          }));
          return <div />;
        },
      ),
  };
});
vi.mock("expo-clipboard", () => ({
  setStringAsync: state.copy,
  StringFormat: { PLAIN_TEXT: "plain", HTML: "html" },
}));
vi.mock("../../modules/remote-text-input/src/remote-text-input.js", () => ({
  RemoteTextInput: (props: NonNullable<typeof state.proxy>) => {
    state.proxy = props;
    useEffect(
      () => () => {
        state.proxy = null;
      },
      [],
    );
    return <div />;
  },
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ isFocused: () => true, dispatch: state.dispatch }),
  StackActions: { replace: (name: string, params: unknown) => ({ name, params }) },
}));
vi.mock(
  "../browser/toolbar.js",
  async () => (await import("../../test-support/native-chrome.js")).toolbar,
);
vi.mock("../ui/glass.js", async () => (await import("../../test-support/native-chrome.js")).glass);
vi.mock(
  "react-native-gesture-handler",
  async () => (await import("../../test-support/native-chrome.js")).gestureHandler,
);
vi.mock(
  "react-native-worklets",
  async () => (await import("../../test-support/native-chrome.js")).worklets,
);

vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock(
  "react-native-reanimated",
  async () => (await import("../../test-support/native-chrome.js")).reanimated,
);
vi.mock("../ui/primitives.js", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  SecondaryButton: ({
    label,
    accessibilityLabel,
    onPress,
  }: {
    label: string;
    accessibilityLabel?: string;
    onPress: () => void;
  }) => (
    <button aria-label={accessibilityLabel} onClick={onPress}>
      {label}
    </button>
  ),
}));
import {
  ComputerDisplay,
  ComputerTaskView,
  ComputerOwnerView,
  decodeDisplayFrame,
} from "./phone-display.js";
class Socket implements WebSocketClient {
  readyState = 0;
  binaryType: "arraybuffer" | "blob" = "arraybuffer";
  sent: Record<string, unknown>[] = [];
  listeners = new Map<string, ((event: never) => void)[]>();
  addEventListener(type: string, fn: (event: never) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, event: unknown) {
    for (const fn of this.listeners.get(type) ?? []) (fn as (event: unknown) => void)(event);
  }
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (typeof data === "string") this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  json(data: unknown) {
    this.emit("message", { data: JSON.stringify(data) });
  }
}
const sessionId = "cus_11111111-1111-4111-8111-111111111111";
const context = {
  contextId: "00000000-0000-4000-8000-000000000001",
  field: { kind: "text", multiline: true, sensitive: false },
  caret: { x: 0.4, y: 0.5, height: 0.02 },
} as const;
let root: Root | null = null;
let socket: Socket;
let container: HTMLDivElement;
const evidence: unknown[] = [];
afterEach(async () => {
  evidence.push({ case: expect.getState().currentTestName, messages: socket?.sent });
  const dir = process.env.OPENSTEER_MOBILE_EDITING_EVIDENCE_DIR ?? "/tmp/opensteer-mobile-editing";
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/display-journey.json`, JSON.stringify(evidence, null, 2));
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  vi.restoreAllMocks();
  state.copy.mockClear();
  state.geometry = "side:display@0";
  state.proxy = null;
  state.decoded = [];
  state.decodeResult = null;
  state.binaryVersion = 1;
  state.recovery = undefined;
});
async function setup(
  phone = true,
  os = "android",
  owner = false,
  interactive = true,
  screen: "display" | "task" | "owner" = "display",
) {
  state.os = os;
  socket = new Socket();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const snapshot = {
    session: "authenticated",
    user: { id: "person" },
    deploymentId: "deployment",
    machines: [
      {
        id: "machine",
        status: "online",
        kind: "personal",
        computerUse: {
          displayStreamSupported: true,
          ownerViews: owner
            ? [
                {
                  viewId: "owner-view",
                  generation: 1,
                  state: "ready",
                  target: {
                    kind: "app",
                    app: { bundleId: "com.apple.Notes", displayName: "Notes", teamId: null },
                  },
                  expiresAt: "2099-01-01T00:00:00.000Z",
                },
              ]
            : [],
          state: "ready",
          sessions: [
            {
              sessionId,
              display: phone,
              apps: [{ bundleId: "com.apple.Notes", displayName: "Notes", teamId: null }],
            },
          ],
        },
      },
    ],
  };
  const connect = vi.fn((_source: unknown, _options?: unknown) => socket);
  const client = {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    subscribeLifecycle: () => () => undefined,
    connectComputerDisplay: connect,
    retainComputerView: () => ({ release: () => undefined }),
    listApprovedComputerApps: vi.fn(async () => [
      {
        machineId: "machine",
        target: phone
          ? { kind: "phone", display: "main" }
          : {
              kind: "app",
              app: { bundleId: "com.apple.Notes", displayName: "Notes", teamId: null },
            },
      },
    ]),
    openComputerView: vi.fn(async () => ({
      viewId: "new-owner",
      generation: 2,
      machineId: "machine",
      target: phone
        ? { kind: "phone", display: "main" }
        : { kind: "app", app: { bundleId: "com.apple.Notes", displayName: "Notes", teamId: null } },
      ...(phone ? {} : { window: { id: 42, title: "Shopping" } }),
    })),
  } as unknown as HostClient;
  const pool = sharedDisplayStreams(client);
  const retain = pool.retain.bind(pool);
  const power = vi.fn(() => true);
  let override: Partial<DisplaySnapshot> = {};
  vi.spyOn(pool, "retain").mockImplementation((target) => {
    const lease = retain(target);
    return {
      ...lease,
      getSnapshot: () => {
        const value = lease.getSnapshot();
        return Object.keys(override).length
          ? cachedBase === value && cachedOverride === override
            ? cached!
            : ((cachedBase = value),
              (cachedOverride = override),
              (cached = { ...value, ...override }))
          : value;
      },
      power,
    };
  });
  let cachedBase: DisplaySnapshot | null = null;
  let cachedOverride: Partial<DisplaySnapshot> | null = null;
  let cached: DisplaySnapshot | null = null;
  const setDisplay = (next: Partial<DisplaySnapshot>) => {
    override = next;
    socket.json({
      type: "display.state",
      state: "live",
      generation: 1,
      width: 200,
      height: 400,
      sharedInput: 1,
      editingVersion: 1,
    });
  };
  const render = async (active = true) =>
    act(async () =>
      root!.render(
        screen === "task" ? (
          <ComputerTaskView
            active={active}
            hostClient={client}
            computerSessionId={sessionId}
            machineId="machine"
            appKey={phone ? null : "com.apple.notes"}
            onTyping={noop}
          />
        ) : screen === "owner" ? (
          <ComputerOwnerView
            active={active}
            hostClient={client}
            viewId="owner-view"
            windowId={phone ? undefined : 42}
            generation={1}
            machineId="machine"
            appKey={phone ? null : "com.apple.notes"}
            onTyping={noop}
          />
        ) : (
          <ComputerDisplay
            bar={{ title: phone ? "Phone" : "Notes", detail: null, menu: [], onTyping: noop }}
            active={active}
            interactive={interactive}
            phone={phone}
            label={phone ? "Phone" : "Notes"}
            hostClient={client}
            source={
              owner
                ? { kind: "owner-view", viewId: "owner-view", generation: 1 }
                : {
                    kind: "task-session",
                    sessionId,
                    ...(phone ? {} : { appKey: "com.apple.notes" }),
                  }
            }
          />
        ),
      ),
    );
  await render();
  if (os === "ios" && !phone)
    return {
      connect,
      render,
      power,
      setDisplay,
      endOwner: () => {
        snapshot.machines[0]!.computerUse.ownerViews[0]!.state = "closed";
      },
      client,
    };
  await act(async () => {
    socket.readyState = 1;
    socket.emit("open", {});
    socket.json({
      type: "display.state",
      state: "live",
      generation: 1,
      width: 200,
      height: 400,
      editingVersion: 1,
      ...(owner ? {} : { sharedInput: 1 }),
    });
    socket.emit("message", {
      data: encodeDisplayViewerFrame(
        {
          generation: 1,
          sequence: 1,
          ptsUs: 1000,
          width: 200,
          height: 400,
          key: true,
          codec: "avc1.42C01F",
        },
        new Uint8Array([0, 0, 1, 0x65]),
      ).slice().buffer,
    });
  });
  await act(async () =>
    state.ready?.({ nativeEvent: { epoch: state.epoch, width: 200, height: 400 } }),
  );
  return {
    connect,
    render,
    power,
    setDisplay,
    endOwner: () => {
      snapshot.machines[0]!.computerUse.ownerViews[0]!.state = "closed";
    },
    client,
  };
}
async function press(label: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.getAttribute("aria-label") === label || item.textContent === label,
  );
  expect(button, `Missing ${label}`).toBeDefined();
  await act(async () => button!.click());
}
function input() {
  return socket.sent.filter((m) => m.type === "display.input");
}
it("accepts input without a button, maps touch, edits, reports receipts, copies and releases on hide through the real display transport", async () => {
  const { connect, render } = await setup();
  expect(connect.mock.calls[0]?.[1]).toEqual({ editing: 1 });
  expect(container.textContent).not.toMatch(/Take over|Give back|controlling/);
  await act(async () => state.layout?.({ nativeEvent: { layout: { width: 400, height: 400 } } }));
  const touch = { nativeEvent: { locationX: 200, locationY: 200, timestamp: 10, touches: [{}] } };
  await act(async () => {
    state.touch?.onTouchStart?.(touch);
    state.touch?.onTouchEnd?.({
      ...touch,
      nativeEvent: { ...touch.nativeEvent, timestamp: 20, touches: [] },
    });
  });
  expect(input().map((m) => m.events)).toEqual([
    [{ kind: "pointer", phase: "down", x: 0.5, y: 0.5, t: 10 }],
    [{ kind: "pointer", phase: "up", x: 0.5, y: 0.5, t: 20 }],
  ]);
  await act(async () => socket.json({ type: "display.editing", generation: 1, context }));
  await press("Keyboard");
  await act(async () =>
    state.proxy?.onEvent({
      type: "input",
      inputType: "insertText",
      composing: false,
      proxy: { value: "한👩‍💻", selectionStart: 6, selectionEnd: 6 },
    }),
  );
  expect(input().at(-1)?.events).toEqual([
    { kind: "edit", edit: { contextId: context.contextId, before: "", after: "", text: "한👩‍💻" } },
  ]);
  await act(async () =>
    socket.json({
      type: "display.input.result",
      sequence: input().at(-1)?.sequence,
      outcome: "stale",
      reason: "stale",
    }),
  );
  expect(container.textContent).toContain("The field changed");
  await act(async () => state.proxy?.onEvent({ type: "cut" }));
  expect(container.textContent).toContain("Cut isn’t supported");
  await act(async () =>
    state.proxy?.onEvent({
      type: "paste",
      items: [{ type: "text/html", bytes: new TextEncoder().encode("<b>x</b>") }],
    }),
  );
  await act(async () =>
    socket.json({
      type: "display.input.result",
      sequence: input().at(-1)?.sequence,
      outcome: "refused",
      reason: "unsupported",
    }),
  );
  expect(container.textContent).toContain("doesn’t support this edit");
  await act(async () => state.proxy?.onEvent({ type: "copy" }));
  const sequence = input().at(-1)?.sequence;
  await act(async () =>
    socket.json({ type: "display.clipboard", sequence, outcome: "copied", text: "selected" }),
  );
  expect(state.copy).toHaveBeenCalledExactlyOnceWith("selected", { inputFormat: "plain" });
  evidence.push({
    case: "phone-shared-input",
    messages: socket.sent,
    clipboard: "selected",
    status: "passed-scripted-component-journey",
  });
  await render(false);
  expect(socket.sent).toContainEqual({ type: "display.input-reset" });
  expect(socket.readyState).toBe(3);
});

async function holdAndType() {
  await act(async () => socket.json({ type: "display.editing", generation: 1, context }));
  await press("Keyboard");
}

it("copies sequence zero and ignores an unrelated refusal while awaiting the exact copy sequence", async () => {
  await setup();
  await holdAndType();
  await act(async () => state.proxy?.onEvent({ type: "copy" }));
  expect(input().at(-1)?.sequence).toBe(0);
  await act(async () => {
    socket.json({
      type: "display.input.result",
      sequence: 99,
      outcome: "refused",
      reason: "unsupported",
    });
    socket.json({
      type: "display.clipboard",
      sequence: 99,
      outcome: "copied",
      text: "unsolicited",
    });
    socket.json({ type: "display.clipboard", sequence: 0, outcome: "copied", text: "first" });
  });
  expect(state.copy).toHaveBeenCalledExactlyOnceWith("first", { inputFormat: "plain" });
  await act(async () => state.proxy?.onEvent({ type: "copy" }));
  await act(async () => {
    socket.json({ type: "display.clipboard", sequence: 0, outcome: "copied", text: "late" });
    socket.json({ type: "display.clipboard", sequence: 1, outcome: "copied", text: "second" });
  });
  expect(state.copy.mock.calls).toEqual([
    ["first", { inputFormat: "plain" }],
    ["second", { inputFormat: "plain" }],
  ]);
});

it("retires pending copy and editing context when the display generation changes", async () => {
  await setup();
  await holdAndType();
  await act(async () => state.proxy?.onEvent({ type: "copy" }));
  await act(async () => {
    socket.json({
      type: "display.state",
      state: "live",
      generation: 2,
      width: 200,
      height: 400,
      editingVersion: 1,
      sharedInput: 1,
    });
    socket.json({
      type: "display.clipboard",
      sequence: 0,
      outcome: "copied",
      text: "old generation",
    });
    socket.emit("message", {
      data: encodeDisplayViewerFrame(
        {
          generation: 2,
          sequence: 2,
          ptsUs: 2000,
          width: 200,
          height: 400,
          key: true,
          codec: "avc1.42C01F",
        },
        new Uint8Array([0, 0, 1, 0x65]),
      ).slice().buffer,
    });
  });
  await act(async () =>
    state.ready?.({ nativeEvent: { epoch: state.epoch, width: 200, height: 400 } }),
  );
  expect(state.copy).not.toHaveBeenCalled();
  expect(
    container.querySelector<HTMLButtonElement>('button[aria-label="Keyboard"]')?.disabled,
  ).toBe(true);
  expect(state.proxy?.context ?? null).toBeNull();
  await act(async () =>
    socket.json({
      type: "display.editing",
      generation: 2,
      context: { ...context, contextId: "00000000-0000-4000-8000-000000000002" },
    }),
  );
  await press("Keyboard");
  await act(async () => state.proxy?.onEvent({ type: "copy" }));
  await act(async () => {
    socket.json({ type: "display.clipboard", sequence: 0, outcome: "copied", text: "still old" });
    socket.json({
      type: "display.clipboard",
      sequence: input().at(-1)?.sequence,
      outcome: "copied",
      text: "new generation",
    });
  });
  expect(state.copy).toHaveBeenCalledExactlyOnceWith("new generation", { inputFormat: "plain" });
});

it("keeps an unavailable display view-only with no input buttons", async () => {
  await setup(false, "android", true);
  await act(async () =>
    socket.json({
      type: "display.state",
      state: "live",
      generation: 1,
      width: 200,
      height: 400,
      editingVersion: 1,
    }),
  );
  expect(container.textContent).not.toMatch(/Take over|Give back|controlling/);
  expect(
    container.querySelector<HTMLButtonElement>('button[aria-label="Keyboard"]')?.disabled,
  ).toBe(true);
  expect(input()).toEqual([]);
});

it("uses shared bounded paste batches and handles every split-frame receipt", async () => {
  await setup();
  await holdAndType();
  const text = "x".repeat(29999) + "🦊" + "\u0001".repeat(60001);
  await act(async () =>
    state.proxy?.onEvent({
      type: "paste",
      items: [{ type: "text/plain", bytes: new TextEncoder().encode(text) }],
    }),
  );
  const batches = input();
  const pieces = batches.flatMap((batch) =>
    (batch.events as { text: string }[]).map((event) => event.text),
  );
  expect(pieces.join("")).toBe(text);
  expect(batches.length).toBeGreaterThan(1);
  expect(pieces.every((piece) => piece.length <= 30000 && !/[\uD800-\uDBFF]$/u.test(piece))).toBe(
    true,
  );
  for (const batch of batches) {
    expect(new TextEncoder().encode(JSON.stringify(batch)).byteLength).toBeLessThanOrEqual(
      256 * 1024,
    );
    await act(async () =>
      socket.json({
        type: "display.input.result",
        sequence: batch.sequence,
        outcome: "dispatched",
      }),
    );
  }
});
it("offers Mac input only where its video is available", async () => {
  const { connect } = await setup(false, "ios");
  expect(connect).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Mac window video is unavailable on iOS");
  await act(async () => root!.unmount());
  root = null;
  await setup(false, "android");
  expect(container.textContent).not.toMatch(/Take over|Give back/);
});

it("resets input when its keyboard blurs", async () => {
  await setup();
  await holdAndType();
  await act(async () =>
    state.proxy?.onEvent({
      type: "compositionstart",
      proxy: { value: "", selectionStart: 0, selectionEnd: 0 },
    }),
  );
  await act(async () =>
    state.proxy?.onEvent({
      type: "compositionupdate",
      data: "に",
      proxy: { value: "に", selectionStart: 1, selectionEnd: 1 },
    }),
  );
  await act(async () => state.proxy?.onEvent({ type: "blur" }));
  expect(input()).toEqual([]);
  expect(socket.sent).toContainEqual({ type: "display.input-reset" });
});

it("cancels a held touch before the stage moves and refuses stale picture input", async () => {
  await setup();
  await act(async () => state.layout?.({ nativeEvent: { layout: { width: 400, height: 400 } } }));
  const touch = { nativeEvent: { locationX: 200, locationY: 200, timestamp: 10, touches: [{}] } };
  await act(async () => state.touch?.onTouchStart?.(touch));
  await act(async () => state.layout?.({ nativeEvent: { layout: { width: 300, height: 400 } } }));
  expect(input().at(-1)?.events).toEqual([
    { kind: "pointer", phase: "cancel", x: 0.5, y: 0.5, t: 10 },
  ]);
  const sent = input().length;
  await act(async () => {
    socket.json({
      type: "display.state",
      state: "live",
      generation: 2,
      width: 400,
      height: 200,
      editingVersion: 1,
      sharedInput: 1,
    });
    state.touch?.onTouchEnd?.({
      ...touch,
      nativeEvent: { ...touch.nativeEvent, timestamp: 20, touches: [] },
    });
  });
  expect(input()).toHaveLength(sent);
});

it("keeps passive grid previews free of editing negotiation and take-over controls", async () => {
  const { connect } = await setup(true, "android", false, false);
  expect(connect.mock.calls[0]?.[1]).toBeUndefined();
  expect(container.querySelector('button[aria-label="Take over"]')).toBeNull();
});

it("keeps Mac task screens passive and negotiates editing for phone owner screens", async () => {
  let opened = await setup(false, "android", false, true, "task");
  expect(opened.connect.mock.calls[0]?.[1]).toBeUndefined();
  expect(container.querySelector('button[aria-label="Take over"]')).toBeNull();
  await act(async () => root!.unmount());
  root = null;
  opened = await setup(true, "android", true, true, "owner");
  expect(opened.connect.mock.calls[0]?.[1]).toEqual({ editing: 1 });
  expect(container.textContent).toContain("View only");
});

it("cancels local preedit and resets input when its screen hides", async () => {
  const { render } = await setup();
  await act(async () => socket.json({ type: "display.editing", generation: 1, context }));
  await press("Keyboard");
  await act(async () => {
    state.proxy?.onEvent({
      type: "compositionstart",
      proxy: { value: "", selectionStart: 0, selectionEnd: 0 },
    });
    state.proxy?.onEvent({
      type: "compositionupdate",
      data: "に",
      proxy: { value: "に", selectionStart: 1, selectionEnd: 1, markedRange: { start: 0, end: 1 } },
    });
  });
  await render(false);
  const committed = socket.sent.findIndex(
    (message) =>
      message.type === "display.input" && JSON.stringify(message.events).includes('"text":"に"'),
  );
  const released = socket.sent.findIndex((message) => message.type === "display.input-reset");
  expect(committed).toBe(-1);
  expect(released).toBeGreaterThanOrEqual(0);
});

it("hands the transport's frame bytes to a binary that takes them, under the epoch it was queued for", async () => {
  await setup();
  expect(state.decoded).toEqual([{ epoch: state.epoch, bytes: [0, 0, 1, 0x65] }]);
});

it.each([0, 1])(
  "submits four native frames in order without waiting for bridge replies and acknowledges in order (binary version %i)",
  async (binaryVersion) => {
    state.binaryVersion = binaryVersion;
    await setup();
    const finish: ((accepted: boolean) => void)[] = [];
    state.decodeResult = () => new Promise((resolve) => finish.push(resolve));
    await act(async () => {
      for (let sequence = 2; sequence <= 5; sequence++)
        socket.emit("message", {
          data: encodeDisplayViewerFrame(
            {
              generation: 1,
              sequence,
              ptsUs: sequence * 1000,
              width: 200,
              height: 400,
              key: false,
            },
            Uint8Array.of(sequence),
          ).slice().buffer,
        });
    });
    expect(
      state.decoded.slice(1).map((frame) => frame.bytes ?? [...Buffer.from(frame.data!, "base64")]),
    ).toEqual([[2], [3], [4], [5]]);
    expect(finish).toHaveLength(4);
    await act(async () => {
      finish[3]!(true);
      finish[1]!(true);
    });
    expect(
      socket.sent
        .filter((message) => message.type === "display.ack")
        .map((message) => message.sequence),
    ).toEqual([1]);
    await act(async () => finish[0]!(true));
    expect(
      socket.sent
        .filter((message) => message.type === "display.ack")
        .map((message) => message.sequence),
    ).toEqual([1, 2, 3]);
    await act(async () => finish[2]!(true));
    expect(
      socket.sent
        .filter((message) => message.type === "display.ack")
        .map((message) => message.sequence),
    ).toEqual([1, 2, 3, 4, 5]);
  },
);

it("holds every delta after a frame it had no room for until a key arrives", async () => {
  await setup();
  const finish: ((accepted: boolean) => void)[] = [];
  state.decodeResult = () => new Promise((resolve) => finish.push(resolve));
  const send = (sequence: number, key: boolean) =>
    socket.emit("message", {
      data: encodeDisplayViewerFrame(
        {
          generation: 1,
          sequence,
          ptsUs: sequence * 1000,
          width: 200,
          height: 400,
          ...(key ? { key: true, codec: "avc1.42C01F" } : { key: false }),
        },
        Uint8Array.of(sequence),
      ).slice().buffer,
    });
  // Four frames fill the queue, so the fifth is dropped and its successors lose their reference.
  await act(async () => {
    for (let sequence = 2; sequence <= 6; sequence++) send(sequence, false);
  });
  expect(socket.sent).toContainEqual({ type: "display.keyframe" });
  await act(async () => finish.forEach((resolve) => resolve(true)));
  await act(async () => send(7, false));
  expect(state.decoded.slice(1).map((frame) => frame.bytes)).toEqual([[2], [3], [4], [5]]);
  await act(async () => send(8, true));
  expect(state.decoded.at(-1)?.bytes).toEqual([8]);
});

it("keeps native submissions bounded with a larger viewer window and fences pending work on hide", async () => {
  const { render } = await setup();
  const finish: ((accepted: boolean) => void)[] = [];
  state.decodeResult = () => new Promise((resolve) => finish.push(resolve));
  await act(async () => {
    socket.json({
      type: "display.state",
      state: "live",
      generation: 1,
      width: 200,
      height: 400,
      displayWindow: 1,
    });
    for (let sequence = 2; sequence <= 12; sequence++)
      socket.emit("message", {
        data: encodeDisplayViewerFrame(
          { generation: 1, sequence, ptsUs: sequence * 1000, width: 200, height: 400, key: false },
          Uint8Array.of(sequence),
        ).slice().buffer,
      });
  });
  expect(finish).toHaveLength(4);
  expect(state.decoded.slice(1).map((frame) => frame.bytes)).toEqual([[2], [3], [4], [5]]);
  await act(async () => finish[0]!(true));
  expect(finish).toHaveLength(5);
  expect(state.decoded.at(-1)?.bytes).toEqual([6]);
  await render(false);
  const count = state.decoded.length;
  const keyframes = socket.sent.filter((message) => message.type === "display.keyframe").length;
  await act(async () => finish.slice(1).forEach((resolve) => resolve(false)));
  expect(state.decoded).toHaveLength(count);
  expect(socket.sent.filter((message) => message.type === "display.keyframe")).toHaveLength(
    keyframes,
  );
});

it("sends standard padded base64 to a binary that predates byte frames", async () => {
  const decode = vi.fn(async () => true);
  const decodeBytes = vi.fn(async () => true);
  const metadata = { epoch: "3", width: 2, height: 2, pts: 1, key: true, replayed: false };
  const reset = async () => undefined;
  // The JavaScript bundle may be newer than the binary: without its declaration, bytes are never sent.
  await decodeDisplayFrame(
    { reset, decode, decodeBytes },
    false,
    Uint8Array.of(0xfb, 0xff),
    metadata,
  );
  await decodeDisplayFrame({ reset, decode }, true, Uint8Array.of(0xfb, 0xff, 0xfe, 1), metadata);
  expect(decodeBytes).not.toHaveBeenCalled();
  expect(decode.mock.calls).toEqual([
    [{ ...metadata, data: "+/8=" }],
    [{ ...metadata, data: "+//+AQ==" }],
  ]);
});

it("cancels a held display stroke when its pane moves without resizing", async () => {
  const { render } = await setup();
  await act(async () => state.layout?.({ nativeEvent: { layout: { width: 400, height: 400 } } }));
  const touch = { nativeEvent: { locationX: 200, locationY: 200, timestamp: 10, touches: [{}] } };
  await act(async () => state.touch?.onTouchStart?.(touch));
  state.geometry = "tabletop:display@1";
  await render();
  expect(input().at(-1)?.events).toEqual([
    { kind: "pointer", phase: "cancel", x: 0.5, y: 0.5, t: 10 },
  ]);
  const count = input().length;
  await act(async () =>
    state.touch?.onTouchEnd?.({
      ...touch,
      nativeEvent: { ...touch.nativeEvent, timestamp: 20, touches: [] },
    }),
  );
  expect(input()).toHaveLength(count);
});

it.each(["android", "ios"])(
  "shows phone owner navigation only with input, wakes screen-off and locks live phones on %s",
  async (os) => {
    const { setDisplay, power } = await setup(true, os, true, true, "owner");
    expect(container.textContent).toContain("View only");
    for (const label of ["Back", "Home", "Recent apps"]) {
      expect(
        container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)?.disabled,
      ).toBe(true);
      await press(label);
    }
    expect(input()).toEqual([]);
    await act(async () => setDisplay({ input: "available", power: "available" }));
    expect(container.textContent).not.toContain("View only");
    expect(container.querySelector('button[aria-label="Back"]')).not.toBeNull();
    for (const [label, to] of [
      ["Back", "back"],
      ["Home", "home"],
      ["Recent apps", "recents"],
    ]) {
      await press(label!);
      expect(input().at(-1)?.events).toEqual([{ kind: "nav", to }]);
    }
    await press("Lock phone");
    expect(power).toHaveBeenLastCalledWith("lock");
    await act(async () =>
      setDisplay({
        input: "unavailable",
        power: "available",
        display: {
          type: "display.state",
          state: "screen-off",
          generation: 1,
          width: 200,
          height: 400,
        },
      }),
    );
    expect(container.textContent).toContain("screen is off");
    await press("Wake phone");
    expect(power).toHaveBeenLastCalledWith("wake");
    await act(async () =>
      setDisplay({
        input: "unavailable",
        power: "available",
        display: {
          type: "display.state",
          state: "protected",
          reason: "locked-screen",
          generation: 1,
          width: 200,
          height: 400,
        },
      }),
    );
    expect(container.textContent).toContain("Unlock it on the phone.");
    expect(container.textContent).not.toContain("Wake phone");
  },
);

it("coalesces moves while preserving the latest timestamp before lift and cancellation", async () => {
  await setup();
  await act(async () => state.layout?.({ nativeEvent: { layout: { width: 400, height: 400 } } }));
  const touch = (timestamp: number, y = 200) => ({
    nativeEvent: { locationX: 200, locationY: y, timestamp, touches: [{}] },
  });
  await act(async () => {
    state.touch?.onTouchStart?.(touch(10));
    state.touch?.onTouchMove?.(touch(11, 210));
    state.touch?.onTouchMove?.(touch(12, 220));
    state.touch?.onTouchEnd?.(touch(13, 230));
  });
  expect(input().flatMap((m) => m.events)).toEqual([
    { kind: "pointer", phase: "down", x: 0.5, y: 0.5, t: 10 },
    { kind: "pointer", phase: "move", x: 0.5, y: 0.55, t: 12 },
    { kind: "pointer", phase: "up", x: 0.5, y: 0.575, t: 13 },
  ]);
});

it("reopens an ended phone owner view through the explicit open path", async () => {
  const { endOwner, render, client } = await setup(true, "android", true, true, "owner");
  endOwner();
  await render();
  expect(container.textContent).toContain("This view has ended");
  await press("Reopen phone");
  expect(client.openComputerView).toHaveBeenCalledWith("machine", {
    kind: "phone",
    display: "main",
  });
  expect(state.dispatch).toHaveBeenLastCalledWith({
    name: "WorkspaceBrowser",
    params: {
      deploymentId: "deployment",
      scope: "workspace",
      phone: true,
      machineId: "machine",
      viewId: "new-owner",
      generation: 2,
    },
  });
});

it("reopens an ended Mac view by app name and the same window, replacing its route", async () => {
  const { endOwner, render, client } = await setup(false, "android", true, true, "owner");
  endOwner();
  await render();
  await press("Reopen Notes");
  expect(client.openComputerView).toHaveBeenCalledWith("machine", {
    kind: "app",
    app: { bundleId: "com.apple.Notes", displayName: "Notes", teamId: null },
    window: 42,
  });
  expect(state.dispatch).toHaveBeenLastCalledWith({
    name: "WorkspaceBrowser",
    params: {
      deploymentId: "deployment",
      scope: "workspace",
      appKey: "com.apple.notes",
      machineId: "machine",
      viewId: "new-owner",
      generation: 2,
      windowId: 42,
    },
  });
});

it("explains when the ended Mac app is no longer approved", async () => {
  const { endOwner, render, client } = await setup(false, "android", true, true, "owner");
  vi.mocked(client.listApprovedComputerApps).mockResolvedValue([]);
  endOwner();
  await render();
  await press("Reopen Notes");
  expect(container.textContent).toContain("This app is no longer approved for viewing.");
  expect(client.openComputerView).not.toHaveBeenCalled();
});

it.each(["owner", "task"] as const)(
  "plays a Mac %s on a recovery-capable iOS binary",
  async (screen) => {
    state.recovery = 1;
    const { connect } = await setup(false, "ios", screen === "owner", true, screen);
    expect(connect).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("Mac window video is unavailable");
  },
);
it("revokes picture input and requests a key when the decoder loses its picture", async () => {
  await setup();
  await holdAndType();
  const before = socket.sent.length;
  await act(async () =>
    state.needsKeyframe?.({ nativeEvent: { epoch: state.epoch, pictureGone: true } }),
  );
  expect(socket.sent.slice(before)).toContainEqual({ type: "display.keyframe" });
  expect(socket.sent.slice(before)).toContainEqual({ type: "display.input-reset" });
  const keyboard = () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Keyboard"]');
  expect(keyboard()?.disabled).toBe(true);
  // A key can already be queued when the asynchronous loss event reaches JS.
  await act(async () =>
    state.ready?.({ nativeEvent: { epoch: state.epoch, width: 200, height: 400 } }),
  );
  await act(async () => socket.json({ type: "display.editing", generation: 1, context }));
  expect(keyboard()?.disabled).toBe(false);
});

function noop(): void {}
