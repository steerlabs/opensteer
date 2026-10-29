import { spawn } from "node:child_process";

const maximumVersionOutputBytes = 8 * 1_024;
const defaultVerificationTimeoutMs = 10_000;
const nodeVersionLine = /^v([0-9]+)\.([0-9]+)\.([0-9]+)$/u;

/**
 * Proves that the configured executable is a Node 24+ interpreter before the
 * Runner advertises itself: `--version` must print exactly one stable version
 * line on stdout and nothing on stderr, under a minimal environment that can
 * never carry Electron's `ELECTRON_RUN_AS_NODE`. A probe that hangs or floods
 * output is killed outright; there is no fallback executable.
 */
export async function verifyNodeExecutable(
  executable: string,
  options: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
  } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? defaultVerificationTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError("Node executable verification timeout must be from 1 through 60000 ms");
  }
  const sourceEnvironment = options.environment ?? process.env;
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["HOME", "PATH"] as const) {
    const value = sourceEnvironment[name];
    if (value !== undefined) environment[name] = value;
  }

  const child = spawn(executable, ["--version"], {
    env: environment,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  let outputOverflow = false;
  let timedOut = false;
  const collectInto = (target: Buffer[]) => (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maximumVersionOutputBytes) {
      outputOverflow = true;
      child.kill("SIGKILL");
      return;
    }
    target.push(buffer);
  };
  child.stdout.on("data", collectInto(stdout));
  child.stderr.on("data", collectInto(stderr));

  const result = await new Promise<{
    readonly code: number | null;
    readonly signal: string | null;
  }>((resolvePromise, rejectPromise) => {
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(
        new Error(`OPENSTEER_NODE_EXECUTABLE could not be started: ${executable}`, {
          cause: error,
        }),
      );
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
  });
  if (timedOut) {
    throw new Error(`OPENSTEER_NODE_EXECUTABLE verification timed out: ${executable}`);
  }
  if (outputOverflow) {
    throw new Error(`OPENSTEER_NODE_EXECUTABLE produced too much version output: ${executable}`);
  }
  if (result.code !== 0) {
    const ending = result.signal ? `signal ${result.signal}` : `exit code ${String(result.code)}`;
    throw new Error(`OPENSTEER_NODE_EXECUTABLE --version failed with ${ending}: ${executable}`);
  }
  if (stderr.length > 0) {
    throw new Error(`OPENSTEER_NODE_EXECUTABLE --version wrote to stderr: ${executable}`);
  }
  const lines = Buffer.concat(stdout)
    .toString("utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const version = lines.length === 1 ? nodeVersionLine.exec(lines[0] ?? "") : null;
  if (!version) {
    throw new Error(
      `OPENSTEER_NODE_EXECUTABLE did not report exactly one stable Node version: ${executable}`,
    );
  }
  if (Number(version[1]) < 24) {
    throw new Error(
      `OPENSTEER_NODE_EXECUTABLE requires Node 24 or newer, but reported ${version[0]}: ${executable}`,
    );
  }
}
