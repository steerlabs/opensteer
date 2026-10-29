// @vitest-environment happy-dom

import { act, useImperativeHandle, type ReactNode, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRetainedScroll, type ScrollMemory } from "./retained-scroll.js";

/*
 * A list whose view is replaced while its place is kept elsewhere — the
 * sidebar's drawer and docked column, swapped by a fold. What can go wrong:
 * - the new view starts at the top, so the reader loses their place;
 * - the place is applied before the rows are there, so the list clamps to its
 *   top and the place is spent;
 * - it is applied again later, pulling a reader who has since scrolled back;
 * - the list's own movement while restoring is recorded as the reader's.
 */

const scrollTo = vi.fn();
type Handlers = ReturnType<typeof useRetainedScroll>;
let handlers: Handlers | null = null;

function List(props: { readonly memory: ScrollMemory }): ReactNode {
  const retained = useRetainedScroll(props.memory);
  handlers = retained;
  return <FakeScrollView ref={retained.ref} />;
}

function FakeScrollView(props: { readonly ref: Ref<unknown> }): ReactNode {
  useImperativeHandle(props.ref, () => ({ scrollTo }));
  return <div />;
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  scrollTo.mockReset();
  handlers = null;
});

function mount(memory: ScrollMemory) {
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  act(() => root.render(<List memory={memory} />));
  return root;
}

const offset = (y: number) => ({ nativeEvent: { contentOffset: { x: 0, y } } });
const layout = (height: number) => ({
  nativeEvent: { layout: { height, width: 320, x: 0, y: 0 } },
});

function current(): Handlers {
  if (handlers === null) throw new Error("The list is not mounted.");
  return handlers;
}

describe("a list's place kept across its views", () => {
  it("returns a replaced list to where the reader left it, once its rows are there", () => {
    const memory: ScrollMemory = { offset: 0 };
    const drawer = mount(memory);
    act(() => current().onScrollEndDrag(offset(300)));
    act(() => current().onMomentumScrollEnd(offset(480)));
    expect(memory.offset).toBe(480);
    act(() => drawer.unmount());

    mount(memory);
    act(() => current().onLayout(layout(700)));
    // A closed drawer draws no tasks yet: too short to hold the place.
    act(() => current().onContentSizeChange(320, 300));
    expect(scrollTo).not.toHaveBeenCalled();
    act(() => current().onContentSizeChange(320, 1400));
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ animated: false, y: 480 });
    // More rows arriving later never move it again.
    act(() => current().onContentSizeChange(320, 1800));
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("lets the reader's own scrolling in the new view win over a place not yet restored", () => {
    const memory: ScrollMemory = { offset: 480 };
    mount(memory);
    act(() => current().onLayout(layout(700)));
    act(() => current().onScrollEndDrag(offset(40)));
    expect(memory.offset).toBe(40);
    act(() => current().onContentSizeChange(320, 1400));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("does nothing for a list that was at its top", () => {
    mount({ offset: 0 });
    act(() => current().onLayout(layout(700)));
    act(() => current().onContentSizeChange(320, 1400));
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
