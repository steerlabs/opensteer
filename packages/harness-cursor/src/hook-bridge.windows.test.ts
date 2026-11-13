import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { afterEach, describe, expect, it } from "vitest";
import {
  CursorHookBridge,
  createCursorHookEndpoint,
  type CursorHookBridgeOptions,
  type CursorHookVerdict,
} from "./hook-bridge.js";
import { cursorHookProgramFileName, cursorHookProgramSource } from "./hook-program.js";
import { cursorHookCommand, cursorHookShellEnvironment } from "./plugin.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function within<T>(promise: Promise<T>, what: string, ms = 15_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => !!entry[1]),
  );
}

/** A bridge on a real named pipe, and the hook program in a path PowerShell must quote. */
async function bridge(decide: CursorHookBridgeOptions["decide"]) {
  const root = await mkdtemp(join(tmpdir(), "opensteer-cursor-hook-"));
  cleanups.push(() => rm(root, { force: true, recursive: true }));
  const programDirectory = join(root, "it's ’quoted’ ‘twice‛ ‚");
  await mkdir(programDirectory);
  const program = join(programDirectory, cursorHookProgramFileName);
  await writeFile(program, cursorHookProgramSource);
  const endpoint = await createCursorHookEndpoint();
  const listening = await CursorHookBridge.listen({
    decide,
    endpoint,
    maximumPayloadBytes: 1_024 * 1_024,
  });
  cleanups.push(async () => {
    await listening.close();
    await endpoint.remove();
  });
  return { endpoint, listening, program, root };
}

/**
 * Runs a hook command the way the pinned Cursor CLI's Windows PowerShell
 * executor does: as one line of a `-File` script, with the payload on stdin
 * (which is why it passes no `-NonInteractive`).
 */
async function runLikeCursor(command: string, cwd: string, payload: string) {
  const environment = cursorHookShellEnvironment(inheritedEnvironment());
  const script = join(cwd, "hook-run.ps1");
  const body = [
    "",
    `Set-Location '${cwd}'`,
    "",
    command,
    "$COMMAND_EXIT_CODE = $LASTEXITCODE",
    "exit $COMMAND_EXIT_CODE",
    "",
  ].join("\n");
  await writeFile(script, `﻿${body}`, "utf8");
  const child = spawn(environment.SHELL ?? "", ["-ExecutionPolicy", "Bypass", "-File", script], {
    cwd,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stderr.resume();
  child.stdin.end(payload);
  const [stdout, code] = await within(
    Promise.all([
      text(child.stdout),
      new Promise<number | null>((resolve) => child.once("exit", (exit) => resolve(exit))),
    ]),
    "The hook command finishing in Windows PowerShell",
  );
  return { code, verdict: JSON.parse(stdout.trim()) as unknown };
}

describe("Cursor approval hooks on Windows", () => {
  it("names Windows PowerShell as the hook shell", () => {
    const shell = cursorHookShellEnvironment(inheritedEnvironment()).SHELL ?? "";
    expect(shell.toLowerCase()).toMatch(/\\system32\\windowspowershell\\v1\.0\\powershell\.exe$/u);
    expect(existsSync(shell)).toBe(true);
  });

  it.each([
    ["approves", { permission: "allow" }, { permission: "allow" }],
    [
      "denies",
      { agentMessage: "No.", permission: "deny", userMessage: "denied in Opensteer" },
      { agent_message: "No.", permission: "deny", user_message: "denied in Opensteer" },
    ],
  ] as const)(
    "%s a tool call over a named pipe the hook reaches from PowerShell",
    async (_, verdict: CursorHookVerdict, printed) => {
      const payloads: unknown[] = [];
      const { endpoint, program, root } = await bridge(async (payload) => {
        payloads.push(payload);
        return verdict;
      });
      expect(endpoint.path).toMatch(/^\\\\\.\\pipe\\opensteer-cursor-[0-9a-f]{32}$/u);
      const command = cursorHookCommand(process.execPath, program, endpoint.path);

      const result = await runLikeCursor(command, root, '{"command":"Remove-Item ’x’"}\n');

      expect(result.code).toBe(0);
      expect(result.verdict).toEqual(printed);
      expect(payloads).toEqual([{ command: "Remove-Item ’x’" }]);
    },
  );

  it("denies a waiting hook when the Run closes the bridge", async () => {
    let asked!: () => void;
    const askedOnce = new Promise<void>((resolve) => (asked = resolve));
    const { endpoint, listening, program, root } = await bridge(() => {
      asked();
      return new Promise<never>(() => undefined);
    });
    const running = runLikeCursor(
      cursorHookCommand(process.execPath, program, endpoint.path),
      root,
      "{}\n",
    );
    await within(askedOnce, "The bridge receiving the hook payload");
    await listening.close();

    expect((await running).verdict).toMatchObject({ permission: "deny" });
  });

  it("tells the waiting decision when the hook's process is killed", async () => {
    let asked!: () => void;
    const askedOnce = new Promise<void>((resolve) => (asked = resolve));
    let abandoned!: (reason: unknown) => void;
    const wentAway = new Promise<unknown>((resolve) => (abandoned = resolve));
    const { endpoint, program } = await bridge(
      (_, signal) =>
        new Promise<never>(() => {
          signal.addEventListener("abort", () => abandoned(signal.reason), { once: true });
          asked();
        }),
    );
    const hook = spawn(process.execPath, [program, endpoint.path], {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
    cleanups.push(async () => {
      if (hook.exitCode === null) hook.kill();
    });
    hook.stdin.end("{}\n");
    await within(askedOnce, "The bridge receiving the hook payload");
    hook.kill();

    await expect(within(wentAway, "The bridge noticing the killed hook")).resolves.toBeInstanceOf(
      Error,
    );
  });
});
