// @vitest-environment happy-dom
import { act, useImperativeHandle, type ReactNode, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

/*
 * "3 new ↓" on a team timeline: pressing it must move the list to the newest
 * message, and only reaching it (the list's own scroll) may count as following,
 * which is what lets the screen mark the channel read.
 */
const harness = vi.hoisted(() => ({
  scrollToOffset: vi.fn(),
  scroll: null as ((y: number) => void) | null,
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
  }) => {
    useImperativeHandle(props.ref, () => ({ scrollToOffset: harness.scrollToOffset }));
    harness.scroll = (y) => props.onScroll({ nativeEvent: { contentOffset: { y } } });
    return <div />;
  },
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

  act(() => harness.scroll!(0));
  expect(onFollowingChange).toHaveBeenCalledExactlyOnceWith(true);
});
