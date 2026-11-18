import { collectStreamText, spawnSupervised, type SupervisedProcess } from "@opensteer/harness";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function within<T>(promise: Promise<T>, what: string, signal?: AbortSignal): Promise<T> {
  return withTimeout(promise, 15_000, {
    ...(signal ? { signal } : {}),
    timeoutError: () => new Error(`${what} did not happen within 15000 ms`),
  });
}

function ownHook(child: SupervisedProcess) {
  const output = [
    child.exited,
    collectStreamText(child.stdout),
    collectStreamText(child.stderr),
  ] as const;
  const joined = Promise.allSettled(output);
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      // PowerShell can still have a Node child running in the fixture's cwd.
      await child.terminate(0);
      await joined;
    })());
  cleanups.push(stop);
  child.child.stdin.on("error", () => {
    // Early shell exit is reported by its exit status and stderr.
  });
  return { output, stop };
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
async function runLikeCursor(command: string, cwd: string, payload: string, signal?: AbortSignal) {
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
  signal?.throwIfAborted();
  const child = spawnSupervised({
    args: ["-ExecutionPolicy", "Bypass", "-File", script],
    cwd,
    environment,
    executable: environment.SHELL ?? "",
    stdin: "pipe",
  });
  const hook = ownHook(child);
  try {
    child.child.stdin.end(payload);
    const [{ code }, stdout, stderr] = await within(
      Promise.all(hook.output),
      "The hook command finishing in Windows PowerShell",
      signal,
    );
    if (code !== 0) throw new Error(`PowerShell hook exited with code ${code}: ${stderr}`);
    return { code, verdict: JSON.parse(stdout.trim()) as unknown };
  } finally {
    await hook.stop();
  }
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
    const [result] = await Promise.all([
      running,
      within(askedOnce, "The bridge receiving the hook payload").then(() => listening.close()),
    ]);
    expect(result.verdict).toMatchObject({ permission: "deny" });
  });

  it("joins PowerShell and its hook before removing the working directory on cancellation", async () => {
    const asked = Promise.withResolvers<void>();
    const disconnected = Promise.withResolvers<unknown>();
    const { endpoint, program, root } = await bridge(
      (_, signal) =>
        new Promise<never>(() => {
          signal.addEventListener("abort", () => disconnected.resolve(signal.reason), {
            once: true,
          });
          asked.resolve();
        }),
    );
    const abort = new AbortController();
    const reason = new Error("Stop the held hook");
    const canceled = expect(
      runLikeCursor(
        cursorHookCommand(process.execPath, program, endpoint.path),
        root,
        "{}\n",
        abort.signal,
      ),
    ).rejects.toBe(reason);
    await Promise.all([
      canceled,
      within(asked.promise, "The bridge receiving the hook payload").then(() =>
        abort.abort(reason),
      ),
    ]);
    await expect(
      within(disconnected.promise, "The held hook disconnecting"),
    ).resolves.toBeInstanceOf(Error);
    await rm(root, { force: true, recursive: true });
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
    const child = spawnSupervised({
      args: [program, endpoint.path],
      cwd: tmpdir(),
      environment: inheritedEnvironment(),
      executable: process.execPath,
      stdin: "pipe",
    });
    const hook = ownHook(child);
    child.child.stdin.end("{}\n");
    await within(askedOnce, "The bridge receiving the hook payload");
    await hook.stop();

    await expect(within(wentAway, "The bridge noticing the killed hook")).resolves.toBeInstanceOf(
      Error,
    );
  });
});
