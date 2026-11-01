// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { HarnessModelDescriptorSchema, type HarnessModelDescriptor } from "@opensteer/protocol";
import { ModelSettingsPanel } from "./model-options-picker.js";
const model = HarnessModelDescriptorSchema.parse({
  displayName: "Model",
  modelId: "model",
  providerId: "openai",
  isDefault: true,
  options: [
    {
      type: "select",
      id: "effort",
      label: "Reasoning",
      defaultValue: "auto",
      values: [
        { value: "auto", label: "Default" },
        { value: "low", label: "Low" },
        { value: "high", label: "High" },
      ],
    },
    { type: "toggle", id: "fast", label: "Fast", defaultValue: false },
  ],
});
it("applies ladder steps, returns to automatic, and flips the switch", () => {
  const node = document.createElement("div");
  const root = createRoot(node);
  const onChange = vi.fn();
  const render = (values: Record<string, string | boolean>) =>
    act(() =>
      root.render(
        <ModelSettingsPanel
          model={model}
          values={values}
          onChange={onChange}
          choice={null}
          onChoice={() => {}}
        />,
      ),
    );
  try {
    render({});
    const slider = node.querySelector<HTMLInputElement>('input[aria-label="Reasoning"]')!;
    const move = (value: string, event: "input" | "change") =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          slider,
          value,
        );
        slider.dispatchEvent(new Event(event, { bubbles: true }));
      });
    // Dragging previews every step it crosses and applies only where it settles.
    move("0", "input");
    move("1", "input");
    expect(slider.getAttribute("aria-valuetext")).toBe("High");
    expect(onChange).not.toHaveBeenCalled();
    move("1", "change");
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ effort: "high" });
    render({ effort: "high" });
    act(() => node.querySelector<HTMLButtonElement>("[aria-pressed]")!.click());
    expect(onChange).toHaveBeenLastCalledWith({});
    // A change made while the one before it is on its way builds on it,
    // rather than undoing it.
    act(() => node.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    expect(onChange).toHaveBeenLastCalledWith({ fast: true });
  } finally {
    act(() => root.unmount());
  }
});

it("shows a change at once and reverts to the values when the change does not apply", async () => {
  const node = document.createElement("div");
  const root = createRoot(node);
  let settle = () => {};
  const onChange = vi.fn(() => new Promise<void>((resolve) => (settle = resolve)));
  act(() =>
    root.render(
      <ModelSettingsPanel
        model={model}
        values={{}}
        onChange={onChange}
        choice={null}
        onChoice={() => {}}
      />,
    ),
  );
  try {
    const fast = () => node.querySelector<HTMLButtonElement>('[role="switch"]')!;
    act(() => fast().click());
    // A slow link must not leave the switch where it was until the Host answers.
    expect(fast().getAttribute("aria-checked")).toBe("true");
    // The values never changed, so the change did not apply: the switch says so.
    await act(async () => settle());
    expect(fast().getAttribute("aria-checked")).toBe("false");
  } finally {
    act(() => root.unmount());
  }
});

it("drops a step under the pointer when the ladder it was on is replaced", () => {
  const node = document.createElement("div");
  const root = createRoot(node);
  const ladder = (values: { value: string; label: string }[]) =>
    HarnessModelDescriptorSchema.parse({
      displayName: "Model",
      modelId: "model",
      providerId: "openai",
      isDefault: true,
      options: [{ type: "select", id: "effort", label: "Reasoning", defaultValue: "low", values }],
    });
  const render = (descriptor: HarnessModelDescriptor) =>
    act(() =>
      root.render(
        <ModelSettingsPanel
          model={descriptor}
          values={{}}
          onChange={vi.fn()}
          choice={null}
          onChoice={() => {}}
        />,
      ),
    );
  try {
    render(
      ladder([
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
      ]),
    );
    const slider = () => node.querySelector<HTMLInputElement>('input[aria-label="Reasoning"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        slider(),
        "2",
      );
      slider().dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(slider().getAttribute("aria-valuetext")).toBe("High");
    // Another device moves this conversation to a model with fewer levels
    // while the pointer is still down on the third.
    render(
      ladder([
        { value: "low", label: "Low" },
        { value: "max", label: "Max" },
      ]),
    );
    expect(slider().getAttribute("aria-valuetext")).toBe("Low");
  } finally {
    act(() => root.unmount());
  }
});
