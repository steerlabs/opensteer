import { describe, expect, it } from "vitest";
import { MAX_SCRIPT_BYTES } from "./bounds.js";
import {
  AutomationOutcomeSchema,
  AutomationPausedBySchema,
  AutomationScriptSchema,
  AutomationSecretMapSchema,
  AutomationSecretNameSchema,
  AutomationSecretValueSchema,
  normalizeScriptText,
  scriptFileExtension,
} from "./script.js";

describe("AutomationScriptSchema", () => {
  it("accepts a default-interpreter script", () => {
    const parsed = AutomationScriptSchema.parse({ text: "console.log('hi');\n" });
    expect(parsed).toEqual({ interpreter: null, text: "console.log('hi');\n" });
  });

  it("accepts custom interpreter argv and rejects empty, overlong, or NUL-bearing values", () => {
    const parsed = AutomationScriptSchema.parse({
      interpreter: ["/usr/bin/env", "python3", "-u"],
      text: "print('ok')\n",
    });
    expect(parsed.interpreter).toEqual(["/usr/bin/env", "python3", "-u"]);

    expect(AutomationScriptSchema.safeParse({ text: "" }).success).toBe(false);
    expect(
      AutomationScriptSchema.safeParse({ text: "x".repeat(MAX_SCRIPT_BYTES + 1) }).success,
    ).toBe(false);
    // Multi-byte UTF-8 characters count by byte length, not code units.
    expect(
      AutomationScriptSchema.safeParse({ text: "é".repeat(MAX_SCRIPT_BYTES / 2 + 1) }).success,
    ).toBe(false);
    expect(AutomationScriptSchema.safeParse({ interpreter: [], text: "ok" }).success).toBe(false);
    expect(AutomationScriptSchema.safeParse({ interpreter: ["bash\0"], text: "ok" }).success).toBe(
      false,
    );
    // Z11: interpreter[0] must be a bare command name or an absolute path, never relative.
    for (const allowed of [
      ["python3", "-u"],
      ["/usr/bin/env", "python3"],
      ["/bin/sh"],
      ["C:\\Python312\\python.exe"],
    ]) {
      expect(
        AutomationScriptSchema.safeParse({ interpreter: allowed, text: "ok" }).success,
        JSON.stringify(allowed),
      ).toBe(true);
    }
    for (const relative of [
      ["./python"],
      ["../bin/python"],
      ["venv/bin/python"],
      [".\\python.exe"],
      ["venv\\Scripts\\python.exe"],
      ["C:python.exe"],
      ["."],
      [".."],
    ]) {
      expect(
        AutomationScriptSchema.safeParse({ interpreter: relative, text: "ok" }).success,
        JSON.stringify(relative),
      ).toBe(false);
    }
  });

  it("normalizes CRLF/CR to LF on POSIX while leaving Windows text untouched", () => {
    expect(normalizeScriptText("echo a\r\necho b\recho c\n", "darwin")).toBe(
      "echo a\necho b\necho c\n",
    );
    expect(normalizeScriptText("echo a\r\necho b\n", "linux")).toBe("echo a\necho b\n");
    expect(normalizeScriptText("echo a\r\necho b\n", "win32")).toBe("echo a\r\necho b\n");
  });

  it("infers script file extensions from interpreter argv", () => {
    expect(scriptFileExtension(null)).toBe(".mjs");
    expect(scriptFileExtension(["node"])).toBe(".mjs");
    expect(scriptFileExtension(["/usr/bin/env", "python3", "-u"])).toBe(".py");
    expect(scriptFileExtension(["/bin/bash", "-euo", "pipefail"])).toBe(".sh");
    expect(scriptFileExtension(["pwsh", "-NoProfile", "-File"])).toBe(".ps1");
    expect(scriptFileExtension(["ruby"])).toBe(".rb");
    expect(scriptFileExtension(["/usr/local/bin/custom-runner"])).toBe(".txt");
  });

  it("validates outcome and pausedBy enums", () => {
    expect(AutomationOutcomeSchema.options).toEqual([
      "pending",
      "running",
      "succeeded",
      "failed",
      "canceled",
      "unknown",
    ]);
    expect(AutomationPausedBySchema.options).toEqual(["person", "agent", "connection", "system"]);
  });
});

describe("AutomationSecretNameSchema (Z10)", () => {
  it("accepts letters, digits, and underscores and exposes them solely under OPENSTEER_SECRET_", () => {
    expect(AutomationSecretNameSchema.safeParse("STRIPE_WEBHOOK_SECRET").success).toBe(true);
    expect(AutomationSecretNameSchema.safeParse("api_key_2").success).toBe(true);
    // Because every sealed value is prefixed with OPENSTEER_SECRET_, names like PATH,
    // ZDOTDIR, LD_PRELOAD, or HTTP_PROXY cannot shadow OS/interpreter variables.
    for (const safe of ["PATH", "ZDOTDIR", "LD_PRELOAD", "HTTP_PROXY", "NODE_USE_ENV_PROXY"]) {
      expect(AutomationSecretNameSchema.safeParse(safe).success, safe).toBe(true);
    }

    for (const bad of [
      "",
      "123_BAD",
      "BAD-NAME",
      "BAD.NAME",
      "A".repeat(65),
      "__proto__",
      "constructor",
      "prototype",
    ]) {
      expect(AutomationSecretNameSchema.safeParse(bad).success, bad).toBe(false);
    }

    expect(AutomationSecretValueSchema.safeParse("whsec_live_123").success).toBe(true);
    const nul = AutomationSecretValueSchema.safeParse("bad\0val");
    expect(nul.success).toBe(false);
    if (!nul.success) {
      expect(
        (nul.error.issues[0] as { params?: { reason?: string } } | undefined)?.params?.reason,
      ).toBe("automation-secret-invalid-value");
    }
    const oversized = AutomationSecretValueSchema.safeParse("x".repeat(65_537));
    expect(oversized.success).toBe(false);
    if (!oversized.success) {
      expect(
        (oversized.error.issues[0] as { params?: { reason?: string } } | undefined)?.params?.reason,
      ).toBe("automation-secret-invalid-value");
    }

    const protoParsed = AutomationSecretMapSchema.safeParse(JSON.parse('{"__proto__":"secret"}'));
    expect(protoParsed.success).toBe(false);
    if (!protoParsed.success) {
      expect(protoParsed.error.issues[0]).toMatchObject({
        code: "custom",
        path: ["__proto__"],
        params: { reason: "automation-secret-invalid-name" },
      });
    }
  });
});
