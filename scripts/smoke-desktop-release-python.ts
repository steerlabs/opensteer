import { appendFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { command } from "./smoke-desktop-release-command.js";

export const observerPythonFlags = ["-I", "-S", "-u"];
export const observerStartup = { marker: "observer interpreter.start\n", timeoutMs: 2_000 };
export const observerScript = path.join(import.meta.dirname, "smoke-desktop-release-observer.py");

export async function resolveObserverPython(environment: NodeJS.ProcessEnv): Promise<string> {
  const configured = environment.OPENSTEER_RELEASE_OBSERVER_PYTHON;
  if (configured && !path.isAbsolute(configured))
    throw Error("Observer Python must be an absolute concrete interpreter path");
  const candidates = configured
    ? [configured]
    : [
        ...(environment.DEVELOPER_DIR
          ? [path.join(environment.DEVELOPER_DIR, "usr/bin/python3")]
          : []),
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
        "/Library/Developer/CommandLineTools/usr/bin/python3",
      ];
  for (const candidate of candidates) {
    if (candidate === "/usr/bin/python3")
      throw Error("Observer Python refuses the /usr/bin/python3 developer-tool shim");
    let executable: string;
    try {
      executable = await realpath(candidate);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    if (executable === "/usr/bin/python3")
      throw Error("Observer Python refuses the /usr/bin/python3 developer-tool shim");
    return executable;
  }
  throw Error("No concrete observer Python found; set OPENSTEER_RELEASE_OBSERVER_PYTHON");
}

export function probeObserverPython(python: string, roots = new Set<number>()) {
  return command(
    python,
    [...observerPythonFlags, observerScript, "probe"],
    5_000,
    roots,
    () => {},
    observerStartup,
  );
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const python = await resolveObserverPython(process.env);
  console.log(await probeObserverPython(python));
  if (process.env.GITHUB_ENV)
    await appendFile(process.env.GITHUB_ENV, `OPENSTEER_RELEASE_OBSERVER_PYTHON=${python}\n`);
}
