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
const inherited = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
const readRegistry = async () =>
  parseWindowsRegistryEnvironment(
    await probeWindowsRegistryEnvironment({
      environment: inherited(),
      maximumOutputBytes: 8 * 1_024 * 1_024,
      reg,
      timeoutMs: 30_000,
      // A retried export or a directory left behind is printed for whoever reads the lane's log.
      log: (event, fields) => console.warn(JSON.stringify({ event, ...fields })),
    }),
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
      const registry = await readRegistry();
      expect(registry).toContainEqual({ kind: "ExpandString", name, scope: "user", value: raw });
      expect(
        registry.some((entry) => entry.scope === "machine" && /^path$/iu.test(entry.name)),
      ).toBe(true);
      const composed = composeWindowsEnvironment({
        inherited: inherited(),
        isDirectory: () => false,
        registry,
      });
      expect(composed[name]).toBe(`${process.env.USERPROFILE}\\Opensteer Zoë 工具\\bin`);
    } finally {
      execFileSync(reg, ["delete", "HKCU\\Environment", "/v", name, "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
    }
  });

  it("reads a REG_SZ whose name has a quote and an equals sign, with a non-ASCII value", async () => {
    const name = `OPENSTEER_TEST_${randomUUID().replaceAll("-", "")} "q"=x`;
    const raw = 'C:\\Zoë "工具"\\bin';
    execFileSync(reg, ["add", "HKCU\\Environment", "/v", name, "/t", "REG_SZ", "/d", raw, "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    try {
      expect(await readRegistry()).toContainEqual({
        kind: "String",
        name,
        scope: "user",
        value: raw,
      });
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
