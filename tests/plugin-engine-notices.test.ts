import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { collectNotices } from "../scripts/plugin-engine/notices.mjs";

test("imports package, nested vendored and embedded dependency notices without renaming them", async () => {
  const root = await mkdtemp(join(tmpdir(), "plugin-notices-"));
  try {
    await mkdir(join(root, "packages/database/third-party"), { recursive: true });
    const source = join(root, "packages/database/third-party/source.ts");
    await writeFile(join(root, "LICENSE"), "MIT License\nCopyright primary");
    await writeFile(
      join(root, "packages/database/LICENSE"),
      "MIT License\nCopyright primary\nPortions derived from another MIT project, Copyright additional author.",
    );
    await writeFile(join(root, "packages/database/third-party/NOTICE"), "Nested code attribution");
    await writeFile(
      source,
      "/*! Copyright embedded author; MIT License */\nexport const value = 1;",
    );
    const notices = await collectNotices(
      root,
      [source],
      [["dependency.patch", "+/*! Copyright dependency author; MIT License */"]],
    );
    expect(notices.map(({ text }) => text)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Copyright additional author"),
        "Nested code attribution",
        expect.stringContaining("Copyright embedded author"),
        expect.stringContaining("Copyright dependency author"),
      ]),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retains the database package's supplemental attribution and permission", async () => {
  const notices = await readFile(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
  expect(notices).toContain("### packages/database/LICENSE");
  const section = notices.split("### packages/database/LICENSE\n")[1]?.split(/\n#{2,3} /u)[0];
  expect(
    createHash("sha256")
      .update(section?.trim() ?? "")
      .digest("hex"),
  ).toBe("2329176aff65e8915f4b2bdd0191f6de30e306698b4798cab9c5b6d0bfc5ef0b");
  expect(section).toMatch(/Portions derived from .+, Copyright \(c\) 2025 .+ \(MIT\)\./u);
  expect(section).toContain(
    "The above copyright notice and this permission notice shall be included",
  );
});
