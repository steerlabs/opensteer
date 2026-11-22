import { programEnvironment, spawnSupervised } from "@opensteer/harness";
import type { TriggerId, TriggerOccurrenceId } from "@opensteer/core";
import { NativeFsHelper, NativeFsHelperError } from "@opensteer/shared/files/native-fs-helper";
import { setPrivateDirectoryMode, setPrivateFileMode } from "@opensteer/shared/privateFiles";
import {
  MAX_OUTPUT_TAIL_BYTES,
  normalizeScriptText,
  scriptFileExtension,
  type AutomationScript,
  type TriggerExecutionOutput,
} from "@opensteer/triggers";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentHomeWorkspace } from "../folders/agent-home.js";
import type { ProgramEndpoints, ProgramLaunchPlanner } from "./program-executor.js";

const truncationMarker = "\n[Opensteer truncated earlier process output]\n";

const defaultCliBinDirectory = fileURLToPath(new URL("../../bin", import.meta.url));
const defaultCliScriptPath = fileURLToPath(new URL("../../cli/opensteer-cli.mjs", import.meta.url));

export interface AutomationScriptEvent {
  readonly automationId: TriggerId;
  readonly firedAt: string;
  readonly firingId: TriggerOccurrenceId;
  readonly kind: "manual" | "schedule" | "watch" | "webhook";
  readonly payload?: unknown;
  readonly request?: {
    readonly headers: Readonly<Record<string, string>>;
    readonly method: string;
    readonly path: string;
    readonly query: Readonly<Record<string, string | readonly string[]>>;
  };
  readonly scheduledFor?: string;
}

export interface AutomationScriptExecutorOptions {
  readonly baseEnvironment?: NodeJS.ProcessEnv;
  readonly cliBinDirectory?: string;
  readonly cliScriptPath?: string;
  readonly nativeFsHelperBinary: string;
  readonly nodeExecutable: string;
  readonly privateDirectory?: string;
}

/**
 * Wrapperless script executor (T3, T6, Y1, Y2, Y15):
 * - Spawns `interpreter[0]` (default: Node) with `[...interpreter.slice(1), scriptFile]`,
 *   never relying on `+x` or kernel `#!` so `noexec` volumes and Windows always work.
 * - Normalizes CRLF/CR on POSIX, prepends the Runner's `opensteer` CLI bin dir to `PATH`,
 *   writes raw webhook bytes to a sibling `body` file (no `bodyUtf8` copy), and injects
 *   per-automation sealed secrets solely into the process environment.
 */
export class AutomationScriptExecutor {
  readonly #baseEnvironment: NodeJS.ProcessEnv | undefined;
  readonly #cliBinDirectory: string;
  readonly #cliScriptPath: string;
  readonly #nativeFs: NativeFsHelper;
  readonly #nodeExecutable: string;
  readonly #privateDirectory: string;

