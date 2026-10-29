// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { HarnessModelDescriptorSchema } from "@opensteer/protocol";
import { ModelOptionsPanel, optionsSummary } from "./model-options-picker.js";

const model = HarnessModelDescriptorSchema.parse({
  displayName: "GPT-5.6-Sol",
  isDefault: true,
  modelId: "gpt-5.6-sol",
  providerId: "openai",
  options: [
    {
      defaultValue: "medium",
      id: "effort",
      label: "Reasoning",
      type: "select",
      values: [
        { label: "Low", value: "low" },
        { label: "Medium", value: "medium" },
        { description: "Thinks longer before answering", label: "High", value: "high" },
      ],
    },
    { defaultValue: false, id: "web", label: "Web search", type: "toggle" },
  ],
});

describe("optionsSummary", () => {
  it("summarizes the current select labels and enabled toggles", () => {
    expect(optionsSummary(model, {})).toBe("Medium");
    expect(optionsSummary(model, { effort: "high", web: true })).toBe("High · Web search");
    // Stored values must not be misrepresented as the new catalog default.
    expect(optionsSummary(model, { effort: "xhigh" })).toBe("Saved configuration");
  });
});

describe("ModelOptionsPanel", () => {
  it("does not mark a new default as the saved legacy configuration", () => {
    const sparse = {
      ...model,
      options: [
        {
          type: "select" as const,
          id: "variant",
          label: "Configuration",
          defaultValue: "native-low",
          values: [{ label: "Low", value: "native-low" }],
        },
      ],
    };
    const onChange = vi.fn();
    const html = renderToStaticMarkup(
      <ModelOptionsPanel
        model={sparse}
        onChange={onChange}
        values={{ effort: "high", fast: true }}
      />,
    );
    expect(html).toContain("Choose a configuration");
    expect(html).not.toContain('aria-checked="true"');
    expect(optionsSummary(sparse, { effort: "high", fast: true })).toBe("Saved configuration");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("cleans saved legacy keys only when a sparse variant is deliberately chosen", () => {
    const sparse = HarnessModelDescriptorSchema.parse({
      ...model,
      options: [
        {
          type: "select",
          id: "variant",
          label: "Configuration",
          defaultValue: "native-low",
          values: [
            { label: "Low", value: "native-low" },
            { label: "High + Fast", value: "native-high-fast" },
          ],
        },
      ],
    });
    const onChange = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <ModelOptionsPanel
          model={sparse}
          onChange={onChange}
          values={{ effort: "high", fast: true, removed: "legacy" }}
        />,
      );
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-checked="true"]')).toBeNull();
    expect(container.textContent).toContain("Choose a configuration");

    const highFast = [
      ...container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
    ].find((button) => button.textContent?.includes("High + Fast"));
    expect(highFast).toBeDefined();
    act(() => highFast!.click());

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith({ variant: "native-high-fast" }, true);

    act(() => root.unmount());
    container.remove();
  });
});
