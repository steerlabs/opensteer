import { spawn } from "node:child_process";
import os from "node:os";
import process from "node:process";

export type BrowserUrlOpener = (url: string) => Promise<void>;

export async function openBrowserUrl(url: string): Promise<void> {
  const command = resolveOpenBrowserCommand(url);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function resolveOpenBrowserCommand(url: string): {
  readonly executable: string;
  readonly args: readonly string[];
} {
  if (process.platform === "darwin") {
    return {
      executable: "open",
      args: [url],
    };
  }

  if (process.platform === "win32" || isWsl()) {
    return {
      executable: process.platform === "win32" ? "cmd" : "cmd.exe",
      args: ["/c", "start", "", url],
    };
  }

  return {
    executable: "xdg-open",
    args: [url],
  };
}

function isWsl(): boolean {
  return (
    process.platform === "linux" &&
    (process.env.WSL_DISTRO_NAME !== undefined ||
      os.release().toLowerCase().includes("microsoft"))
  );
}
