import { describe, expect, it } from "vitest";
import { commandInputSchemas } from "./commands.js";

describe("a command's input schema (AD8)", () => {
  it("never shows a value only the person types, nested ones included", () => {
    for (const [type, secret] of [
      ["plugin.oauthApp.save", "clientSecret"],
      ["plugin.authorization.begin", "clientSecret"],
      ["plugins.webhook.setup.complete", "secret"],
    ] as const) {
      const text = JSON.stringify(commandInputSchemas(type));
      expect(text, type).not.toContain(`"${secret}"`);
      expect(text, type).not.toContain("idempotencyKey");
    }
  });
});
