import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

/**
 * What a Run may reach on disk is decided in one place, `RunnerRuntime.#runFolders`, from whether
 * it has personal context. This reads the runtime's source for every use of Agent home's path (a
 * prepared workspace's `.path`, or anything named for Agent home) and fails on one outside that
 * place, unless it is listed here with why it is not on a Run's behalf.
 */
const source = readFileSync(new URL("./runtime.ts", import.meta.url), "utf8");

/** Uses that are the Runner's own, never a Run's, each with why. */
const notForARun = {
  "if (workspace) this.#settingsHome = workspace.path;":
    "The Runner's own settings home, read for its engines' defaults, outside any Run.",
  "await this.#scanAgentHomeSkills(workspace.path, context.bindingGeneration).catch(":
    "After a Run ends, the person's skill catalog is refreshed for the Home; nothing reaches the Run.",
};

it("reads Agent home's path for a Run only in #runFolders", () => {
  const start = source.indexOf("  async #runFolders(");
  const end = source.indexOf("\n  }\n", start);
  expect(start).toBeGreaterThan(0);
  const uses = [...source.matchAll(/\b(?:workspace|\w*[aA]gentHome\w*)\??\.path\b/gu)].flatMap(
    (match) => {
      if (match.index > start && match.index < end) return [];
      const lineStart = source.lastIndexOf("\n", match.index) + 1;
      const line = source.slice(lineStart, source.indexOf("\n", match.index)).trim();
      return line in notForARun ? [] : [line];
    },
  );
  expect(uses).toEqual([]);
});

it("lists only uses that are still there", () => {
  for (const line of Object.keys(notForARun)) expect(source).toContain(line);
});
