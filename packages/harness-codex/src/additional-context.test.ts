import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CodexAdditionalContext } from "./additional-context.js";

it("bounds UTF-8 values without losing paragraphs, lines or code points and retires removed keys across engines", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-context-"));
  try {
    const path = join(directory, "codex-context-keys.json");
    const builder = await CodexAdditionalContext.open(path);
    const text = `first paragraph\n\n${"🦊".repeat(2100)}\n${"line\n".repeat(1100)}`;
    const entries = await builder.build({
      instructions: text,
      skills_alpha: "Alpha",
      skills_beta: "Beta",
    });
    expect(Object.keys(entries)).toEqual(Object.keys(entries).sort());
    for (const entry of Object.values(entries))
      expect(Buffer.byteLength(entry.value)).toBeLessThanOrEqual(4000);
    expect(
      Object.values(entries)
        .slice(0, -2)
        .map((entry) => entry.value)
        .join(""),
    ).toBe(text);
    expect(entries.instructions_000001?.value).toBe("first paragraph\n\n");
    // A replaced engine resumes the same conversation and must still retire what it never sent itself.
    const replacement = await CodexAdditionalContext.open(path);
    const smaller = await replacement.build({ instructions: "short", skills_beta: "Beta" });
    expect(smaller.skills_alpha_000001?.value).toBe("");
    expect(smaller.instructions_000002?.value).toBe("");
    expect(smaller.skills_beta_000001).toEqual(entries.skills_beta_000001);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
