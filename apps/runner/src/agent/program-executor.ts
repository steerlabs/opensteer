import { setPrivateDirectoryMode, setPrivateFileMode } from "@opensteer/shared/privateFiles";
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import type { HarnessProcessLaunchWrapper } from "@opensteer/harness";
import type { TriggerExecutionContext } from "@opensteer/protocol";
import type { TriggerExecutionOutput } from "@opensteer/triggers";
import type { RunWorkspace } from "../workspace/mount-manager.js";
import { triggerProgramRuntimeSource } from "./program-runtime.js";

const streamByteLimit = 512 * 1_024;
const resultByteLimit = 512 * 1_024;
const truncationMarker = "\n[Opensteer truncated earlier process output]\n";

interface TriggerProgramExecutorOptions {
  readonly nodeExecutable: string;
  readonly privateDirectory?: string;
}

/** What a program reaches Opensteer through: the Runner's stand-ins, never Host tokens. */
export interface ProgramEndpoints {
  readonly browserCdp?: { readonly token: string; readonly url: string };
  readonly integrationMcp: { readonly token: string; readonly url: string };
  readonly mcp: { readonly token: string; readonly url: string };
}

/** Confines one program launch, given its private directory and environment. */
export type ProgramLaunchPlanner = (input: {
  readonly environment: Readonly<Record<string, string>>;
  readonly privateDirectory: string;
  readonly workspacePath: string;
}) => Promise<HarnessProcessLaunchWrapper>;

export class TriggerProgramExecutor {
  readonly #nodeExecutable: string;
  readonly #privateDirectory: string;

  constructor(options: TriggerProgramExecutorOptions) {
    this.#nodeExecutable = options.nodeExecutable;
    this.#privateDirectory = resolve(
      options.privateDirectory ?? join(tmpdir(), "opensteer-trigger-programs"),
    );
  }

  async execute(input: {
    readonly context: TriggerExecutionContext;
    readonly endpoints: ProgramEndpoints;
    readonly planLaunch: ProgramLaunchPlanner;
    readonly signal: AbortSignal;
    readonly workspace: RunWorkspace;
  }): Promise<TriggerExecutionOutput> {
    const { context } = input;
    const programFile = resolve(
      input.workspace.path,
      `.opensteer-trigger-${context.occurrenceId}.${
        context.program.language === "typescript" ? "ts" : "mjs"
      }`,
    );
    assertChildPath(input.workspace.path, programFile);
    const privateExecutionRoot = resolve(this.#privateDirectory, context.occurrenceId);
    assertChildPath(this.#privateDirectory, privateExecutionRoot);
    const runtimeFile = join(privateExecutionRoot, "runtime.mjs");
    const eventFile = join(privateExecutionRoot, "event.json");
    await mkdir(privateExecutionRoot, { mode: 0o700, recursive: true });
    await setPrivateDirectoryMode(privateExecutionRoot);
    try {
      await Promise.all([
        writePrivateFile(programFile, context.program.source),
        writePrivateFile(runtimeFile, triggerProgramRuntimeSource(pathToFileURL(programFile).href)),
        writePrivateFile(eventFile, JSON.stringify(context.event)),
      ]);
      return await this.#run({ context, eventFile, input, privateExecutionRoot, runtimeFile });
    } finally {
      await Promise.all([
        rm(programFile, { force: true }).catch(() => undefined),
        rm(privateExecutionRoot, { force: true, recursive: true }).catch(() => undefined),
      ]);
    }
  }

  async #run(input: {
    readonly context: TriggerExecutionContext;
    readonly eventFile: string;
    readonly input: {
      readonly endpoints: ProgramEndpoints;
      readonly planLaunch: ProgramLaunchPlanner;
      readonly signal: AbortSignal;
      readonly workspace: RunWorkspace;
    };
    readonly privateExecutionRoot: string;
    readonly runtimeFile: string;
  }): Promise<TriggerExecutionOutput> {
    const environment = triggerEnvironment(input.context, input.input.endpoints, input.eventFile);
    const args = ["--enable-source-maps"];
    if (input.context.program.language === "typescript") {
      args.push("--experimental-transform-types");
    }
    args.push(input.runtimeFile);
    const wrap = await input.input.planLaunch({
      environment,
      privateDirectory: input.privateExecutionRoot,
      workspacePath: input.input.workspace.path,
    });
    const launch = wrap({
      args,
      cwd: input.input.workspace.path,
      environment,
      executable: this.#nodeExecutable,
    });
    const child = spawn(launch.executable, [...launch.args], {
      cwd: launch.cwd,
      detached: process.platform !== "win32",
      env: { ...launch.environment },
      shell: false,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = collectBounded(child.stdout, streamByteLimit);
    const stderr = collectBounded(child.stderr, streamByteLimit);
    const result = collectBounded(readablePipe(child.stdio[3]), resultByteLimit);
    const stop = () => terminateChild(child);
    if (input.input.signal.aborted) stop();
    else input.input.signal.addEventListener("abort", stop, { once: true });
    const exit = await new Promise<{
      readonly code: number | null;
      readonly signal: string | null;
    }>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolvePromise({ code, signal }));
    }).finally(() => input.input.signal.removeEventListener("abort", stop));
    const [stdoutText, stderrText, resultText] = await Promise.all([stdout, stderr, result]);
    const completedAt = new Date().toISOString();
    if (input.input.signal.aborted) {
      return {
        completedAt,
        error: "Trigger program was canceled",
        exitCode: exit.code,
        occurrenceId: input.context.occurrenceId,
        result: null,
        status: "canceled",
        stderr: stderrText,
        stdout: stdoutText,
      };
    }
    const programResult = parseProgramResult(resultText);
    if (exit.code === 0 && programResult.ok) {
      return {
        completedAt,
        error: null,
        exitCode: exit.code,
        occurrenceId: input.context.occurrenceId,
        result: programResult.value,
        status: "succeeded",
        stderr: stderrText,
        stdout: stdoutText,
      };
    }
    return {
      completedAt,
      error:
        programResult.ok === false
          ? programResult.error
          : exit.signal
            ? `Trigger program ended from ${exit.signal}`
            : `Trigger program exited with code ${String(exit.code)}`,
      exitCode: exit.code,
      occurrenceId: input.context.occurrenceId,
      result: null,
      status: "failed",
      stderr: stderrText,
      stdout: stdoutText,
    };
  }
}

