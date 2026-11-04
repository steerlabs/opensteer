import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseCases } from "./cases.js";
import { caseChain, copyWorkspace } from "./chains.js";

it("copies actual output to the cold workspace, excludes harness state, and rejects symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "eval-chain-"));
  try {
    const a = join(root, "a"),
      b = join(root, "b");
    await mkdir(a);
    await writeFile(join(a, "answer.txt"), "corrected value");
    await writeFile(join(a, ".eval-state"), "private");
    await copyWorkspace(a, b);
    expect(await readFile(join(b, "answer.txt"), "utf8")).toBe("corrected value");
    await expect(readFile(join(b, ".eval-state"))).rejects.toMatchObject({ code: "ENOENT" });
    await symlink(join(a, "answer.txt"), join(a, "alias"));
    await expect(copyWorkspace(a, b)).rejects.toThrow("symlink");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("resolves the real memory chains and rejects missing or forward dependencies", async () => {
  const cases = parseCases(
    await readFile(new URL("./cases/memory.ndjson", import.meta.url), "utf8"),
  );
  expect(
    caseChain(
      cases.find((c) => c.id === "memory-reenable-after-erasure")!,
      cases,
    ).map((c) => c.id),
  ).toEqual([
    "memory-stop-while-running",
    "memory-stop-continuation",
    "memory-reenable-after-erasure",
  ]);
  for (const c of cases.filter((c) => c.after && c.id !== "memory-reenable-after-erasure"))
    expect(caseChain(c, cases).map((c) => c.id)).toEqual([c.after, c.id]);
  const c = cases[0]!;
  expect(() => parseCases(JSON.stringify({ ...c, after: "missing" }))).toThrow("earlier");
});
