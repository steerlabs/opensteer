import { harnessCatalog } from "@opensteer/core";
import { spawn } from "node:child_process";
import { userInfo, type UserInfo } from "node:os";
import path from "node:path";

const environmentSentinel = "__OPENSTEER_LOGIN_ENV_V1__";
const maximumProbeBytes = 1 * 1_024 * 1_024;
const defaultProbeTimeoutMs = 4_000;
const maximumProbeTimeoutMs = 5_000;

/**
 * What a login shell may hand an Opensteer process. Each engine's own
 * configuration home comes from its harness catalog entry, so adding an engine
 * does not mean remembering this list.
 */
const allowedEnvironmentNames = new Set([
  "APPDATA",
  ...harnessCatalog.flatMap((entry) => entry.userEnvironmentVariables),
  "GH_CONFIG_DIR",
  "GIT_CONFIG_GLOBAL",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "LOGNAME",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SSH_AUTH_SOCK",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
]);

export interface PersonalUserEnvironmentPort {
  resolve(): Promise<Readonly<Record<string, string>>>;
}

export interface LoginShellProbeSpec {
  readonly environment: Readonly<Record<string, string>>;
  readonly maximumOutputBytes: number;
  readonly shell: string;
  readonly timeoutMs: number;
}

export type LoginShellProbe = (spec: LoginShellProbeSpec) => Promise<Buffer>;

export class PersonalUserEnvironmentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PersonalUserEnvironmentError";
  }
}

/**
 * Resolves the environment a person receives in a login terminal without
 * importing arbitrary secrets from shell startup files. Resolution is cached
 * for the Desktop process lifetime; a later Thread launch never reruns shell
 * startup code.
 */
export class NativePersonalUserEnvironment implements PersonalUserEnvironmentPort {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #platform: NodeJS.Platform;
  readonly #probe: LoginShellProbe;
  readonly #timeoutMs: number;
  readonly #userInfo: () => UserInfo<string>;
  #resolved: Promise<Readonly<Record<string, string>>> | undefined;

  constructor(
    options: {
      readonly environment?: NodeJS.ProcessEnv;
      readonly platform?: NodeJS.Platform;
      readonly probe?: LoginShellProbe;
      readonly timeoutMs?: number;
      readonly userInfo?: () => UserInfo<string>;
    } = {},
  ) {
    this.#environment = options.environment ?? process.env;
    this.#platform = options.platform ?? process.platform;
    this.#probe = options.probe ?? probeLoginShell;
    this.#timeoutMs = options.timeoutMs ?? defaultProbeTimeoutMs;
    if (
      !Number.isSafeInteger(this.#timeoutMs) ||
      this.#timeoutMs < 1 ||
      this.#timeoutMs > maximumProbeTimeoutMs
    ) {
      throw new TypeError(
        `Login-shell environment timeout must be from 1 through ${maximumProbeTimeoutMs}.`,
      );
    }
    this.#userInfo = options.userInfo ?? (() => userInfo({ encoding: "utf8" }));
  }

  resolve(): Promise<Readonly<Record<string, string>>> {
    this.#resolved ??= this.#resolve();
    return this.#resolved;
  }

  async #resolve(): Promise<Readonly<Record<string, string>>> {
    if (this.#platform === "win32") {
      return requireUsablePath(filterUserEnvironment(this.#environment), "Windows account");
    }
    const account = this.#userInfo();
    const shell = account.shell?.trim();
    if (!shell || !path.isAbsolute(shell) || shell.length > 4_096 || /\p{Control}/u.test(shell)) {
      throw new PersonalUserEnvironmentError(
        "Opensteer could not determine this account's login shell for local agents.",
      );
    }
    const startEnvironment = filterUserEnvironment(this.#environment);
    startEnvironment.HOME = account.homedir;
    startEnvironment.LOGNAME = account.username;
    startEnvironment.USER = account.username;
    startEnvironment.SHELL = shell;
    startEnvironment.PATH = "/usr/bin:/bin";
    let output: Buffer;
    try {
      output = await this.#probe({
        environment: startEnvironment,
        maximumOutputBytes: maximumProbeBytes,
        shell,
        timeoutMs: this.#timeoutMs,
      });
    } catch (error) {
      if (error instanceof PersonalUserEnvironmentError) throw error;
      throw new PersonalUserEnvironmentError(
        "Opensteer could not read the login-shell environment for local agents.",
        { cause: error },
      );
    }
    const resolved = parseLoginShellEnvironment(output);
    resolved.HOME = account.homedir;
    resolved.LOGNAME = account.username;
    resolved.USER = account.username;
    resolved.SHELL = shell;
    return requireUsablePath(resolved, "login shell");
  }
}

export class FixedPersonalUserEnvironment implements PersonalUserEnvironmentPort {
  readonly #environment: Readonly<Record<string, string>>;

