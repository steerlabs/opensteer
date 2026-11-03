import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CaseSchema, inputForCaseTurn, parseCases } from "./cases.js";
import { grade, gradeWorkspaceFiles } from "./grader.js";

const memoryCases = async () =>
  parseCases(await readFile(new URL("./cases/memory.ndjson", import.meta.url), "utf8"));
const expectations = (files: unknown[]) => CaseSchema.shape.expect.parse({ files });

describe("Workspace file outcomes", () => {
  it("matches any eligible file, forbids matches in every nested file, and excludes the inbox", async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-grader-"));
    try {
      await mkdir(join(root, "memory/inbox"), { recursive: true });
      await writeFile(join(root, "memory/inbox/raw.md"), "Juniper 483");
      await writeFile(join(root, "unrelated.txt"), "Juniper 483");
      const e = expectations([
        {
          path: ["AGENTS.md", "memory"],
          recursive: true,
          exclude: ["memory/inbox"],
          textMust: ["Juniper 483"],
          textMustNot: ["Larch 712"],
        },
      ]);
      expect((await gradeWorkspaceFiles(e, root)).map((c) => c.pass)).toEqual([false, true]);
      await writeFile(join(root, "memory/note.md"), "Juniper 483");
      expect((await gradeWorkspaceFiles(e, root)).every((c) => c.pass)).toBe(true);
      await writeFile(join(root, "memory/stale.md"), "Larch 712");
      expect((await gradeWorkspaceFiles(e, root)).map((c) => c.pass)).toEqual([true, false]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("handles deleted files and refuses symlinks rather than reading host files", async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-grader-"));
    try {
      const e = expectations([{ path: "missing.md", textMust: ["fact"], textMustNot: ["secret"] }]);
      expect((await gradeWorkspaceFiles(e, root)).map((c) => c.pass)).toEqual([false, true]);
      await symlink(join(root, "absent"), join(root, "missing.md"));
      await expect(gradeWorkspaceFiles(e, root)).rejects.toThrow("symlink");
      await mkdir(join(root, "real"));
      await writeFile(join(root, "real/note.md"), "secret");
      await symlink(join(root, "real"), join(root, "alias"));
      await expect(
        gradeWorkspaceFiles(
          expectations([{ path: "alias/note.md", textMustNot: ["secret"] }]),
          root,
        ),
      ).rejects.toThrow("symlink");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("rejects traversal and invalid file patterns at the case boundary", () => {
    for (const rule of [
      { path: "../outside" },
      { path: "a", exclude: ["../outside"] },
      { path: "a", textMustNot: ["["] },
    ])
      expect(() => expectations([rule])).toThrow();
  });
});

it("validates the complete corpus and preserves Trigger and task wake authorship", async () => {
  const directory = new URL("./cases/", import.meta.url);
  const files = (await readdir(directory)).filter((name) => name.endsWith(".ndjson"));
  const corpus = parseCases(
    (await Promise.all(files.map((name) => readFile(new URL(name, directory), "utf8")))).join("\n"),
  );
  const cases = corpus.filter((c) => c.area === "memory");
  expect(cases).toHaveLength(16);
  for (const c of cases) for (const turn of c.turns) inputForCaseTurn(turn);
  expect(
    inputForCaseTurn(cases.find((c) => c.id === "memory-nothing-new")!.turns[0]!).author.kind,
  ).toBe("trigger");
  expect(
    inputForCaseTurn(cases.find((c) => c.id === "memory-trivial-chat-wake")!.turns[0]!).author.kind,
  ).toBe("agent");
});

it("requires quiet turns and queued home delivery rather than report-only or invalid attempts", async () => {
  const cases = await memoryCases();
  const quiet = cases.find((c) => c.id === "memory-nothing-new")!.expect;
  const mail = { tool: "integration_call", args: quiet.calls[0]!.args, valid: true };
  expect(grade(quiet, [mail], "", "").every((c) => c.pass)).toBe(true);
  expect(grade(quiet, [mail], "", "Done.").every((c) => c.pass)).toBe(false);
  expect(
    grade(quiet, [mail, { tool: "thread_message", args: {}, valid: false }], "").every(
      (c) => c.pass,
    ),
  ).toBe(false);
  const important = cases.find((c) => c.id === "memory-important-item")!.expect;
  const message = {
    tool: "thread_message",
    args: { threadId: "home", delivery: "queue" },
    valid: true,
  };
  expect(grade(important, [mail, message], "").every((c) => c.pass)).toBe(true);
  for (const changed of [
    { ...message, args: { ...message.args, delivery: "report" } },
    { ...message, valid: false },
  ])
    expect(grade(important, [mail, changed], "").every((c) => c.pass)).toBe(false);
});
