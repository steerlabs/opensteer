import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { stagePasskeysAddon } from "./build-passkeys-addon.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => {
    throw new Error("toolchain invoked");
  }),
}));
let stageDirectory: string;
beforeEach(() => {
  stageDirectory = mkdtempSync(path.join(tmpdir(), "passkey-stage-test-"));
});
afterEach(() => {
  rmSync(stageDirectory, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

test("release without channel inputs does not invoke the addon toolchain", async () => {
  vi.stubEnv("OPENSTEER_DESKTOP_TARGET_OS", "darwin");
  vi.stubEnv("OPENSTEER_DESKTOP_RELEASE", "1");
  vi.stubEnv("OPENSTEER_DESKTOP_RELEASE_CHANNEL", "stable");
  vi.stubEnv("OPENSTEER_PASSKEYS_STABLE_PROFILE", "");
  vi.stubEnv("OPENSTEER_PASSKEYS_STABLE_ENTITLEMENTS", "");
  const staged = path.join(stageDirectory, "opensteer-passkeys.node");
  writeFileSync(staged, "stale");
  await expect(stagePasskeysAddon(stageDirectory)).resolves.toBeUndefined();
  expect(existsSync(staged)).toBe(false);
  expect(execFileSync).not.toHaveBeenCalled();
});

test("release with channel inputs invokes the pinned addon toolchain", async () => {
  vi.stubEnv("OPENSTEER_DESKTOP_TARGET_OS", "darwin");
  vi.stubEnv("OPENSTEER_DESKTOP_RELEASE", "1");
  vi.stubEnv("OPENSTEER_DESKTOP_RELEASE_CHANNEL", "stable");
  vi.stubEnv("OPENSTEER_PASSKEYS_STABLE_PROFILE", "/profile");
  vi.stubEnv("OPENSTEER_PASSKEYS_STABLE_ENTITLEMENTS", "/entitlements");
  await expect(stagePasskeysAddon(stageDirectory)).rejects.toThrow("toolchain invoked");
  expect(execFileSync).toHaveBeenCalled();
});

test("incomplete channel inputs fail closed before invoking the toolchain", async () => {
  vi.stubEnv("OPENSTEER_DESKTOP_TARGET_OS", "darwin");
  vi.stubEnv("OPENSTEER_DESKTOP_RELEASE", "1");
  vi.stubEnv("OPENSTEER_DESKTOP_RELEASE_CHANNEL", "stable");
  vi.stubEnv("OPENSTEER_PASSKEYS_STABLE_PROFILE", "/profile");
  vi.stubEnv("OPENSTEER_PASSKEYS_STABLE_ENTITLEMENTS", "");
  await expect(stagePasskeysAddon(stageDirectory)).rejects.toThrow(/profile and entitlement/i);
  expect(execFileSync).not.toHaveBeenCalled();
});
