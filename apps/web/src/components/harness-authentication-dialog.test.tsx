import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HarnessAuthenticationView } from "@opensteer/client/host";
import { HarnessAuthenticationBody } from "./harness-authentication-dialog.js";

function render(view: HarnessAuthenticationView | null, error: string | null = null): string {
  return renderToStaticMarkup(<HarnessAuthenticationBody error={error} view={view} />);
}

describe("HarnessAuthenticationBody", () => {
  it("renders secret setup as a password field without browser or code instructions", () => {
    const html = render({
      codeReplaced: false,
      inputKind: "secret",
      inputPrompt: "OpenRouter API key",
      kind: "pending",
      userCode: "",
    });
    expect(html).toContain('type="password"');
    expect(html).toContain("OpenRouter API key");
    expect(html).toContain("Save credential");
    expect(html).not.toContain("one-time code");
    expect(html).not.toContain("Continue in browser");
  });
});
