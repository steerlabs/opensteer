import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it.each([
  { name: "preserves reviewed bytes without Go", changes: {}, succeeds: true },
  {
    name: "refuses changed reviewed bytes",
    changes: { OPENSTEER_IPHONE_BRIDGE_BINARY_SHA256: "a".repeat(64) },
    succeeds: false,
  },
  {
    name: "refuses a release without reviewed input",
    changes: { OPENSTEER_DESKTOP_RELEASE: "1", OPENSTEER_IPHONE_BRIDGE_BINARY_SOURCE: undefined },
    succeeds: false,
  },
  {
    name: "skips non-Mac packaging without requiring an input",
    changes: {
      OPENSTEER_DESKTOP_TARGET_OS: "linux",
      OPENSTEER_DESKTOP_RELEASE: "1",
      OPENSTEER_IPHONE_BRIDGE_BINARY_SOURCE: undefined,
    },
    succeeds: true,
  },
])("$name", ({ changes, succeeds }) => {
  const directory = mkdtempSync(path.join(tmpdir(), "reviewed-iphone-"));
  try {
    const file = path.join(directory, "bridge");
    const bytes = "reviewed fixture";
    writeFileSync(file, bytes);
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", path.resolve(import.meta.dirname, "build-iphone-bridge.ts")],
      {
        encoding: "utf8",
        timeout: 3000,
        env: {
          ...process.env,
          PATH: directory,
          OPENSTEER_DESKTOP_TARGET_OS: "darwin",
          OPENSTEER_DESKTOP_TARGET_ARCH: "aarch64",
          OPENSTEER_DESKTOP_RELEASE: "0",
          OPENSTEER_IPHONE_BRIDGE_BINARY_SOURCE: file,
          OPENSTEER_IPHONE_BRIDGE_BINARY_SHA256: createHash("sha256").update(bytes).digest("hex"),
          ...changes,
        },
      },
    );
    expect(result.error).toBeUndefined();
    if (succeeds) expect(result.status, result.stderr).toBe(0);
    else expect(result.status, result.stderr).not.toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
