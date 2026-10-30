import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it("lifecycle hooks preserve a reviewed supervisor even in contributor mode", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "reviewed-supervisor-"));
  try {
    const file = path.join(directory, "supervisor");
    const bytes = "reviewed fixture, no executable";
    writeFileSync(file, bytes);
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "apps/desktop/scripts/build-process-supervisor.ts"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: directory,
          OPENSTEER_DESKTOP_RELEASE: "0",
          OPENSTEER_PROCESS_SUPERVISOR_BINARY_SOURCE: file,
          OPENSTEER_PROCESS_SUPERVISOR_BINARY_SHA256: createHash("sha256")
            .update(bytes)
            .digest("hex"),
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("reviewed release input");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
