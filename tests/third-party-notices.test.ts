import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// A Go module compiled into a shipped binary is redistributed with it, and its
// licence asks to be named. The helper and the process supervisor are the two
// Go programs this tree ships, so a new `require` has to arrive with its notice.
const goModules = [
  "apps/runner/native-fs-helper/go.mod",
  "apps/desktop/process-supervisor/go.mod",
] as const;

function directRequires(path: string): readonly string[] {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  return [...source.matchAll(/^(?:require\s+|\t)([^\s()]+)\s+v[^\s]+(?!.*\/\/ indirect)$/gm)].map(
    ([, module]) => module ?? "",
  );
}

describe("third-party notices", () => {
  const notices = readFileSync(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");

  it.each(goModules)("names every direct requirement of %s", (path) => {
    const requires = directRequires(path);
    expect(requires.length).toBeGreaterThan(0);
    for (const module of requires) expect(notices, module).toContain(module);
  });
});
