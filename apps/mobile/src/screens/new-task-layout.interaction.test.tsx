// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { layoutPhones, layoutTextSizes } from "../../test-support/layout-phones.js";
import {
  coveringOf,
  layout,
  layoutWindow,
  overlaps,
  textElement,
  type Frames,
} from "../../test-support/yoga-frames.js";

/*
 * The Tasks screen with nothing written yet, laid out by React Native's own layout engine at
 * the smallest phone and beside iPhone Duo's vertical bar, at the default and the largest text
 * size. The walk saw the composer standing over the heading at the largest size. Here the
 * heading and the composer never cover each other at rest.
 */

const geometry = vi.hoisted(() => ({
  header: 0,
  insets: { bottom: 0, left: 0, right: 0, top: 0 },
}));

vi.mock(
  "react-native",
  async () => (await import("../../test-support/yoga-frames.js")).layoutReactNative,
);
vi.mock("react-native-reanimated", async () => {
  const base = (await import("../../test-support/yoga-frames.js")).layoutReanimated;
  // Transitions are builders; at rest they change no frame.
  const chain: object = new Proxy({}, { get: () => () => chain });
  return {
    ...base,
    default: { ...base.default, createAnimatedComponent: (component: unknown) => component },
    FadeIn: chain,
    FadeInDown: chain,
    FadeInUp: chain,
    FadeOut: chain,
    LinearTransition: chain,
    useAnimatedRef: () => ({ current: null }),
    useDerivedValue: (run: () => unknown) => ({ value: run() }),
  };
});
vi.mock("react-native-keyboard-controller", async () => {
  const { ScrollView } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;
  return {
    KeyboardChatScrollView: ScrollView,
    useReanimatedKeyboardAnimation: () => ({ height: { value: 0 }, progress: { value: 0 } }),
  };
});
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => geometry.insets,
  useSafeAreaFrame: () => ({ height: 0, width: 0, x: 0, y: 0 }),
  SafeAreaProvider: (props: { children?: ReactNode }) => props.children,
}));
vi.mock("@react-navigation/elements", () => ({ useHeaderHeight: () => geometry.header }));
vi.mock("@react-navigation/native", () => ({
  StackActions: { push: () => ({}) },
  useNavigation: () => ({ dispatch: () => undefined, navigate: () => undefined }),
  useIsFocused: () => true,
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: async () => true }));
vi.mock("expo-haptics", () => ({
  ImpactFeedbackStyle: { Heavy: "heavy", Light: "light", Medium: "medium" },
  NotificationFeedbackType: { Error: "error", Success: "success", Warning: "warning" },
  impactAsync: async () => undefined,
  notificationAsync: async () => undefined,
  selectionAsync: async () => undefined,
}));
vi.mock("../ui/symbol.js", async () => {
  const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;
  return {
    Symbol: (props: { size?: number }) => (
      <View style={{ height: props.size ?? 17, width: props.size ?? 17 }} />
    ),
  };
});
vi.mock("../thread/composer-menu.js", async () => {
  const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;
  return {
    NativeMenu: (props: { children?: ReactNode; style?: unknown }) => (
      <View style={props.style}>{props.children}</View>
    ),
  };
});
// Glass draws a surface of the size it is given; the native effect is not what this reads.
vi.mock("expo-glass-effect", async () => {
  const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;
  return {
    GlassView: (props: { children?: ReactNode; style?: unknown }) => (
      <View style={props.style}>{props.children}</View>
    ),
    isGlassEffectAPIAvailable: () => false,
    isLiquidGlassAvailable: () => false,
  };
});
// No call is on: the voice dock draws nothing, as it does at rest.
vi.mock("../voice/controls.js", () => ({ VoiceDock: () => null, VoiceMic: () => null }));
vi.mock("../voice/use-voice-value.js", () => ({
  useVoiceAvailable: () => false,
  useVoiceValue: () => false,
}));
// Nothing is sent here: the started task's view is not drawn.
vi.mock("../thread/first-message-started.js", () => ({ FirstMessageStarted: () => null }));
vi.mock("../thread/settings/engine-mark.js", () => ({ EngineMark: () => null }));
vi.mock("../voice/cursor-mark.js", () => ({ PillMic: () => null, VoiceCursor: () => null }));
vi.mock("../ui/composer-editor.js", () => import("../ui/composer-editor.fake.js"));
vi.mock("react-native-webview", () => ({ WebView: () => null }));
vi.mock("../dictation/context.js", () => ({ useDictation: () => null }));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: (props: { readonly children?: ReactNode }) => props.children,
}));
vi.mock("../computers/phone-display-native.js", () => ({
  macWindowVideoSupported: () => true,
  nativePictureView: () => null,
}));
vi.mock("../client/mobile-client.js", () => ({
  operationDetail: (_error: unknown, fallback: string) => fallback,
}));
vi.mock("../platform/attachment-draft-files.js", () => ({
  openChatDraftFile: () => undefined,
  pickChatFile: async () => null,
  pickChatPhoto: async () => null,
  removeChatDraftFile: () => undefined,
  shareChatAttachment: async () => undefined,
}));
vi.mock("../ui/notifications-context.js", () => ({
  useMobileNotifications: () => ({
    enterThread: () => () => undefined,
    intro: null,
    registration: { afterSuccessfulSend: async () => {} },
    readingLatest: () => undefined,
  }),
  usePushRegistration: () => ({ status: "signed-out" }),
}));
vi.mock("../ui/keyboard.js", () => ({ useKeyboardVisible: () => false }));
vi.mock("../ui/cellular.js", () => ({ useCellular: () => false }));
/** What the person has typed, when a case has typed something. */
const typed = vi.hoisted(() => ({ text: null as string | null }));
vi.mock("../ui/mobile-client-context.js", async (actual) => ({
  ...(await actual<typeof import("../ui/mobile-client-context.js")>()),
  useMobileClient: () => ({
    drafts: {
      getVersion: () => 0,
      readDraft: () => (typed.text === null ? null : { text: typed.text }),
      readDraftUnsaved: () => false,
      subscribe: () => () => undefined,
      writeDraft: async () => undefined,
    },
  }),
}));

