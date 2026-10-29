import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { mergeLockGraphs } from "../scripts/ci-lock-merge.js";
it("checks cross-shard cycles and rejects missing/corrupt evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "lock-merge-"));
  const files = [join(root, "1.json"), join(root, "2.json")];
  const edge = (from: string, to: string) => ({
    type: "edge",
    database: "fixture",
    from,
    to,
    heldMode: "UPDATE",
    requestedMode: "UPDATE",
    heldKey: "1",
    requestedKey: "2",
    statement: "fixture",
    previous: "fixture",
    stack: "fixture",
    previousStack: "fixture",
  });
  try {
    const write = (i: number, edges: unknown[]) =>
      writeFileSync(
        files[i]!,
        JSON.stringify({ mode: "enforce", errors: [], violations: 0, edges }),
      );
    write(0, [edge("a", "b")]);
    write(1, []);
    expect(() => mergeLockGraphs(files)).not.toThrow();
    write(1, [edge("b", "a")]);
    expect(() => mergeLockGraphs(files)).toThrow(/cycle/);
    writeFileSync(files[1]!, "{}");
    expect(() => mergeLockGraphs(files)).toThrow();
    rmSync(files[1]!);
    expect(() => mergeLockGraphs(files)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