  constructor(environment: Readonly<Record<string, string>>) {
    this.#environment = requireUsablePath(filterUserEnvironment(environment), "configured account");
  }

  async resolve(): Promise<Readonly<Record<string, string>>> {
    return this.#environment;
  }
}

export async function probeLoginShell(spec: LoginShellProbeSpec): Promise<Buffer> {
  return new Promise<Buffer>((resolvePromise, rejectPromise) => {
    const child = spawn(
      spec.shell,
      ["-l", "-c", `printf '${environmentSentinel}\\0'; /usr/bin/env -0`],
      {
        env: { ...spec.environment },
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    );
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise(Buffer.concat(chunks, total));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new PersonalUserEnvironmentError("The login-shell environment probe timed out."));
    }, spec.timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > spec.maximumOutputBytes) {
        child.kill("SIGKILL");
        finish(
          new PersonalUserEnvironmentError("The login-shell environment response is too large."),
        );
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (code === 0) finish();
      else {
        finish(
          new PersonalUserEnvironmentError(
            `The login shell could not prepare local agents (${signal ?? `exit ${code}`}).`,
          ),
        );
      }
    });
  });
}

export function parseLoginShellEnvironment(output: Uint8Array): Record<string, string> {
  const bytes = Buffer.from(output);
  const sentinel = Buffer.from(`${environmentSentinel}\0`, "utf8");
  const start = bytes.indexOf(sentinel);
  if (start === -1) {
    throw new PersonalUserEnvironmentError(
      "The login shell did not return a recognizable environment.",
    );
  }
  const environment: Record<string, string> = {};
  for (const entry of bytes
    .subarray(start + sentinel.byteLength)
    .toString("utf8")
    .split("\0")) {
    const equals = entry.indexOf("=");
    if (equals < 1) continue;
    const name = entry.slice(0, equals);
    const value = entry.slice(equals + 1);
    if (!allowedEnvironmentNames.has(name) || value.length > 32_768 || value.includes("\0")) {
      continue;
    }
    environment[name] = value;
  }
  return environment;
}

/**
 * The one allowlist for every environment the Desktop hands a child process —
 * the login-shell probe, the Windows account read, and the Personal stack's
 * own base environment. Names outside it are the person's secrets, not the
 * Deployment's configuration.
 */
export function filterUserEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    [...allowedEnvironmentNames].flatMap((name) => {
      const value = source[name];
      return value && value.length <= 32_768 ? [[name, value] as const] : [];
    }),
  );
}

function requireUsablePath(
  environment: Record<string, string>,
  source: string,
): Readonly<Record<string, string>> {
  const executablePath = environment.PATH?.trim();
  const delimiters = executablePath?.includes(";") ? ";" : path.delimiter;
  if (
    !executablePath ||
    !executablePath
      .split(delimiters)
      .some((entry) => path.isAbsolute(entry) || /^[A-Za-z]:[\\/]/u.test(entry))
  ) {
    throw new PersonalUserEnvironmentError(
      `The ${source} did not provide a usable executable PATH for local agents.`,
    );
  }
  return Object.freeze({ ...environment, PATH: executablePath });
}
