import { setFileMode } from "@opensteer/shared/privateFiles";
import { copyFileSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

export interface CrashReportIO {
  list(directory: string): string[];
  stat(file: string): { isFile(): boolean; mtimeMs: number };
  mkdir(directory: string): void;
  copy(source: string, target: string): void;
  chmod(file: string, mode: number): void | Promise<void>;
}
const reportIO: CrashReportIO = {
  list: (directory) => {
    try {
      return readdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  },
  stat: lstatSync,
  mkdir: (directory) => {
    mkdirSync(directory, { recursive: true });
  },
  copy: copyFileSync,
  chmod: setFileMode,
};

/** Diagnostic reports are evidence only; their paths never authorize cleanup. */
export async function collectCrashReports(
  home: string,
  startedAt: number,
  directory: string,
  io = reportIO,
): Promise<number> {
  const source = path.join(home, "Library/Logs/DiagnosticReports");
  const target = path.join(directory, "crash-reports");
  let count = 0;
  for (const name of io.list(source)) {
    if (!/\.(ips|crash)$/.test(name)) continue;
    const file = path.join(source, name);
    const stat = io.stat(file);
    if (!stat.isFile() || stat.mtimeMs < startedAt) continue;
    io.mkdir(target);
    const copy = path.join(target, name);
    io.copy(file, copy);
    await io.chmod(copy, 0o444);
    count++;
  }
  return count;
}

/** Copy the legacy script's evidence without changing its files or following links. */
export async function copyJourneyEvidence(source: string, target: string): Promise<void> {
  let entries;
  try {
    entries = readdirSync(source, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  mkdirSync(target, { recursive: true });
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) await copyJourneyEvidence(from, to);
    else if (entry.isFile()) {
      copyFileSync(from, to);
      await setFileMode(to, 0o444);
    }
  }
}
