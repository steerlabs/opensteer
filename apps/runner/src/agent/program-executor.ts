import { programEnvironment, spawnSupervised } from "@opensteer/harness";
import {
  readBoundedRegularFile,
  setPrivateDirectoryMode,
  setPrivateFileMode,
} from "@opensteer/shared/privateFiles";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import type { HarnessProcessLaunchWrapper } from "@opensteer/harness";
import type { TriggerExecutionContext } from "@opensteer/protocol";
import type { TriggerExecutionOutput } from "@opensteer/triggers";
import type { AgentHomeWorkspace } from "../folders/agent-home.js";
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
  readonly mcp: { readonly token: string; readonly url: string };
}

/** Confines one program launch, given its private directory and environment. */
export type ProgramLaunchPlanner = (input: {
  readonly environment: Readonly<Record<string, string>>;
  readonly privateDirectory: string;
  /** The one file in `privateDirectory` the program writes: its execution result. */
  readonly resultFile?: string;
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
    readonly workspace: AgentHomeWorkspace;
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
    const resultFile = join(privateExecutionRoot, "result.json");
    await mkdir(privateExecutionRoot, { mode: 0o700, recursive: true });
    await setPrivateDirectoryMode(privateExecutionRoot);
    try {
      await Promise.all([
        writePrivateFile(programFile, context.program.source),
        writePrivateFile(runtimeFile, triggerProgramRuntimeSource(pathToFileURL(programFile).href)),
        writePrivateFile(eventFile, JSON.stringify(context.event)),
        // Created empty so a sandbox can bind exactly this file writable.
        writePrivateFile(resultFile, ""),
      ]);
      return await this.#run({
        context,
        eventFile,
        input,
        privateExecutionRoot,
        resultFile,
        runtimeFile,
      });
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
      readonly workspace: AgentHomeWorkspace;
    };
    readonly privateExecutionRoot: string;
    readonly resultFile: string;
    readonly runtimeFile: string;
  }): Promise<TriggerExecutionOutput> {
    const environment = triggerEnvironment(input.context, input.input.endpoints, input);
    const args = ["--enable-source-maps"];
    if (input.context.program.language === "typescript") {
      args.push("--experimental-transform-types");
    }
    args.push(input.runtimeFile);
    const wrap = await input.input.planLaunch({
      environment,
      privateDirectory: input.privateExecutionRoot,
      resultFile: input.resultFile,
      workspacePath: input.input.workspace.path,
    });
    const launch = wrap({
      args,
      cwd: input.input.workspace.path,
      environment,
      executable: this.#nodeExecutable,
    });
    const child = spawnSupervised({
      ...launch,
      output: "raw",
      stdin: "closed",
    });
    const stdout = collectBounded(child.stdout, streamByteLimit);
    const stderr = collectBounded(child.stderr, streamByteLimit);
    const stop = () => void child.terminate().catch(() => undefined);
    if (input.input.signal.aborted) stop();
    else input.input.signal.addEventListener("abort", stop, { once: true });
    // The supervisor exits only once nothing it started is left, so the result is final.
    const exit = await child.exited.finally(() =>
      input.input.signal.removeEventListener("abort", stop),
    );
    const [stdoutText, stderrText] = await Promise.all([stdout, stderr]);
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
    const programResult = await readProgramResult(input.resultFile);
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
  files: { readonly eventFile: string; readonly resultFile: string },
): Record<string, string> {
  const environment = programEnvironment();
  environment.OPENSTEER_EVENT_PATH = files.eventFile;
  environment.OPENSTEER_RESULT_PATH = files.resultFile;
  environment.OPENSTEER_MCP_URL = endpoints.mcp.url;
  environment.OPENSTEER_MCP_TOKEN = endpoints.mcp.token;
  environment.OPENSTEER_OCCURRENCE_ID = context.occurrenceId;
  environment.OPENSTEER_TRIGGER_ID = context.triggerId;
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
  stream: AsyncIterable<Buffer>,
  maximumBytes: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let retainedBytes = 0;
  let truncated = false;
  for await (const chunk of stream) {
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

type ProgramResult =
  { readonly error: string; readonly ok: false } | { readonly ok: true; readonly value: unknown };

const invalidResult: ProgramResult = {
  error: "Trigger program returned an invalid execution result",
  ok: false,
};

/** Read once the program's whole tree has stopped, so nothing can still be writing it. */
async function readProgramResult(resultFile: string): Promise<ProgramResult> {
  let bytes: Buffer | null;
  try {
    const refused = () => new Error("Trigger result file refused");
    bytes = await readBoundedRegularFile(resultFile, resultByteLimit, {
      changedError: refused,
      invalidFileError: refused,
      missing: "null",
      sizeError: refused,
    });
  } catch {
    // Replaced by something other than a regular file, or larger than a result may be.
    return invalidResult;
  }
  return parseProgramResult(bytes?.toString("utf8") ?? "");
}

function parseProgramResult(value: string): ProgramResult {
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
  return invalidResult;
}

function assertChildPath(root: string, child: string): void {
  const path = relative(resolve(root), resolve(child));
  if (!path || path.startsWith("..") || resolve(root, path) !== resolve(child)) {
    throw new Error("Trigger execution directory escaped its Workspace");
  }
}
