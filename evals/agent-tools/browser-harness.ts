import { copyFile, writeFile, readFile, mkdir } from "node:fs/promises";
import { setFileMode } from "@opensteer/shared/privateFiles";
import { join } from "node:path";
import { BrowserFixtureSchema, type EvalCase } from "./cases.js";
import type { RecordedCall } from "./grader.js";

export async function prepareBrowserHarness(
  directory: string,
  browser: EvalCase["browser"],
  /** The fake Host route that answers `opensteer.callTool`; absent, scripts cannot call tools. */
  tools?: { readonly toolsUrl: string; readonly token: string; readonly denied?: boolean },
) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const executable = join(directory, "browser-harness");
  const statePath = join(directory, "browser-state.json");
  const log = join(directory, "browser-calls.jsonl");
  await copyFile(new URL("./fake-browser.mjs", import.meta.url), executable);
  await setFileMode(executable, 0o700);
  await writeFile(statePath, JSON.stringify(browser ?? BrowserFixtureSchema.parse({})));
  await writeFile(log, "");
  return {
    statePath,
    commandEnvironment: {
      OPENSTEER_BROWSER_HARNESS: executable,
      OPENSTEER_EVAL_BROWSER_STATE: statePath,
      OPENSTEER_EVAL_BROWSER_LOG: log,
      ...(tools
        ? { OPENSTEER_EVAL_TOOLS_URL: tools.toolsUrl, OPENSTEER_EVAL_TOOLS_TOKEN: tools.token }
        : {}),
      ...(tools?.denied ? { OPENSTEER_EVAL_BROWSER_DENIED: "1" } : {}),
    },
    reset: () => writeFile(log, ""),
    calls: async (): Promise<RecordedCall[]> =>
      (await readFile(log, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RecordedCall),
  };
}
