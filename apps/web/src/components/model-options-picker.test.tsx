// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { HarnessModelDescriptorSchema } from "@opensteer/protocol";
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
    const slider = node.querySelector("input")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(slider, "1");
      slider.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith({ effort: "high" });
    render({ effort: "high" });
    act(() => node.querySelector<HTMLButtonElement>("[aria-pressed]")!.click());
    expect(onChange).toHaveBeenLastCalledWith({});
    act(() => node.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    expect(onChange).toHaveBeenLastCalledWith({ effort: "high", fast: true });
  } finally {
    act(() => root.unmount());
  }
});
