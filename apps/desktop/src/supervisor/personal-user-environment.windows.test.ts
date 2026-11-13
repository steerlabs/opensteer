import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  NativePersonalUserEnvironment,
  composeWindowsEnvironment,
  parseWindowsRegistryEnvironment,
  probeWindowsRegistryEnvironment,
} from "./personal-user-environment.js";

const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
const reg = path.win32.join(systemRoot, "System32", "reg.exe");
const powershell = path.win32.join(
  systemRoot,
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

describe("Windows registry environment", () => {
  it("reads, expands and decodes a REG_EXPAND_SZ user value with a non-ASCII segment", async () => {
    const name = `OPENSTEER_TEST_${randomUUID().replaceAll("-", "")}`;
    const raw = "%USERPROFILE%\\Opensteer Zoë 工具\\bin";
    execFileSync(
      reg,
      ["add", "HKCU\\Environment", "/v", name, "/t", "REG_EXPAND_SZ", "/d", raw, "/f"],
      {
        stdio: "ignore",
        windowsHide: true,
      },
    );
    try {
      const inherited = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      const registry = parseWindowsRegistryEnvironment(
        await probeWindowsRegistryEnvironment({
          environment: inherited,
          maximumOutputBytes: 1_024 * 1_024,
          powershell,
          timeoutMs: 5_000,
        }),
      );
      expect(registry).toContainEqual({ kind: "ExpandString", name, scope: "user", value: raw });
      expect(
        registry.some((entry) => entry.scope === "machine" && /^path$/iu.test(entry.name)),
      ).toBe(true);
      const composed = composeWindowsEnvironment({ inherited, isDirectory: () => false, registry });
      expect(composed[name]).toBe(`${process.env.USERPROFILE}\\Opensteer Zoë 工具\\bin`);
    } finally {
      execFileSync(reg, ["delete", "HKCU\\Environment", "/v", name, "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
    }
  });

  it("resolves the account environment from the registry without the fallback", async () => {
    const log = vi.fn();
    const environment = await new NativePersonalUserEnvironment({
      log,
      timeoutMs: 5_000,
    }).resolve();
    expect(log).not.toHaveBeenCalled();
    expect(environment.PATH?.toLowerCase()).toContain(
      path.win32.join(systemRoot, "System32").toLowerCase(),
    );
    expect(environment.SystemRoot).toBe(systemRoot);
  });
});