  constructor(options: AutomationScriptExecutorOptions) {
    this.#baseEnvironment = options.baseEnvironment;
    this.#cliBinDirectory = resolve(options.cliBinDirectory ?? defaultCliBinDirectory);
    this.#cliScriptPath = resolve(options.cliScriptPath ?? defaultCliScriptPath);
    this.#nativeFs = new NativeFsHelper({ binary: options.nativeFsHelperBinary });
    this.#nodeExecutable = options.nodeExecutable;
    this.#privateDirectory = resolve(
      options.privateDirectory ?? join(tmpdir(), "opensteer-automation-scripts"),
    );
  }

  async execute(input: {
    readonly automationId: TriggerId;
    readonly endpoints: ProgramEndpoints;
    readonly event: AutomationScriptEvent;
    readonly firingId: TriggerOccurrenceId;
    readonly planLaunch: ProgramLaunchPlanner;
    readonly script: AutomationScript;
    readonly secrets?: Readonly<Record<string, string>> | undefined;
    readonly signal: AbortSignal;
    readonly webhookBody?: Buffer | null;
    readonly workspace: AgentHomeWorkspace;
  }): Promise<TriggerExecutionOutput> {
    const privateExecutionRoot = resolve(this.#privateDirectory, input.firingId);
    assertChildPath(this.#privateDirectory, privateExecutionRoot);

    const extension = scriptFileExtension(input.script.interpreter);
    const scriptFile = join(privateExecutionRoot, `script${extension}`);
    const eventFile = join(privateExecutionRoot, "event.json");
    const bodyFile =
      input.webhookBody !== undefined && input.webhookBody !== null
        ? join(privateExecutionRoot, "body")
        : undefined;

    await this.#nativeFs
      .ensurePrivateRoot(this.#privateDirectory, input.signal)
      .catch((error: unknown) => {
        if (error instanceof NativeFsHelperError && error.code === "unsafe-permissions") {
          throw new Error(
            `Automation script directory ${this.#privateDirectory} is open to other accounts on this computer`,
            { cause: error },
          );
        }
        throw error;
      });
    await mkdir(privateExecutionRoot, { mode: 0o700 });
    await setPrivateDirectoryMode(privateExecutionRoot);

    const eventDocument =
      input.event.request !== undefined
        ? {
            ...input.event,
            request: {
              ...input.event.request,
              bodyBytes: input.webhookBody ? input.webhookBody.byteLength : 0,
              ...(bodyFile ? { bodyPath: bodyFile } : {}),
            },
          }
        : input.event;

    try {
      const normalized = normalizeScriptText(input.script.text, process.platform);
      const writes: Promise<void>[] = [
        writePrivateFile(scriptFile, normalized),
        writePrivateFile(eventFile, JSON.stringify(eventDocument)),
      ];
      if (bodyFile && input.webhookBody) {
        writes.push(writePrivateBytes(bodyFile, input.webhookBody));
      }
      await Promise.all(writes);

      const environment = this.#scriptEnvironment({
        automationId: input.automationId,
        endpoints: input.endpoints,
        eventFile,
        firingId: input.firingId,
        secrets: input.secrets,
      });

      const executable = input.script.interpreter?.[0] ?? this.#nodeExecutable;
      const args = input.script.interpreter
        ? [...input.script.interpreter.slice(1), scriptFile]
        : [scriptFile];

      const readOnlyDirectories = [this.#cliBinDirectory, dirname(this.#cliScriptPath)];
      const wrap = await input.planLaunch({
        environment,
        privateDirectory: privateExecutionRoot,
        readOnlyDirectories,
        workspacePath: input.workspace.path,
      });
      const launch = wrap({
        args,
        cwd: input.workspace.path,
        environment,
        executable,
      });
      const child = spawnSupervised({
        ...launch,
        output: "raw",
        stdin: "closed",
      });
      const stdout = collectBounded(child.stdout, MAX_OUTPUT_TAIL_BYTES);
      const stderr = collectBounded(child.stderr, MAX_OUTPUT_TAIL_BYTES);
      const stop = () => void child.terminate().catch(() => undefined);
      if (input.signal.aborted) stop();
      else input.signal.addEventListener("abort", stop, { once: true });

      const exit = await child.exited.finally(() =>
        input.signal.removeEventListener("abort", stop),
      );
      const [stdoutText, stderrText] = await Promise.all([stdout, stderr]);
      const completedAt = new Date().toISOString();

      if (input.signal.aborted) {
        return {
          completedAt,
          error: "Automation firing was canceled",
          exitCode: exit.code,
          occurrenceId: input.firingId,
          result: null,
          status: "canceled",
          stderr: stderrText,
          stdout: stdoutText,
        };
      }
      if (exit.code === 0) {
        return {
          completedAt,
          error: null,
          exitCode: 0,
          occurrenceId: input.firingId,
          result: null,
          status: "succeeded",
          stderr: stderrText,
          stdout: stdoutText,
        };
      }
      return {
        completedAt,
        error: exit.signal
          ? `Automation script ended from ${exit.signal}`
          : `Automation script exited with code ${String(exit.code)}`,
        exitCode: exit.code,
        occurrenceId: input.firingId,
        result: null,
        status: "failed",
        stderr: stderrText,
        stdout: stdoutText,
      };
    } finally {
      await rm(privateExecutionRoot, { force: true, recursive: true }).catch(() => undefined);
    }
  }

  #scriptEnvironment(input: {
    readonly automationId: TriggerId;
    readonly endpoints: ProgramEndpoints;
    readonly eventFile: string;
    readonly firingId: TriggerOccurrenceId;
    readonly secrets?: Readonly<Record<string, string>> | undefined;
  }): Record<string, string> {
    const environment = programEnvironment(this.#baseEnvironment ?? process.env);
    const existingPath = environment.PATH ?? "";
    environment.PATH = existingPath
      ? `${this.#cliBinDirectory}${delimiter}${existingPath}`
      : this.#cliBinDirectory;
    environment.OPENSTEER_AUTOMATION_ID = input.automationId;
    environment.OPENSTEER_CLI = this.#cliScriptPath;
    environment.OPENSTEER_EVENT = input.eventFile;
    environment.OPENSTEER_FIRING_ID = input.firingId;
    environment.OPENSTEER_MCP_TOKEN = input.endpoints.mcp.token;
    environment.OPENSTEER_MCP_URL = input.endpoints.mcp.url;
    environment.OPENSTEER_NODE = this.#nodeExecutable;
    if (input.endpoints.browserCdp) {
      environment.OPENSTEER_CDP_TOKEN = input.endpoints.browserCdp.token;
      environment.OPENSTEER_CDP_URL = input.endpoints.browserCdp.url;
    }
    if (input.secrets) {
      for (const [name, value] of Object.entries(input.secrets)) {
        environment[name] = value;
      }
    }
    return environment;
  }
}

async function writePrivateFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  await writeFile(path, content, { flag: "wx", mode: 0o600 });
  await setPrivateFileMode(path);
}

async function writePrivateBytes(path: string, content: Buffer): Promise<void> {
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  await writeFile(path, content, { flag: "wx", mode: 0o600 });
  await setPrivateFileMode(path);
}

async function collectBounded(
  stream: AsyncIterable<Buffer>,
  maximumBytes: number,
): Promise<string> {
  const markerBytes = Buffer.byteLength(truncationMarker, "utf8");
  const tailBudget = Math.max(0, maximumBytes - markerBytes);
  let tail: Buffer = Buffer.alloc(0);
  let truncated = false;
  for await (const chunk of stream) {
    if (chunk.byteLength === 0) continue;
    const combined = tail.byteLength === 0 ? chunk : Buffer.concat([tail, chunk]);
    if (combined.byteLength > maximumBytes) {
      truncated = true;
      tail = combined.subarray(combined.byteLength - tailBudget);
    } else if (truncated && combined.byteLength > tailBudget) {
      tail = combined.subarray(combined.byteLength - tailBudget);
    } else {
      tail = combined;
    }
  }
  if (truncated) {
    let start = 0;
    while (start < tail.byteLength && (tail[start]! & 0xc0) === 0x80) start += 1;
    const sliced = start > 0 ? tail.subarray(start) : tail;
    return `${truncationMarker}${sliced.toString("utf8")}`;
  }
  return tail.toString("utf8");
}

function assertChildPath(root: string, child: string): void {
  const path = relative(resolve(root), resolve(child));
  if (!path || path.startsWith("..") || resolve(root, path) !== resolve(child)) {
    throw new Error("Automation script directory escaped its private root");
  }
}
