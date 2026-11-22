import { describe, expect, it } from "vitest";
import { MAX_SCRIPT_BYTES } from "./fuses.js";
import { StoredTriggerProgramSchema, isExecutableTriggerProgram } from "./models.js";
import {
  AUTOMATION_SCRIPT_STUB_CONTRACT_VERSION,
  AutomationOutcomeSchema,
  AutomationPausedBySchema,
  AutomationScriptSchema,
  AutomationSecretNameSchema,
  AutomationSecretValueSchema,
  normalizeScriptText,
  scriptFileExtension,
  scriptProgramStub,
} from "./script.js";

describe("AutomationScriptSchema", () => {
  it("accepts a default-interpreter script and produces a non-v5 compatibility stub", () => {
    const parsed = AutomationScriptSchema.parse({ text: "console.log('hi');\n" });
    expect(parsed).toEqual({ interpreter: null, text: "console.log('hi');\n" });

    const stub = scriptProgramStub(parsed);
    expect(stub.toolContractVersion).toBe(AUTOMATION_SCRIPT_STUB_CONTRACT_VERSION);
    expect(stub.toolContractVersion).not.toBe(5);
    expect(StoredTriggerProgramSchema.parse(stub)).toEqual(stub);
    expect(isExecutableTriggerProgram(stub)).toBe(false);
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
    expect(AutomationPausedBySchema.options).toEqual(["person", "agent", "system"]);
  });
});

describe("AutomationSecretNameSchema", () => {
  it("accepts normal environment variable names and rejects reserved or hijack names", () => {
    expect(AutomationSecretNameSchema.safeParse("STRIPE_WEBHOOK_SECRET").success).toBe(true);
    expect(AutomationSecretNameSchema.safeParse("api_key_2").success).toBe(true);

    for (const bad of [
      "",
      "123_BAD",
      "BAD-NAME",
      "OPENSTEER_MCP_TOKEN",
      "opensteer_event",
      "PATH",
      "HOME",
      "SHELL",
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "DYLD_INSERT_LIBRARIES",
      "NODE_OPTIONS",
      "BASH_ENV",
      "PYTHONPATH",
      "IFS",
    ]) {
      expect(AutomationSecretNameSchema.safeParse(bad).success, bad).toBe(false);
    }

    expect(AutomationSecretValueSchema.safeParse("whsec_live_123").success).toBe(true);
    expect(AutomationSecretValueSchema.safeParse("bad\0val").success).toBe(false);
  });
});
