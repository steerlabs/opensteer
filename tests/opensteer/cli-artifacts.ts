import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

let buildPromise: Promise<void> | undefined;

export async function ensureCliArtifactsBuilt(): Promise<void> {
  buildPromise ??= execFile("pnpm", ["build"], {
    cwd: process.cwd(),
    maxBuffer: 1024 * 1024 * 4,
  }).then(() => undefined);

  await buildPromise;
}
