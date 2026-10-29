import { nodeErrorCode } from "@opensteer/shared/nodeError";
import { setFileMode } from "@opensteer/shared/privateFiles";
import { constants, copyFileSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

export interface EvidenceIO {
  list(directory: string): string[];
  stat(file: string): { isFile(): boolean; isDirectory(): boolean; mtimeMs: number };
  mkdir(directory: string): void;
  copy(source: string, target: string): void;
  setMode(file: string, mode: number): void | Promise<void>;
}
const evidenceIO: EvidenceIO = {
  list: (directory) => readdirSync(directory),
  stat: lstatSync,
  mkdir: (directory) => {
    mkdirSync(directory, { recursive: true });
  },
  // Reruns into legacy output meet their own read-only copies; replace, never write through.
  copy: (source, target) => {
    rmSync(target, { force: true });
    copyFileSync(source, target, constants.COPYFILE_EXCL);
  },
  setMode: setFileMode,
};
const missing = (error: unknown) => nodeErrorCode(error) === "ENOENT";

/** Copy regular files modified since `startedAt` read-only; a file removed before copying is skipped. */
async function copyCurrentFiles(
  source: string,
  target: string,
  startedAt: number,
  io: EvidenceIO,
  select: { recursive: boolean; name?: RegExp },
): Promise<number> {
  let names: string[];
  try {
    names = io.list(source);
  } catch (error) {
    if (missing(error)) return 0;
    throw error;
  }
  let count = 0;
  for (const name of names) {
    const from = path.join(source, name);
    const to = path.join(target, name);
    try {
      const stat = io.stat(from);
      if (stat.isDirectory() && select.recursive)
        count += await copyCurrentFiles(from, to, startedAt, io, select);
      if (!stat.isFile() || stat.mtimeMs < startedAt || select.name?.test(name) === false) continue;
      io.mkdir(target);
      io.copy(from, to);
    } catch (error) {
      if (missing(error)) continue;
      throw error;
    }
    await io.setMode(to, 0o444);
    count++;
  }
  return count;
}

/** Diagnostic reports are evidence only; their paths never authorize cleanup. */
export function collectCrashReports(
  home: string,
  startedAt: number,
  directory: string,
  io = evidenceIO,
): Promise<number> {
  return copyCurrentFiles(
    path.join(home, "Library/Logs/DiagnosticReports"),
    path.join(directory, "crash-reports"),
    startedAt,
    io,
    { recursive: false, name: /\.(ips|crash)$/ },
  );
}

/** The legacy script keeps earlier runs' evidence beside this one's; copy only what this run wrote. */
export async function copyJourneyEvidence(
  source: string,
  target: string,
  startedAt: number,
  io = evidenceIO,
): Promise<void> {
  await copyCurrentFiles(source, target, startedAt, io, { recursive: true });
}

/** Evidence failures are reported beside a finished journey's result and never replace it. */
export async function collectJourneyEvidence(
  home: string,
  startedAt: number,
  directory: string,
  legacyEvidence?: string,
  io = evidenceIO,
): Promise<{ crashReports: number; evidenceError?: string }> {
  const errors: string[] = [];
  if (legacyEvidence)
    await copyJourneyEvidence(legacyEvidence, directory, startedAt, io).catch((error: unknown) => {
      errors.push(String(error));
    });
  const crashReports = await collectCrashReports(home, startedAt, directory, io).catch(
    (error: unknown) => {
      errors.push(String(error));
      return 0;
    },
  );
  return errors.length ? { crashReports, evidenceError: errors.join("; ") } : { crashReports };
}
