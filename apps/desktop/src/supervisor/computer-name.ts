import { spawn } from "node:child_process";
import { hostname } from "node:os";

const maxComputerNameBytes = 4_096;
const maxComputerNameLength = 120;
const readTimeoutMs = 5_000;
const unnamedComputer = "Unnamed computer";

let cached: Promise<string> | undefined;

/**
 * The name a person gave this machine, which is what a Deployment should call
 * the computer they just added. On macOS that name lives in the dynamic store
 * and `os.hostname()` only ever returns its DNS-safe approximation
 * ("example-mac.local"), so the real one is worth one child process. It
 * cannot change under a running app in any way worth following, so it is read
 * once and kept.
 */
export function computerName(): Promise<string> {
  cached ??= readComputerName().catch(() => fallbackComputerName());
  return cached;
}

async function readComputerName(): Promise<string> {
  if (process.platform !== "darwin") return fallbackComputerName();
  return (await macComputerName()) ?? fallbackComputerName();
}

function fallbackComputerName(): string {
  return boundedName(hostname()) ?? unnamedComputer;
}

/** The status schema carries a name, never an empty string or an essay. */
function boundedName(value: string): string | null {
  const trimmed = value.trim().slice(0, maxComputerNameLength).trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function macComputerName(): Promise<string | null> {
  return new Promise<string | null>((resolvePromise) => {
    const child = spawn("/usr/sbin/scutil", ["--get", "ComputerName"], {
      env: { PATH: "/usr/sbin:/usr/bin:/bin" },
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, readTimeoutMs);
    timer.unref();
    child.stdout?.on("data", (value: Buffer) => {
      output = `${output}${value.toString("utf8")}`.slice(0, maxComputerNameBytes);
    });
    child.once("error", () => finish(null));
    child.once("exit", (code) => finish(code === 0 ? boundedName(output) : null));

    function finish(value: string | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    }
  });
}
