import { copyFile, lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { EvalCase } from "./cases.js";

export function caseChain(c: EvalCase, corpus: readonly EvalCase[]): EvalCase[] {
  if (!c.after) return [c];
  const previous = corpus.find((p) => p.id === c.after);
  if (!previous) throw new Error(`Missing predecessor ${c.after}`);
  return [...caseChain(previous, corpus), c];
}

/** Carry files, never provider history or harness-generated skills, to a cold run. */
export async function copyWorkspace(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const name of await readdir(source)) {
    if (name.startsWith(".eval-")) continue;
    const from = join(source, name);
    const to = join(destination, name);
    const stat = await lstat(from);
    if (stat.isSymbolicLink()) throw new Error(`Cannot transfer symlink: ${from}`);
    if (stat.isDirectory()) await copyWorkspace(from, to);
    else if (stat.isFile()) await copyFile(from, to);
  }
}
