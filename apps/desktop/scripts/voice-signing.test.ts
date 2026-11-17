import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { expect, it, vi } from "vitest";
import { parse } from "yaml";

const require = createRequire(import.meta.url);
const { verifyElectronHelperEntitlements } = require("./after-sign.cjs") as {
  verifyElectronHelperEntitlements(
    app: string,
    read: (file: string) => Record<string, unknown>,
  ): void;
};
const reviewed = {
  "com.apple.security.cs.allow-jit": true,
  "com.apple.security.device.audio-input": true,
};

it("gates each Electron helper with the same narrow entitlement set", async () => {
  const app = await mkdtemp(path.join(tmpdir(), "voice-signing-"));
  try {
    const frameworks = path.join(app, "Contents", "Frameworks");
    await mkdir(frameworks, { recursive: true });
    for (const name of [
      "Opensteer Helper.app",
      "Opensteer Helper (Renderer).app",
      "Electron Framework.framework",
    ]) {
      await mkdir(path.join(frameworks, name));
    }
    const read = vi.fn(() => reviewed);
    verifyElectronHelperEntitlements(app, read);
    expect(read).toHaveBeenCalledTimes(2);
    expect(() =>
      verifyElectronHelperEntitlements(app, () => ({
        ...reviewed,
        "com.apple.security.device.camera": true,
      })),
    ).toThrow(/reviewed/);
    expect(() =>
      verifyElectronHelperEntitlements(app, () => ({ "com.apple.security.cs.allow-jit": true })),
    ).toThrow(/reviewed/);
  } finally {
    await rm(app, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== "darwin")(
  "ships exactly the reviewed main and inherited entitlements and microphone purpose",
  async () => {
    for (const filename of ["entitlements.mac.plist", "entitlements.mac.inherit.plist"]) {
      const file = new URL(`../build/${filename}`, import.meta.url);
      const contents = await readFile(file);
      const parsed: unknown = JSON.parse(
        execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], {
          input: contents,
          encoding: "utf8",
        }),
      );
      expect(parsed).toEqual(reviewed);
    }
    const config = parse(
      await readFile(new URL("../electron-builder.base.yml", import.meta.url), "utf8"),
    ) as { mac: { extendInfo: Record<string, unknown> } };
    expect(config.mac.extendInfo.NSMicrophoneUsageDescription).toBe(
      "Opensteer uses the microphone while you talk to it by voice.",
    );
  },
);

it("accepts only workerd's JIT entitlement", () => {
  const { verifyWorkerdEntitlements } = require("./after-sign.cjs") as {
    verifyWorkerdEntitlements(file: string, read: () => Record<string, unknown>): void;
  };
  verifyWorkerdEntitlements("/workerd", () => ({ "com.apple.security.cs.allow-jit": true }));
  for (const extra of [{}, { "com.apple.security.cs.allow-jit": false }, reviewed])
    expect(() => verifyWorkerdEntitlements("/workerd", () => extra)).toThrow(/only the JIT/);
  expect(sourceKeys("entitlements.mac.workerd.plist")).toEqual(["com.apple.security.cs.allow-jit"]);
});
function sourceKeys(file: string) {
  return [
    ...readFileSync(path.resolve(import.meta.dirname, "../build", file), "utf8").matchAll(
      /<key>([^<]+)<\/key>/gu,
    ),
  ].map((match) => match[1]);
}
