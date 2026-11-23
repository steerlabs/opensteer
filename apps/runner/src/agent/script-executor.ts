import { programEnvironment, spawnSupervised } from "@opensteer/harness";
import type { ThreadId, TriggerId, TriggerOccurrenceId } from "@opensteer/core";
import { NativeFsHelper, NativeFsHelperError } from "@opensteer/shared/files/native-fs-helper";
import { setPrivateDirectoryMode, setPrivateFileMode } from "@opensteer/shared/privateFiles";
import {
  assertAutomationSecretsWithinBounds,
  assertValidInterpreterExecutable,
  automationSecretEnvName,
  AutomationSecretValueSchema,
  isBareInterpreterName,
  MAX_OUTPUT_TAIL_BYTES,
  normalizeScriptText,
  scriptFileExtension,
  type AutomationScript,
  type TriggerExecutionOutput,
} from "@opensteer/triggers";
import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants, existsSync, statSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessProcessLaunchWrapper } from "@opensteer/harness";
import type { AgentHomeWorkspace } from "../folders/agent-home.js";

/** What an automation script reaches Opensteer through: the Runner's stand-ins, never Host tokens. */
export interface ProgramEndpoints {
  readonly browserCdp?: { readonly token: string; readonly url: string };
  readonly mcp: { readonly token: string; readonly url: string };
}

/** Plans one automation launch, given its private directory and environment. */
export type ProgramLaunchPlanner = (input: {
  readonly environment: Readonly<Record<string, string>>;
  readonly privateDirectory: string;
  /** Optional result file path in `privateDirectory`. */
  readonly resultFile?: string;
  readonly workspacePath: string;
}) => Promise<HarnessProcessLaunchWrapper>;

const truncationMarker = "\n[Opensteer truncated earlier process output]\n";

/**
 * Resolves the shipped `opensteer` CLI script and launcher bin directory from
 * either the bundled `dist/main.js` layout (`../cli`, `../bin`) or the source
 * `src/agent/` layout (`../../cli`, `../../bin`), while honoring explicit
 * environment overrides (`OPENSTEER_CLI`, `OPENSTEER_CLI_BIN_DIR`) such as the
 * container image's `/app/cli/opensteer-cli.mjs` (Z2).
 */
export function resolveAutomationCliPaths(
  moduleUrl: string = import.meta.url,
  environment: NodeJS.ProcessEnv = process.env,
): { readonly cliBinDirectory: string; readonly cliScriptPath: string } {
  const envCli = environment.OPENSTEER_CLI?.trim();
  const envBin = environment.OPENSTEER_CLI_BIN_DIR?.trim();

  const bundledScript = fileURLToPath(new URL("../cli/opensteer-cli.mjs", moduleUrl));
  const sourceScript = fileURLToPath(new URL("../../cli/opensteer-cli.mjs", moduleUrl));
  const cliScriptPath =
    envCli && isAbsolute(envCli)
      ? resolve(envCli)
      : existsSync(bundledScript)
        ? resolve(bundledScript)
        : existsSync(sourceScript)
          ? resolve(sourceScript)
          : resolve(bundledScript);

  const bundledBin = fileURLToPath(new URL("../bin", moduleUrl));
  const sourceBin = fileURLToPath(new URL("../../bin", moduleUrl));
  const siblingBin = resolve(dirname(cliScriptPath), "../bin");
  const cliBinDirectory =
    envBin && isAbsolute(envBin)
      ? resolve(envBin)
      : existsSync(bundledBin)
        ? resolve(bundledBin)
        : existsSync(siblingBin)
          ? siblingBin
          : existsSync(sourceBin)
            ? resolve(sourceBin)
            : resolve(bundledBin);

  return { cliBinDirectory, cliScriptPath };
}

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
  readonly taskId?: ThreadId;
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
    const defaults = resolveAutomationCliPaths(
      import.meta.url,
      options.baseEnvironment ?? process.env,
    );
    this.#cliBinDirectory = resolve(options.cliBinDirectory ?? defaults.cliBinDirectory);
    this.#cliScriptPath = resolve(options.cliScriptPath ?? defaults.cliScriptPath);
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
    const privateExecutionRoot = resolve(
      this.#privateDirectory,
      `${input.firingId}-${randomUUID()}`,
    );
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

      const executable = input.script.interpreter
        ? resolveInterpreterExecutable(
            input.script.interpreter[0]!,
            environment.PATH ?? "",
            environment.PATHEXT,
          )
        : this.#nodeExecutable;
      const args = input.script.interpreter
        ? [...input.script.interpreter.slice(1), scriptFile]
        : [scriptFile];

      const wrap = await input.planLaunch({
        environment,
        privateDirectory: privateExecutionRoot,
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
    // Z11: drop empty, `.`, and relative PATH entries so Agent home in cwd can never hijack commands.
    const absolutePathEntries = (environment.PATH ?? "")
      .split(delimiter)
      .filter((entry) => entry.length > 0 && isAbsolute(entry));
    environment.PATH = [this.#cliBinDirectory, ...absolutePathEntries].join(delimiter);
    if (input.secrets) {
      assertAutomationSecretsWithinBounds(input.secrets);
      for (const [name, value] of Object.entries(input.secrets)) {
        AutomationSecretValueSchema.parse(value);
        environment[automationSecretEnvName(name)] = value;
      }
    }
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
    return environment;
  }
}

export function resolveInterpreterExecutable(
  executable: string,
  pathEnv: string,
  pathextEnv: string | undefined,
): string {
  assertValidInterpreterExecutable(executable);
  if (!isBareInterpreterName(executable)) return executable;
  const directories = pathEnv
    .split(delimiter)
    .filter((entry) => entry.length > 0 && isAbsolute(entry));
  const extensions =
    process.platform === "win32"
      ? ["", ...(pathextEnv ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => ext.length > 0)]
      : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(directory, `${executable}${extension}`);
      try {
        const info = statSync(candidate);
        if (!info.isFile()) continue;
        if (process.platform !== "win32") accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Try next directory/extension.
      }
    }
  }
  throw new Error(`Interpreter "${executable}" was not found on PATH.`);
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
