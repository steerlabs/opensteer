// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MessageList } from "./message-list.js";
import type { MessageView, TimelineItem } from "./team-models.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const message = (id: number): TimelineItem => ({
  kind: "message",
  message: {
    id: String(id),
    author: {
      kind: "person",
      person: { id: "usr_maya", name: "Maya Chen", handle: "maya", tint: "#c97a5c" },
    },
    at: new Date(Date.UTC(2026, 10, 11, 9, id)).toISOString(),
    body: `Message ${id}`,
    mentions: [],
    files: [],
  } satisfies MessageView,
});

/** The timeline scrolls a 400px window of `content`, clamped as a browser clamps it. */
function timelineGeometry(geometry: { content: number }) {
  const tops = new WeakMap<Element, number>();
  const scrolls = (element: Element) => element.classList.contains("tlist__scroller");
  const max = () => geometry.content - 400;
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return scrolls(this) ? 400 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return scrolls(this) ? geometry.content : 0;
  });
  vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(function (this: Element) {
    return Math.min(tops.get(this) ?? 0, max());
  });
  vi.spyOn(Element.prototype, "scrollTop", "set").mockImplementation(function (
    this: Element,
    top: number,
  ) {
    tops.set(this, Math.max(0, Math.min(top, max())));
  });
  // Message n stands 200n down the timeline, under the scroller's top at 0.
  const real = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ) {
    const id = this.getAttribute("data-row-id");
    const scroller = this.closest(".tlist__scroller");
    if (id === null || !scroller) return real.call(this);
    return new DOMRect(0, Number(id) * 200 - scroller.scrollTop, 300, 200);
  });
}

it("follows new messages at the end, and never pulls back a reader who scrolled up near it", () => {
  const geometry = { content: 2000 };
  timelineGeometry(geometry);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const list = (count: number) => (
    <MessageList
      firstUnreadId={null}
      hasOlder={false}
      items={Array.from({ length: count }, (_, index) => message(index))}
      label="support"
    />
  );
  act(() => root!.render(list(8)));
  const scroller = container.querySelector<HTMLElement>(".tlist__scroller")!;
  expect(scroller.scrollTop, "The timeline did not open at its end").toBe(1600);

  geometry.content = 2100;
  act(() => root!.render(list(9)));
  expect(scroller.scrollTop, "A reader at the end was not kept there").toBe(1700);

  act(() => {
    scroller.scrollTop = 1670;
    scroller.dispatchEvent(new Event("scroll"));
  });
  geometry.content = 2200;
  act(() => root!.render(list(10)));
  expect(scroller.scrollTop, "A reader 30px up was pulled back to the end").toBe(1670);

  // Back at the end; a scroll up whose event has not landed when the next message renders.
  act(() => {
    scroller.scrollTop = 1800;
    scroller.dispatchEvent(new Event("scroll"));
  });
  geometry.content = 2300;
  act(() => root!.render(list(11)));
  expect(scroller.scrollTop).toBe(1900);
  scroller.scrollTop = 1850;
  geometry.content = 2400;
  act(() => root!.render(list(12)));
  expect(scroller.scrollTop, "A scroll up not yet read was undone").toBe(1850);
});
