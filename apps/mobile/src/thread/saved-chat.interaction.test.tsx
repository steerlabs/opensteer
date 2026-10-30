// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createId } from "@opensteer/core";
import { afterEach, expect, it, vi } from "vitest";
const observed = vi.hoisted(() => ({
  handlers: [] as string[],
  openURL: vi.fn(),
  clipboard: vi.fn(),
}));
type NativeProps = {
  readonly children?: ReactNode;
  readonly accessibilityLabel?: string;
  readonly [key: string]: unknown;
};
vi.mock("react-native", () => {
  const native = (tag: string) => (props: NativeProps) => {
    observed.handlers.push(
      ...Object.keys(props).filter(
        (key) => key.startsWith("on") && typeof props[key] === "function",
      ),
    );
    return createElement(tag, { "aria-label": props.accessibilityLabel }, props.children);
  };
  return {
    StyleSheet: { create: (value: object) => value, hairlineWidth: 1 },
    Platform: { OS: "ios", select: () => "" },
    Text: native("span"),
    View: native("div"),
    ScrollView: native("div"),
    Pressable: native("button"),
    Linking: { openURL: observed.openURL },
    Alert: { alert: vi.fn() },
  };
});
vi.mock("react-native-reanimated", () => ({
  default: { View: () => null },
  cancelAnimation: () => undefined,
  Easing: {},
  useAnimatedStyle: () => ({}),
  useReducedMotion: () => true,
  useSharedValue: () => ({ value: 0 }),
  withDelay: () => 0,
  withRepeat: () => 0,
  withSequence: () => 0,
  withTiming: () => 0,
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: observed.clipboard }));
vi.mock("expo-haptics", () => ({ selectionAsync: vi.fn() }));
vi.mock("../ui/screen.js", () => ({ useReadingColumn: () => ({}) }));
vi.mock("react-native-svg", () => {
  const graphic = ({ children }: { readonly children?: ReactNode }) => <svg>{children}</svg>;
  return {
    default: graphic,
    Circle: graphic,
    Defs: graphic,
    Ellipse: graphic,
    Line: graphic,
    LinearGradient: graphic,
    Path: graphic,
    Polyline: graphic,
    Rect: graphic,
    Stop: graphic,
  };
});
import { SavedChat } from "./saved-chat.js";
import { SavedTasks } from "../sidebar/saved-tasks.js";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const close: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of close.splice(0)) cleanup();
  observed.handlers.length = 0;
  vi.restoreAllMocks();
});
it("draws literal text and historical task subjects without effects, actions, links, media or health", async () => {
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Saved rendering must not fetch"));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  close.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const timestamp = "2026-10-29T00:00:00.000Z";
  await act(async () =>
    root.render(
      <>
        <SavedChat
          content={{
            workspaceId: createId("workspace"),
            threadId: createId("thread"),
            messages: [
              {
                voice: "mine",
                text: "[private text](https://example.test) ![media](https://example.test/image.png)",
              },
              { voice: "agent", text: "Published reply" },
            ],
          }}
          capturedAt={timestamp}
          paddingTop={0}
        />
        <SavedTasks
          tasks={[
            {
              id: createId("thread"),
              workspaceId: createId("workspace"),
              title: "Saved subject",
              glyph: { icon: null, color: null },
              group: "working",
            },
          ]}
          label="Updating…"
          capturedAt={timestamp}
        />
      </>,
    ),
  );
  container.dispatchEvent(new Event("scroll", { bubbles: true }));
  container.dispatchEvent(new Event("click", { bubbles: true }));
  expect(container.textContent).toContain("[private text](https://example.test)");
  expect(container.textContent).toContain("Published reply");
  expect(container.textContent).toContain("Last seen Working");
  expect(container.textContent).toContain("Updating…");
  expect(container.querySelectorAll("a,button,img,video,audio,input")).toHaveLength(0);
  expect(container.textContent).not.toMatch(/Connected|Needs you|Unread|Retry/u);
  expect(observed.handlers).toEqual([]);
  expect(observed.openURL).not.toHaveBeenCalled();
  expect(observed.clipboard).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
  expect(
    container.querySelector(`[aria-label="Saved view, last updated ${timestamp}."]`),
  ).not.toBeNull();
});
