import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A provider's sentence describes its app and nothing else. The Host knows
 * which computer answered and renders "{detail} on {Computer}." itself, so a
 * sentence that named a place here would be read out twice — and it would be
 * the wrong place on the day a second Mac reports the same app.
 *
 * The scan is over source rather than over one provider's exported strings
 * because most of these sentences are literals written inline at the point they
 * are thrown, and a rule the next app has to remember is not a rule.
 */
const forbidden = [/\bthis Mac\b/iu, /\bthis computer\b/iu];

/**
 * The two exceptions, fixed by `docs/computer-use.md` §3.
 *
 * They are not one app's sentence: they say that the computer has no helper
 * behind the feature at all, which is why they are the answer to every
 * computer-use frame and the `macos-app` status detail rather than a detail the
 * Host renders after an app's name. Written out here so the rule still holds
 * for every other sentence in the same files.
 */
const specified = [
  "Computer use needs the Opensteer desktop app on this Mac.",
  "The Opensteer desktop app is not running on this Mac.",
];

describe("computer app sentences", () => {
  it("never names a place", async () => {
    const self = fileURLToPath(import.meta.url);
    const offenders: string[] = [];
    for (const path of await sourceFiles(dirname(self))) {
      // This file spells the phrases out, which is the one legitimate reason to.
      if (path === self) continue;
      let code = withoutComments(await readFile(path, "utf8"));
      for (const sentence of specified) code = code.replaceAll(sentence, " ");
      if (forbidden.some((pattern) => pattern.test(code))) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });
});

async function sourceFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

/** Comments explain why a sentence reads as it does; only the code is scanned. */
function withoutComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//gu, " ").replaceAll(/\/\/[^\n]*/gu, " ");
}