const { HeldNewTaskPane } = await import("./new-task.js");
const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  layoutWindow.fontScale = 1;
});

describe("the Tasks screen's heading and its composer", () => {
  for (const phone of layoutPhones)
    for (const fontScale of layoutTextSizes)
      it(`never cover each other on ${phone.name} at text size ${fontScale}`, async () => {
        geometry.header = phone.header;
        geometry.insets = phone.insets;
        Object.assign(layoutWindow, phone.window, { fontScale });
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        roots.push(root);
        await act(async () =>
          root.render(
            <View style={{ height: phone.window.height, width: phone.window.width }}>
              <HeldNewTaskPane
                connection={null}
                deploymentId="dep_mock"
                name="Studio Mac"
                underHeader
                userId={"usr_mock" as never}
              />
            </View>,
          ),
        );
        const frames = await layout(container, phone.window);
        expect(frames.settled, "the layout never comes to rest").toBe(true);
        const heading = textElement(container, "What should your agent do?");
        const dock = container.querySelector('[data-testid="composer-dock-stack"]');
        if (!dock) throw new Error("No composer");
        expect(frames.cut(heading), "the heading is cut").toBe(false);
        expect(
          overlaps(frames.frame(heading), frames.frame(dock)),
          "the composer stands over the heading",
        ).toBe(false);
        // Nothing else is drawn over the heading: the dock's own full-pane layer passes touches
        // through and draws nothing, so only what it holds is asked about, above.
        expect(
          coveringOf(container, frames, heading).filter((element) => !element.contains(dock)),
          "something covers the heading",
        ).toEqual([]);
      });
});

