import type { Readable } from "node:stream";

/**
 * A stand-in Claude Code for `node -e`: it starts a grandchild that would
 * outlive it, reports what it was launched with, then waits to be stopped.
 */
export const fakeClaudeTreeScript = `
const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const config = process.argv[process.argv.indexOf("--mcp-config") + 1];
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
grandchild.once("spawn", () => {
  process.stdout.write(JSON.stringify({ config, configExisted: existsSync(config), grandchild: grandchild.pid }) + "\\n");
});
setInterval(() => {}, 1000);
`;

export interface FakeClaudeTreeReport {
  readonly config: string;
  readonly configExisted: boolean;
  readonly grandchild: number;
}

export async function readFakeClaudeTreeReport(stdout: Readable): Promise<FakeClaudeTreeReport> {
  let text = "";
  for await (const chunk of stdout) {
    text += String(chunk);
    const newline = text.indexOf("\n");
    if (newline >= 0) return JSON.parse(text.slice(0, newline)) as FakeClaudeTreeReport;
  }
  throw new Error(`The fake Claude Code exited without reporting its tree: ${text}`);
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
