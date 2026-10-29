import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { NativeSmokeArtifacts } from "./electron-native-browser-artifacts.js";

it("keeps successful oracle results truthful independently of the process result", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "journey-results-"));
  try {
    const artifacts = new NativeSmokeArtifacts(directory, new Set(["mount"]), true);
    artifacts.result("mount", "PASS", { measurements: { seconds: 1 }, evidence: [] });
    artifacts.finalizeCaseResults();
    artifacts.remaining("missing result");
    expect(JSON.parse(readFileSync(path.join(directory, "summary.json"), "utf8"))).toMatchObject({
      completed: 1,
      counts: { PASS: 1, FAIL: 0 },
      cases: [{ id: "mount", status: "PASS", measurements: { seconds: 1 } }],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
