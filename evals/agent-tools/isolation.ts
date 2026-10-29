import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { setPrivateFileMode } from "@opensteer/shared/privateFiles";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import type { HarnessProcessLaunchWrapper, HarnessProviderState } from "@opensteer/harness";

const exec = promisify(execFile);

/**
 * One sample's disposable engine environment. The driver's own isolated-service
 * sandbox confines native tools exactly as on a macOS Runner, which cannot nest
 * another Seatbelt profile around it. This adds a private HOME and engine
 * profile holding only a copy of the existing login, so engines start without
 * the user's configuration, hooks, MCP servers or history.
 */
export async function isolate(root: string, engine: "claude" | "codex", signal: AbortSignal) {
  signal.throwIfAborted();
  const rootPath = await realpath(root);
  const privateRoot = join(rootPath, "private");
  const providerHome = join(privateRoot, "provider");
  const workspace = join(rootPath, "workspace");
  const temporary = join(rootPath, "tmp");
  await Promise.all(
    [providerHome, workspace, temporary].map((path) =>
      mkdir(path, { recursive: true, mode: 0o700 }),
    ),
  );
  // Copy only authentication, never user MCP servers, plugins, instructions,
  // hooks, history or provider routing. Copies are inaccessible to model tools.
  if (engine === "codex") {
    const source = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
    await copyFile(source, join(providerHome, "auth.json"));
    await setPrivateFileMode(join(providerHome, "auth.json"));
  } else {
    const originalHome = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
    let credentials: string;
    try {
      credentials = await readFile(join(originalHome, ".credentials.json"), "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      // Claude Code's native macOS login lives in Keychain; never print it or
      // import a user API key. The private engine profile gets a disposable copy.
      credentials = (
        await exec(
          "/usr/bin/security",
          [
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-a",
            userInfo().username,
            "-w",
          ],
          { maxBuffer: 64 * 1024, timeout: 5000, signal },
        )
      ).stdout.trim();
    }
    await writeFile(join(providerHome, ".credentials.json"), credentials, { mode: 0o600 });
  }
  const providerState: HarnessProviderState = {
    continuationKey: `eval:${root}`,
    kind: "ambient",
    providerHomeDirectory: undefined,
    privateStateRoot: privateRoot,
    store: { directory: providerHome, id: `eval:${root}` },
  };
  const sqliteHome = join(providerHome, "sqlite");
  await mkdir(sqliteHome, { recursive: true });
  const environment: Record<string, string> = {
    HOME: rootPath,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TMPDIR: temporary,
    LANG: "en_US.UTF-8",
    CLAUDE_CONFIG_DIR: providerHome,
    CODEX_HOME: providerHome,
    CODEX_SQLITE_HOME: sqliteHome,
  };
  const wrapProcessLaunch: HarnessProcessLaunchWrapper = (launch) => launch;
  return {
    workspace,
    privateRoot,
    providerHome,
    providerState,
    environment,
    wrapProcessLaunch,
    close: async () => {},
  };
}
