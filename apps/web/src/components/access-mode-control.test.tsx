import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AccessModePanel } from "./access-mode-control.js";

describe("AccessModeControl", () => {
  it("disables a mode the engine cannot enforce and says which engine that is", () => {
    const html = renderToStaticMarkup(
      <AccessModePanel
        engine={{ accessModes: ["approval-required", "full-access"], engineName: "Codex" }}
        mode="approval-required"
        onSelect={vi.fn()}
      />,
    );

    // Two of the four are refused, and each says so where its description was.
    expect(html.match(/aria-disabled="true"/gu)).toHaveLength(2);
    expect(html.match(/Codex cannot enforce this mode/gu)).toHaveLength(2);
    expect(html).not.toContain("Auto-approve edits, ask before other actions.");
  });

  it("rules nothing out while the engine has not declared its modes", () => {
    const html = renderToStaticMarkup(
      <AccessModePanel
        engine={{ accessModes: null, engineName: "Codex" }}
        mode="auto"
        onSelect={vi.fn()}
      />,
    );

    expect(html).not.toContain('aria-disabled="true"');
    expect(html).not.toContain("cannot enforce this mode");
  });
});
