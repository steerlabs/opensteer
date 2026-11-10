// @vitest-environment happy-dom

import { act, useContext, useLayoutEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TextLayoutEvent } from "react-native";
import { afterEach, expect, it, vi } from "vitest";
import { TextLines } from "../markdown/text-lines.js";

const harness = vi.hoisted(() => ({ pane: 1000 }));

vi.mock("react-native", () => ({
  StyleSheet: { create: <T,>(styles: T) => styles },
  View: (props: { readonly children?: ReactNode; readonly style?: unknown }) => (
    <div data-style={JSON.stringify(flatten(props.style))}>{props.children}</div>
  ),
  // The window never changes: Chat alone and Chat beside a page share it.
  useWindowDimensions: () => ({ fontScale: 1, height: 700, width: 1000 }),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaFrame: () => ({ height: 700, width: harness.pane, x: 0, y: 0 }),
}));
vi.mock("../theme.js", () => ({ color: { background: "#000" } }));
vi.mock("../ui/pane.js", () => ({
  useContentInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
vi.mock("../ui/screen.js", () => ({ useGutter: () => 16 }));

function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return typeof style === "object" && style !== null ? (style as Record<string, unknown>) : {};
}

const { Bubble } = await import("./bubble.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

/** The words' text, reporting its longest line as React Native does after layout. */
function Words(props: { readonly longest: number }): ReactNode {
  const report = useContext(TextLines);
  useLayoutEffect(() => {
    report?.({ nativeEvent: { lines: [{ width: props.longest }] } } as unknown as TextLayoutEvent);
  });
  return null;
}

async function bubbleWidth(longest: number): Promise<unknown> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <Bubble fill="#333" fit="Same words in both places" side="theirs" tail={false}>
        <Words longest={longest} />
      </Bubble>,
    ),
  );
  return JSON.parse(container.querySelector("div")?.dataset["style"] ?? "{}").width;
}

it("sizes the same words again in a narrower pane, instead of overflowing it", async () => {
  // Chat alone: a 300-point longest line, plus the bubble's padding.
  expect(await bubbleWidth(300)).toBe(329);
  // Beside a page the column is narrower, so the same words wrap shorter.
  harness.pane = 454;
  expect(await bubbleWidth(200)).toBe(229);
});