function triggerEnvironment(
  context: TriggerExecutionContext,
  endpoints: ProgramEndpoints,
  eventFile: string,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of [
    "HOME",
    "LANG",
    "LC_ALL",
    "NODE_EXTRA_CA_CERTS",
    "PATH",
    "SHELL",
    "TERM",
    "TMPDIR",
    "USER",
  ] as const) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  environment.OPENSTEER_EVENT_PATH = eventFile;
  environment.OPENSTEER_MCP_URL = endpoints.mcp.url;
  environment.OPENSTEER_MCP_TOKEN = endpoints.mcp.token;
  environment.OPENSTEER_INTEGRATION_MCP_URL = endpoints.integrationMcp.url;
  environment.OPENSTEER_INTEGRATION_MCP_TOKEN = endpoints.integrationMcp.token;
  environment.OPENSTEER_OCCURRENCE_ID = context.occurrenceId;
  environment.OPENSTEER_TRIGGER_ID = context.triggerId;
  environment.OPENSTEER_WORKSPACE_ID = context.workspaceId;
  if (endpoints.browserCdp) {
    environment.OPENSTEER_CDP_URL = endpoints.browserCdp.url;
    environment.OPENSTEER_CDP_TOKEN = endpoints.browserCdp.token;
  }
  return environment;
}
async function writePrivateFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  await writeFile(path, content, { flag: "wx", mode: 0o600 });
  await setPrivateFileMode(path);
}

async function collectBounded(
  stream: NodeJS.ReadableStream | null,
  maximumBytes: number,
): Promise<string> {
  if (!stream) return "";
  const chunks: Buffer[] = [];
  let retainedBytes = 0;
  let truncated = false;
  for await (const raw of stream) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    chunks.push(chunk);
    retainedBytes += chunk.byteLength;
    while (retainedBytes > maximumBytes && chunks.length > 0) {
      const removed = chunks.shift();
      if (removed) retainedBytes -= removed.byteLength;
      truncated = true;
    }
  }
  if (truncated) {
    // The marker counts against the same limit, so a truncated stream can
    // never exceed the bound the protocol schema enforces.
    const markerBytes = Buffer.byteLength(truncationMarker, "utf8");
    while (retainedBytes + markerBytes > maximumBytes && chunks.length > 0) {
      const removed = chunks.shift();
      if (removed) retainedBytes -= removed.byteLength;
    }
    return `${truncationMarker}${Buffer.concat(chunks).toString("utf8")}`;
  }
  return Buffer.concat(chunks).toString("utf8");
}

function readablePipe(
  stream: ReturnType<typeof spawn>["stdio"][number],
): NodeJS.ReadableStream | null {
  if (stream === null || stream === undefined) return null;
  if (!("readable" in stream)) throw new Error("Trigger result pipe is not readable");
  return stream;
}

function parseProgramResult(
  value: string,
): { readonly error: string; readonly ok: false } | { readonly ok: true; readonly value: unknown } {
  if (!value) return { error: "Trigger program returned no execution result", ok: false };
  try {
    const parsed = JSON.parse(value) as { ok?: unknown; error?: unknown; value?: unknown };
    if (parsed.ok === true) return { ok: true, value: parsed.value ?? null };
    if (parsed.ok === false && typeof parsed.error === "string") {
      return { error: parsed.error.slice(0, 20_000), ok: false };
    }
  } catch {
    // The normalized failure below is enough; stdout and stderr remain available.
  }
  return { error: "Trigger program returned an invalid execution result", ok: false };
}

function terminateChild(child: ReturnType<typeof spawn>): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const timer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, 5_000);
  timer.unref();
}

function assertChildPath(root: string, child: string): void {
  const path = relative(resolve(root), resolve(child));
  if (!path || path.startsWith("..") || resolve(root, path) !== resolve(child)) {
    throw new Error("Trigger execution directory escaped its Workspace");
  }
}
