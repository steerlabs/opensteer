import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

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
