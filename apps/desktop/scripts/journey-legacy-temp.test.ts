import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it("creates both legacy fixture directories beneath the supplied owned root", () => {
  const root = mkdtempSync(path.join(tmpdir(), "legacy-roots-"));
  try {
    for (const file of [
      "native/computer-use/Tests/Fixtures/MacOwnerInputJourney/run-vm.sh",
      "scripts/test-computer-use-window-groups.sh",
    ]) {
      const source = readFileSync(path.join(import.meta.dirname, "..", file), "utf8");
      const command = source.split("\n").find((line) => line.trim().startsWith("work=$(mktemp -d"));
      expect(command).toBeDefined();
      const created = execFileSync("bash", ["-c", `${command}\nprintf '%s' "$work"`], {
        env: { ...process.env, OPENSTEER_LEGACY_TEMP_ROOT: root },
        encoding: "utf8",
      });
      expect(path.dirname(created)).toBe(root);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
