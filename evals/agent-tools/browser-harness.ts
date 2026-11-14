import { copyFile, writeFile, readFile, mkdir } from "node:fs/promises";
import { setFileMode } from "@opensteer/shared/privateFiles";
import { join } from "node:path";
import { BrowserFixtureSchema, type EvalCase } from "./cases.js";
import type { RecordedCall } from "./grader.js";

export async function prepareBrowserHarness(directory: string, browser: EvalCase["browser"]) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const executable = join(directory, "browser-harness");
  const state = join(directory, "browser-state.json");
  const log = join(directory, "browser-calls.jsonl");
  await copyFile(new URL("./fake-browser.mjs", import.meta.url), executable);
  await setFileMode(executable, 0o700);
  const fixture = browser ?? BrowserFixtureSchema.parse({});
  await writeFile(
    state,
    JSON.stringify({
      ...fixture,
      // `current` is the tab an earlier script left the agent in, never the person's.
      tabs: fixture.tabs,
    }),
  );
  await writeFile(log, "");
  return {
    commandEnvironment: {
      OPENSTEER_BROWSER_HARNESS: executable,
      OPENSTEER_EVAL_BROWSER_STATE: state,
      OPENSTEER_EVAL_BROWSER_LOG: log,
    },
    reset: () => writeFile(log, ""),
    calls: async (): Promise<RecordedCall[]> =>
      (await readFile(log, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RecordedCall),
  };
}
