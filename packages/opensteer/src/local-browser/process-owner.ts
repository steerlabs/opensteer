import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PROCESS_STARTED_AT_MS = Math.floor(Date.now() - process.uptime() * 1_000);
const PROCESS_START_TIME_TOLERANCE_MS = 1_000;
const PROCESS_LIST_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const PS_COMMAND_ENV = { ...process.env, LC_ALL: "C" };
const LINUX_STAT_START_TIME_FIELD_INDEX = 19;

export interface ProcessOwner {
  readonly pid: number;
  readonly processStartedAtMs: number;
}

export type ProcessLiveness = "live" | "dead" | "unknown";

export const CURRENT_PROCESS_OWNER: ProcessOwner = {
  pid: process.pid,
  processStartedAtMs: PROCESS_STARTED_AT_MS,
};

let linuxClockTicksPerSecondPromise: Promise<number | null> | null = null;

export function parseProcessOwner(value: unknown): ProcessOwner | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const parsed = value as Partial<ProcessOwner>;
  const pid = Number(parsed.pid);
  const processStartedAtMs = Number(parsed.processStartedAtMs);
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  if (!Number.isInteger(processStartedAtMs) || processStartedAtMs <= 0) {
    return null;
  }

  return {
    pid,
    processStartedAtMs,
  };
}

export function processOwnersEqual(left: ProcessOwner | null, right: ProcessOwner | null): boolean {
  if (!left || !right) {
    return left === right;
  }

  return left.pid === right.pid && left.processStartedAtMs === right.processStartedAtMs;
}

export async function getProcessLiveness(owner: ProcessOwner): Promise<ProcessLiveness> {
  if (
    owner.pid === process.pid &&
    hasMatchingProcessStartTime(owner.processStartedAtMs, PROCESS_STARTED_AT_MS)
  ) {
    return "live";
  }

  const startedAtMs = await readProcessStartedAtMs(owner.pid);
  if (typeof startedAtMs === "number") {
    return hasMatchingProcessStartTime(owner.processStartedAtMs, startedAtMs) ? "live" : "dead";
  }

  return isProcessRunning(owner.pid) ? "unknown" : "dead";
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : undefined;
    return code !== "ESRCH";
  }
}

export async function readProcessOwner(pid: number): Promise<ProcessOwner | null> {
  const processStartedAtMs = await readProcessStartedAtMs(pid);
  if (processStartedAtMs === null) {
    return null;
  }

  return {
    pid,
    processStartedAtMs,
  };
}

function hasMatchingProcessStartTime(
  expectedStartedAtMs: number,
  actualStartedAtMs: number,
): boolean {
  return Math.abs(expectedStartedAtMs - actualStartedAtMs) <= PROCESS_START_TIME_TOLERANCE_MS;
}

async function readProcessStartedAtMs(pid: number): Promise<number | null> {
  if (pid <= 0) {
    return null;
  }

  if (process.platform === "linux") {
    return readLinuxProcessStartedAtMs(pid);
  }

  if (process.platform === "win32") {
    return readWindowsProcessStartedAtMs(pid);
  }

  return readPsProcessStartedAtMs(pid);
}

async function readLinuxProcessStartedAtMs(pid: number): Promise<number | null> {
  let statRaw: string;
  try {
    statRaw = await readFile(`/proc/${String(pid)}/stat`, "utf8");
  } catch {
    return null;
  }

  const startTicks = parseLinuxProcessStartTicks(statRaw);
  if (startTicks === null) {
    return null;
  }

  const [bootTimeMs, clockTicksPerSecond] = await Promise.all([
    readLinuxBootTimeMs(),
    readLinuxClockTicksPerSecond(),
  ]);
  if (bootTimeMs === null || clockTicksPerSecond === null) {
    return null;
  }

  return Math.floor(bootTimeMs + (startTicks * 1_000) / clockTicksPerSecond);
}

function parseLinuxProcessStartTicks(statRaw: string): number | null {
  const closingParenIndex = statRaw.lastIndexOf(")");
  if (closingParenIndex === -1) {
    return null;
  }

  const fields = statRaw
    .slice(closingParenIndex + 2)
    .trim()
    .split(/\s+/);
  const startTicks = Number(fields[LINUX_STAT_START_TIME_FIELD_INDEX]);
  return Number.isFinite(startTicks) && startTicks >= 0 ? startTicks : null;
}

async function readLinuxBootTimeMs(): Promise<number | null> {
  try {
    const statRaw = await readFile("/proc/stat", "utf8");
    const bootTimeLine = statRaw.split("\n").find((line) => line.startsWith("btime "));
    if (!bootTimeLine) {
      return null;
    }

    const bootTimeSeconds = Number.parseInt(bootTimeLine.slice("btime ".length), 10);
    return Number.isFinite(bootTimeSeconds) ? bootTimeSeconds * 1_000 : null;
  } catch {
    return null;
  }
}

async function readLinuxClockTicksPerSecond(): Promise<number | null> {
  if (!linuxClockTicksPerSecondPromise) {
    linuxClockTicksPerSecondPromise = execFileAsync("getconf", ["CLK_TCK"], {
      encoding: "utf8",
      maxBuffer: PROCESS_LIST_MAX_BUFFER_BYTES,
    })
      .then(({ stdout }) => {
        const value = Number.parseInt(stdout.trim(), 10);
        return Number.isFinite(value) && value > 0 ? value : null;
      })
      .catch(() => null);
  }

  return linuxClockTicksPerSecondPromise;
}

async function readWindowsProcessStartedAtMs(pid: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `(Get-Process -Id ${String(pid)}).StartTime.ToUniversalTime().ToString("o")`,
      ],
      {
        encoding: "utf8",
        maxBuffer: PROCESS_LIST_MAX_BUFFER_BYTES,
      },
    );
    const isoTimestamp = stdout.trim();
    if (!isoTimestamp) {
      return null;
    }
    const startedAtMs = Date.parse(isoTimestamp);
    return Number.isFinite(startedAtMs) ? startedAtMs : null;
  } catch {
    return null;
  }
}

async function readPsProcessStartedAtMs(pid: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: PS_COMMAND_ENV,
      maxBuffer: PROCESS_LIST_MAX_BUFFER_BYTES,
    });
    const startedAt = stdout.trim();
    if (!startedAt) {
      return null;
    }

    const startedAtMs = Date.parse(startedAt.replace(/\s+/g, " "));
    return Number.isFinite(startedAtMs) ? startedAtMs : null;
  } catch {
    return null;
  }
}
