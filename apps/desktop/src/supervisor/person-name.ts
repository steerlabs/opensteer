import { spawn } from "node:child_process";
import { userInfo } from "node:os";

const maxOutputBytes = 4_096;
const readTimeoutMs = 5_000;

let cached: Promise<string | null> | undefined;

/**
 * The full name this computer's account was given ("Ada Lovelace"), which a new personal
 * Opensteer uses as its owner's name until they choose one. Null where the platform keeps none,
 * as Windows local accounts and many Linux accounts do. Read once; it stays on this computer.
 */
export function personFullName(): Promise<string | null> {
  cached ??= readFullName().catch(() => null);
  return cached;
}

async function readFullName(): Promise<string | null> {
  if (process.platform === "darwin") return output("/usr/bin/id", ["-F"]);
  if (process.platform !== "linux") return null;
  // passwd's comment field: "Full Name,Room,Work phone,Home phone,Other".
  const entry = await output("/usr/bin/getent", ["passwd", userInfo().username]);
  return entry?.split(":")[4]?.split(",")[0]?.trim() || null;
}

function output(file: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const child = spawn(file, args, {
      env: { PATH: "/usr/bin:/bin" },
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let text = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, readTimeoutMs);
    timer.unref();
    child.stdout?.on("data", (value: Buffer) => {
      text = `${text}${value.toString("utf8")}`.slice(0, maxOutputBytes);
    });
    child.once("error", () => finish(null));
    child.once("exit", (code) => finish(code === 0 ? text.trim() || null : null));

    function finish(value: string | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    }
  });
}