/**
 * Whether a person can read an element to its last line above the composer: scrolled as far as
 * its scroll view goes (or as it stands, when nothing scrolls it), its bottom is above the dock.
 */
function readableAboveDock(frames: Frames, element: Element, dock: Element): boolean {
  const frame = frames.frame(element);
  const dockTop = frames.frame(dock).y;
  const content = element.closest('[data-rn="ScrollContent"]');
  if (!content?.parentElement) return frame.y + frame.height <= dockTop + 0.5;
  const box = frames.frame(content);
  const view = frames.frame(content.parentElement);
  const furthest = Math.max(0, box.y + box.height - (view.y + view.height));
  return frame.y + frame.height - furthest <= dockTop + 0.5;
}

describe("the Tasks screen's empty state", () => {
  for (const phone of layoutPhones)
    for (const fontScale of layoutTextSizes)
      it(`can be read to its end above the composer on ${phone.name} at text size ${fontScale}`, async () => {
        geometry.header = phone.header;
        geometry.insets = phone.insets;
        Object.assign(layoutWindow, phone.window, { fontScale });
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        roots.push(root);
        await act(async () =>
          root.render(
            <View style={{ height: phone.window.height, width: phone.window.width }}>
              <HeldNewTaskPane
                connection={null}
                deploymentId="dep_mock"
                name="Studio Mac"
                underHeader
                userId={"usr_mock" as never}
              />
            </View>,
          ),
        );
        const frames = await layout(container, phone.window);
        expect(frames.settled, "the layout never comes to rest").toBe(true);
        const dock = container.querySelector('[data-testid="composer-dock-stack"]');
        if (!dock) throw new Error("No composer");
        const paragraph = textElement(container, "Your agent works on this computer.");
        expect(frames.cut(paragraph), "the paragraph is cut").toBe(false);
        expect(
          readableAboveDock(frames, paragraph, dock),
          "the paragraph can't be brought out from behind the composer",
        ).toBe(true);
        // The last way to begin, too: the whole empty state is there to be read.
        const last = textElement(container, "Plan before changing anything");
        expect(
          readableAboveDock(frames, last, dock),
          "the last way to begin can't be brought out from behind the composer",
        ).toBe(true);
      });
});

describe("a message that couldn't start a task", () => {
  for (const phone of layoutPhones)
    for (const fontScale of layoutTextSizes)
      it(`says why whole, above the composer, on ${phone.name} at text size ${fontScale}`, async () => {
        geometry.header = phone.header;
        geometry.insets = phone.insets;
        Object.assign(layoutWindow, phone.window, { fontScale });
        typed.text = "Find flights to Lisbon for next weekend";
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        roots.push(root);
        try {
          await act(async () =>
            root.render(
              <View style={{ height: phone.window.height, width: phone.window.width }}>
                <HeldNewTaskPane
                  connection={null}
                  deploymentId="dep_mock"
                  name="Studio Mac"
                  underHeader
                  userId={"usr_mock" as never}
                />
              </View>,
            ),
          );
          const send = container.querySelector('[aria-label="Send message"]');
          if (!send) throw new Error(`No Send: ${container.textContent ?? ""}`);
          await act(async () => (send as HTMLElement).click());
          const frames = await layout(container, phone.window);
          expect(frames.settled, "the layout never comes to rest").toBe(true);
          const dock = container.querySelector('[data-testid="composer-dock-stack"]');
          if (!dock) throw new Error("No composer");
          const line = [...container.querySelectorAll('[data-rn="Text"]')].find((text) =>
            /^Not started\b|^Couldn/u.test(text.textContent ?? ""),
          );
          if (!line) throw new Error(`No failure line: ${container.textContent ?? ""}`);
          const words = line.textContent!;
          expect(frames.shown(line), "the failure is cut").toBe(words);
          expect(
            readableAboveDock(frames, line, dock),
            "the failure can't be brought out from behind the composer",
          ).toBe(true);
        } finally {
          typed.text = null;
        }
      });
});
