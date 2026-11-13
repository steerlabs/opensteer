// @vitest-environment happy-dom
import { act, useImperativeHandle, type ReactElement, type ReactNode, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

/*
 * "3 new ↓" on a team timeline: pressing it must move the list to the newest
 * message, and only reaching it (the list's own scroll) may count as following,
 * which is what lets the screen mark the channel read.
 */
const harness = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
  scrollToOffset: vi.fn(),
  scroll: null as ((y: number) => void) | null,
  inset: null as ((top: number) => void) | null,
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
type Children = { readonly children?: ReactNode };
vi.mock("react-native", () => ({
  Platform: {
    OS: "ios",
    select: (options: { ios?: unknown; default?: unknown }) => options.ios ?? options.default,
  },
  StyleSheet: { create: (styles: object) => styles, hairlineWidth: 1 },
  View: ({ children }: Children) => <div>{children}</div>,
  Pressable: (props: Children & { accessibilityLabel?: string; onPress?: () => void }) => (
    <button aria-label={props.accessibilityLabel} onClick={props.onPress}>
      {props.children}
    </button>
  ),
  FlatList: (props: {
    readonly ref?: Ref<unknown>;
    readonly onScroll: (event: { nativeEvent: { contentOffset: { y: number } } }) => void;
    readonly renderScrollComponent: (props: object) => ReactElement<{
      readonly onContentInsetChange: (insets: { bottom: number; top: number }) => void;
    }>;
  }) => {
    useImperativeHandle(props.ref, () => ({
      scrollToIndex: harness.scrollToIndex,
      scrollToOffset: harness.scrollToOffset,
    }));
    harness.scroll = (y) => props.onScroll({ nativeEvent: { contentOffset: { y } } });
    harness.inset = (top) =>
      props.renderScrollComponent({}).props.onContentInsetChange({ bottom: 0, top });
    return <div />;
  },
}));
vi.mock("../thread/composer-dock.js", () => ({
  DockScrollView: () => null,
  OverDock: ({ children }: Children) => <>{children}</>,
}));
vi.mock("../ui/glass.js", () => ({
  GlassSurface: ({ children }: Children) => <div>{children}</div>,
}));
vi.mock("../ui/primitives.js", () => ({
  AppText: ({ children }: Children) => <span>{children}</span>,
}));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("./message-row.js", () => ({
  AgentCardRow: () => null,
  DayPill: () => null,
  MessageRow: () => null,
  NewLine: () => null,
  SystemLine: () => null,
  wordsInset: 0,
}));
vi.mock("./team-marks.js", () => ({ PeopleOnlyBadge: () => null, peopleOnlySentence: "" }));

const { Timeline } = await import("./timeline.js");

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

it("scrolls to the newest message on 'N new', and follows only once the list is there", () => {
  const onFollowingChange = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <Timeline
        actions={
          {
            onFollowingChange,
            onLoadOlder: () => undefined,
          } as never
        }
        clearance={0}
        intro={null}
        items={[]}
        jump={{ direction: "down", label: "3 new" }}
        typing={null}
      />,
    ),
  );
  // The reader is far above the newest message.
  act(() => harness.scroll!(600));
  expect(onFollowingChange).toHaveBeenLastCalledWith(false);
  onFollowingChange.mockClear();

  act(() => host.querySelector<HTMLButtonElement>("button[aria-label^='3 new']")!.click());
  expect(harness.scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: true });
  // Pressing alone says nothing about where the reader is.
  expect(onFollowingChange).not.toHaveBeenCalled();
  // With the keyboard up the newest message is past its inset, not under it.
  act(() => harness.inset!(300));
  act(() => host.querySelector<HTMLButtonElement>("button[aria-label^='3 new']")!.click());
  expect(harness.scrollToOffset).toHaveBeenLastCalledWith({ offset: -300, animated: true });

  act(() => harness.scroll!(0));
  expect(onFollowingChange).toHaveBeenCalledExactlyOnceWith(true);
});

it("brings a linked message into view once it has loaded, and only once", () => {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const message = (id: string) => ({ kind: "message", message: { id } }) as never;
  const draw = (items: readonly never[]) =>
    act(() =>
      root!.render(
        <Timeline
          actions={{ onFollowingChange: () => undefined, onLoadOlder: () => undefined } as never}
          anchorId="7"
          clearance={0}
          intro={null}
          items={items}
          jump={null}
          typing={null}
        />,
      ),
    );
  // The newest page arrives first; the linked message is not in it yet.
  draw([message("90"), message("91")]);
  expect(harness.scrollToIndex).not.toHaveBeenCalled();
  // Its page lands: newest first, it is the third row from the bottom.
  draw([message("6"), message("7"), message("8"), message("90"), message("91")]);
  expect(harness.scrollToIndex).toHaveBeenCalledExactlyOnceWith({
    animated: false,
    index: 3,
    viewPosition: 0.5,
  });
  draw([message("6"), message("7"), message("8"), message("90"), message("91"), message("92")]);
  expect(harness.scrollToIndex).toHaveBeenCalledTimes(1);
});
