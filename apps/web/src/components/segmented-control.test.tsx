// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SegmentedControl } from "./segmented-control.js";

const mountedRoots: Root[] = [];
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  for (const root of mountedRoots.splice(0)) act(() => root.unmount());
});

describe("SegmentedControl", () => {
  it("moves the choice with the arrow keys, wrapping at either end", async () => {
    const onChange = vi.fn();
    const { container } = await mount({ onChange, value: "read" });
    const group = container.querySelector('[role="radiogroup"]')!;

    await press(group, "ArrowRight");
    expect(onChange).toHaveBeenLastCalledWith("read-write");
    await press(group, "ArrowLeft");
    // Wrapping backwards from the first option lands on the last.
    expect(onChange).toHaveBeenLastCalledWith("read-write");
    await press(group, "ArrowDown");
    expect(onChange).toHaveBeenLastCalledWith("read-write");
  });

  /**
   * A control that goes busy the moment it is used must not take the keyboard
   * focus away with it, so it is aria-disabled rather than disabled.
   */
  it("keeps its focus while a change is saving", async () => {
    const onChange = vi.fn();
    const { container } = await mount({ disabled: true, onChange, value: "read" });
    const options = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')];

    expect(options.map((option) => option.getAttribute("aria-disabled"))).toEqual(["true", "true"]);
    expect(options.some((option) => option.disabled)).toBe(false);
    await act(async () => options[1]!.click());
    expect(onChange).not.toHaveBeenCalled();
  });
});

async function press(element: Element, key: string): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
  });
}

async function mount(input: {
  readonly disabled?: boolean;
  readonly onChange?: (value: "read" | "read-write") => void;
  readonly value: "read" | "read-write";
}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(
      <SegmentedControl
        ariaLabel="Access for Messages"
        disabled={input.disabled ?? false}
        onChange={input.onChange ?? (() => undefined)}
        options={[
          { label: "Read only", value: "read" },
          { label: "Read and send", value: "read-write" },
        ]}
        value={input.value}
      />,
    );
  });
  return { container };
}
