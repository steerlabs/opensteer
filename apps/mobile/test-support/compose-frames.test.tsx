// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import {
  composeFrames,
  composeLayout,
  composeLayoutModifiers,
  intersects,
} from "./compose-frames.js";

/*
 * The Compose model's rules held to the sources it names (`compose-frames.tsx`): a Host overlays
 * its children, a Button's content is a row, and a FlowRow takes another line where it runs out.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { Box, Button, FlowRow, Host, Text } = composeLayout;
const { size } = composeLayoutModifiers;

async function laid(tree: React.ReactNode, width = 320) {
  const element = document.createElement("div");
  const root = createRoot(element);
  await act(async () => root.render(tree));
  const frames = composeFrames(element, { fontScale: 1, width });
  // Read while drawn: the frames of the sized boxes and of the texts, in order.
  const read = (selector: string) =>
    [...element.querySelectorAll(selector)].map((found) => frames.get(found)!);
  const laidOut = { sized: read("[data-size]"), texts: read('[data-compose="Text"]') };
  act(() => root.unmount());
  return laidOut;
}

describe("the Compose model", () => {
  it("puts a Host's children over one another (HostView.kt:312-316)", async () => {
    const at = await laid(
      <Host>
        <Box modifiers={[size(40, 40)]} />
        <Box modifiers={[size(60, 20)]} />
      </Host>,
    );
    const [first, second] = at.sized;
    expect(intersects(first!, second!)).toBe(true);
    expect({ x: second!.x, y: second!.y }).toEqual({ x: first!.x, y: first!.y });
  });

  it("lines a Button's content up in a row (button/Button.kt:86, :174)", async () => {
    const at = await laid(
      <Button>
        <Box modifiers={[size(24, 24)]} />
        <Text>Save</Text>
      </Button>,
    );
    const [icon] = at.sized;
    const [label] = at.texts;
    expect(intersects(icon!, label!)).toBe(false);
    expect(label!.x).toBeGreaterThanOrEqual(icon!.x + icon!.width);
  });

  it("spaces a FlowRow's children and its lines each by its own arrangement (ComposeViews.kt:96-97)", async () => {
    const at = await laid(
      <FlowRow horizontalArrangement={{ spacedBy: 8 }} verticalArrangement={{ spacedBy: 20 }}>
        <Box modifiers={[size(100, 30)]} />
        <Box modifiers={[size(100, 30)]} />
        <Box modifiers={[size(200, 30)]} />
      </FlowRow>,
    );
    const [first, second, third] = at.sized;
    expect(second!.x - (first!.x + first!.width)).toBe(8);
    expect(third!.y - (first!.y + first!.height)).toBe(20);
  });

  it("takes another line in a FlowRow where the next child does not fit (ComposeViews.kt:95)", async () => {
    const at = await laid(
      <FlowRow>
        <Box modifiers={[size(200, 30)]} />
        <Box modifiers={[size(200, 30)]} />
      </FlowRow>,
    );
    const [first, second] = at.sized;
    expect(second!.x).toBe(first!.x);
    expect(second!.y).toBeGreaterThanOrEqual(first!.y + first!.height);
  });
});
