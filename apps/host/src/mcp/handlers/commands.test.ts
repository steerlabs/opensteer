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

  it("shows a folder install to your own agents only: a connection holds no folder", () => {
    const own = JSON.stringify(commandInputSchemas("plugins.install"));
    const underConnection = JSON.stringify(commandInputSchemas("plugins.install", true));
    expect(own).toContain('"folder"');
    expect(underConnection).not.toContain('"folder"');
    expect(underConnection).not.toContain('"directory"');
    expect(underConnection).toContain('"catalog"');
  });

  it("shows trigger.secrets.set's set map only when the caller can run it now", () => {
    const asking = JSON.stringify(commandInputSchemas("trigger.secrets.set", false, false));
    const runnable = JSON.stringify(commandInputSchemas("trigger.secrets.set", false, true));
    expect(asking).not.toContain('"set"');
    expect(asking).toContain('"remove"');
    expect(runnable).toContain('"set"');
    expect(runnable).toContain('"remove"');
  });
});
