import { harnessCatalog } from "@opensteer/core";
import { networkEnvironmentNames } from "@opensteer/shared/safeMessage";
import { selectEnvironment } from "@opensteer/shared/userEnvironment";
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir, userInfo, type UserInfo } from "node:os";
import path from "node:path";
import { z } from "zod";

const environmentSentinel = "__OPENSTEER_LOGIN_ENV_V1__";
const maximumProbeBytes = 1 * 1_024 * 1_024;
const defaultProbeTimeoutMs = 4_000;
const maximumProbeTimeoutMs = 5_000;
const maximumWindowsVariableLength = 32_767;
/**
 * A registry export runs in tens of milliseconds; this bound only ends a reg.exe that hangs, and
 * no slow or cold PC plausibly reaches it.
 */
const windowsRegistryTimeoutMs = 30_000;
/** One key's export: a long PATH as hex(2) text in UTF-16 is about 400 KB. */
const maximumWindowsRegistryExportBytes = 8 * 1_024 * 1_024;
/** The pause before an export that failed is tried once more. */
const windowsRegistryRetryPauseMs = 250;
const maximumRegistryStderrBytes = 4_096;
/** The keys a new logon's environment comes from: the machine's, then the person's. */
const windowsEnvironmentKeys = {
  machine: "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
  user: "HKEY_CURRENT_USER\\Environment",
} as const;
const maximumExpansionDepth = 32;

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
  // How an engine reaches the network, so it works behind a company proxy as
  // it does in the person's own terminal. A proxy address can carry a
  // password; nothing prints these values.
  ...networkEnvironmentNames,
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

export interface WindowsRegistryProbeSpec {
  readonly environment: Readonly<Record<string, string>>;
  readonly maximumOutputBytes: number;
  /** `%SystemRoot%\System32\reg.exe`. */
  readonly reg: string;
  readonly timeoutMs: number;
  /** Where a retried export and a temporary directory left behind are told. */
  readonly log?: (event: string, fields: Readonly<Record<string, unknown>>) => void;
}

/** Each environment key as `reg.exe export` writes it: a .reg file in UTF-16LE. */
export interface WindowsRegistryExports {
  readonly machine: Uint8Array;
  readonly user: Uint8Array;
}

export type WindowsRegistryProbe = (
  spec: WindowsRegistryProbeSpec,
) => Promise<WindowsRegistryExports>;

const windowsRegistryValuesSchema = z
  .array(
    z.strictObject({
      kind: z.enum(["String", "ExpandString"]),
      name: z.string().min(1).max(16_383),
      scope: z.enum(["machine", "user"]),
      value: z.string(),
    }),
  )
  .max(16_384);

export type WindowsRegistryValue = z.infer<typeof windowsRegistryValuesSchema>[number];

export class PersonalUserEnvironmentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PersonalUserEnvironmentError";
  }
}

/**
 * Resolves the environment a person receives in a new terminal without
 * importing arbitrary secrets from shell startup files or running a Windows
 * profile. Resolution happens once per Desktop process, so PATH changes made
 * later reach local agents after Opensteer restarts.
 */
export class NativePersonalUserEnvironment implements PersonalUserEnvironmentPort {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #isDirectory: (directory: string) => boolean;
  readonly #log: (event: string, fields: Readonly<Record<string, unknown>>) => void;
  readonly #platform: NodeJS.Platform;
  readonly #probe: LoginShellProbe;
  readonly #registryProbe: WindowsRegistryProbe;
  readonly #timeoutMs: number;
  readonly #userInfo: () => UserInfo<string>;
  #resolved: Promise<Readonly<Record<string, string>>> | undefined;

  constructor(
    options: {
      readonly environment?: NodeJS.ProcessEnv;
      readonly isDirectory?: (directory: string) => boolean;
      readonly log?: (event: string, fields: Readonly<Record<string, unknown>>) => void;
      readonly platform?: NodeJS.Platform;
      readonly probe?: LoginShellProbe;
      readonly registryProbe?: WindowsRegistryProbe;
      readonly timeoutMs?: number;
      readonly userInfo?: () => UserInfo<string>;
    } = {},
  ) {
    this.#environment = options.environment ?? process.env;
    this.#isDirectory = options.isDirectory ?? isDirectory;
    this.#log =
      options.log ?? ((event, fields) => console.warn(JSON.stringify({ event, ...fields })));
    this.#platform = options.platform ?? process.platform;
    this.#probe = options.probe ?? probeLoginShell;
    this.#registryProbe = options.registryProbe ?? probeWindowsRegistryEnvironment;
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
    if (this.#platform === "win32") return this.#resolveWindows();
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

  async #resolveWindows(): Promise<Readonly<Record<string, string>>> {
    const inherited = definedEnvironment(this.#environment);
    let registry: readonly WindowsRegistryValue[] = [];
    try {
      const exports = await this.#registryProbe({
        environment: inherited,
        maximumOutputBytes: maximumWindowsRegistryExportBytes,
        reg: windowsRegExecutable(inherited),
        timeoutMs: windowsRegistryTimeoutMs,
        log: this.#log,
      });
      registry = parseWindowsRegistryEnvironment(exports);
    } catch (error) {
      this.#log("personal.user_environment.windows_registry_unavailable", {
        detail:
          "Opensteer could not read the Windows registry environment, so local agents get only the environment Opensteer started with. Tools installed since sign-in may be missing until you sign out and back in.",
        error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      });
    }
    return requireUsablePath(
      filterUserEnvironment(
        composeWindowsEnvironment({ inherited, isDirectory: this.#isDirectory, registry }),
        "win32",
      ),
      "Windows account",
      "win32",
    );
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
  return runBoundedProbe(
    spec.shell,
    ["-l", "-c", `printf '${environmentSentinel}\\0'; /usr/bin/env -0`],
    spec,
    {
      description: "login-shell environment",
      failure: "The login shell could not prepare local agents",
    },
  );
}

/**
 * Exports the machine's and the person's environment keys with `reg.exe export`, which writes
 * each as a .reg file whose bytes are defined: UTF-16LE with a byte-order mark, and every
 * REG_EXPAND_SZ value as its unexpanded UTF-16LE bytes (`hex(2):`). Nothing goes through a
 * console code page, and no PowerShell starts.
 *
 * One export at a time, each into a file of its own: each takes tens of milliseconds, and no
 * reg.exe is ever still writing when the next starts or when the directory goes. An export that
 * fails is tried once more, after a pause and into a new file, with why it failed logged: a
 * scanner that opens a .reg file the moment it is written can hold it. Its failure names the
 * key and carries what reg.exe said. The temporary directory is removed only once every reg.exe
 * has ended, and its removal never decides the read: it is retried, then logged if it stays.
 */
export async function probeWindowsRegistryEnvironment(
  spec: WindowsRegistryProbeSpec,
): Promise<WindowsRegistryExports> {
  const log = spec.log ?? (() => undefined);
  // The long form of the directory (not an 8.3 name such as OPENST~1) is what reg.exe is given.
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "opensteer-environment-")));
  try {
    let files = 0;
    const exportKey = async (scope: keyof typeof windowsEnvironmentKeys) => {
      const key = windowsEnvironmentKeys[scope];
      for (let attempt = 1; ; attempt++) {
        const file = path.join(directory, `${scope}-${++files}.reg`);
        const ended = await runWindowsRegistryExport(spec, key, file);
        if (ended.kind === "exported") {
          let size: number;
          try {
            size = (await stat(file)).size;
          } catch (missing) {
            throw new PersonalUserEnvironmentError(
              `Windows could not export the registry environment (reg.exe export ${key} wrote no file: ${(missing as NodeJS.ErrnoException).code ?? "unknown"}).`,
              { cause: missing },
            );
          }
          if (size > spec.maximumOutputBytes) {
            throw new PersonalUserEnvironmentError(
              "The Windows registry environment response is too large.",
            );
          }
          return readFile(file);
        }
        if (ended.kind === "timed-out") {
          throw new PersonalUserEnvironmentError(
            "The Windows registry environment probe timed out.",
          );
        }
        const reason = `reg.exe export ${key} ended with ${ended.status}${ended.said ? `: ${ended.said}` : ""}`;
        if (attempt === 2) {
          throw new PersonalUserEnvironmentError(
            `Windows could not export the registry environment (${reason}).`,
          );
        }
        log("personal.user_environment.windows_registry_export_retried", { key, reason });
        await new Promise((resolvePause) => setTimeout(resolvePause, windowsRegistryRetryPauseMs));
      }
    };
    const machine = await exportKey("machine");
    const user = await exportKey("user");
    return { machine, user };
  } finally {
    try {
      await rm(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
    } catch (cleanup) {
      log("personal.user_environment.windows_registry_cleanup_failed", {
        code: (cleanup as NodeJS.ErrnoException).code ?? "unknown",
        directory,
      });
    }
  }
}

type WindowsRegistryExportEnd =
  | { readonly kind: "exported" }
  | { readonly kind: "timed-out" }
  | { readonly kind: "failed"; readonly said: string; readonly status: string };

/**
 * Runs one `reg.exe export` and settles only once the process has ended, so its file is closed:
 * a reg.exe stopped at the bound is waited for too, up to a few seconds more.
 */
function runWindowsRegistryExport(
  spec: WindowsRegistryProbeSpec,
  key: string,
  file: string,
): Promise<WindowsRegistryExportEnd> {
  return new Promise<WindowsRegistryExportEnd>((resolvePromise) => {
    const child = spawn(spec.reg, ["export", key, file, "/y"], {
      env: { ...spec.environment },
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= maximumRegistryStderrBytes) return;
      stderr.push(chunk);
      stderrBytes += chunk.byteLength;
    });
    let settled = false;
    let timedOut = false;
    let abandon: ReturnType<typeof setTimeout> | undefined;
    const settle = (end: WindowsRegistryExportEnd) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(abandon);
      resolvePromise(end);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      abandon = setTimeout(() => settle({ kind: "timed-out" }), 5_000);
      abandon.unref?.();
    }, spec.timeoutMs);
    timer.unref?.();
    child.once("error", (error) =>
      settle({
        kind: "failed",
        said: "",
        status: (error as NodeJS.ErrnoException).code ?? "an error",
      }),
    );
    child.once("close", (code, signal) => {
      if (timedOut) settle({ kind: "timed-out" });
      else if (code === 0) settle({ kind: "exported" });
      else
        settle({
          kind: "failed",
          said: registryStderr(Buffer.concat(stderr)),
          status: signal ?? `exit ${code}`,
        });
    });
  });
}

/**
 * What reg.exe said, for the log: its own words, in one line and bounded. reg.exe writes in the
 * console's code page; text that is not UTF-8 shows as replacement characters, never as bytes.
 */
function registryStderr(bytes: Buffer): string {
  return new TextDecoder("utf-8")
    .decode(bytes.subarray(0, maximumRegistryStderrBytes))
    .replace(/[\p{Control}\s]+/gu, " ")
    .trim()
    .slice(0, 300);
}

function runBoundedProbe(
  executable: string,
  args: readonly string[],
  spec: {
    readonly environment: Readonly<Record<string, string>>;
    readonly maximumOutputBytes: number;
    readonly timeoutMs: number;
  },
  messages: { readonly description: string; readonly failure: string },
): Promise<Buffer> {
  return new Promise<Buffer>((resolvePromise, rejectPromise) => {
    const child = spawn(executable, [...args], {
      env: { ...spec.environment },
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
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
      finish(new PersonalUserEnvironmentError(`The ${messages.description} probe timed out.`));
    }, spec.timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > spec.maximumOutputBytes) {
        child.kill("SIGKILL");
        finish(
          new PersonalUserEnvironmentError(`The ${messages.description} response is too large.`),
        );
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", (error) => finish(error));
    // `close` follows the end of stdout; `exit` can arrive while output is still queued.
    child.once("close", (code, signal) => {
      if (code === 0) finish();
      else {
        finish(
          new PersonalUserEnvironmentError(`${messages.failure} (${signal ?? `exit ${code}`}).`),
        );
      }
    });
  });
}

/**
 * The machine's then the person's REG_SZ and REG_EXPAND_SZ values, unexpanded, from their
 * exports. Other kinds, the unnamed default value and subkeys are not environment variables.
 */
export function parseWindowsRegistryEnvironment(
  exports: WindowsRegistryExports,
): WindowsRegistryValue[] {
  const values = windowsRegistryValuesSchema.safeParse([
    ...parseRegistryExport(exports.machine, windowsEnvironmentKeys.machine, "machine"),
    ...parseRegistryExport(exports.user, windowsEnvironmentKeys.user, "user"),
  ]);
  if (!values.success) {
    throw new PersonalUserEnvironmentError(
      "Windows returned an unrecognized registry environment.",
    );
  }
  return values.data;
}

/**
 * Reads one key's values from a .reg export as reg.exe and regedit write it: a UTF-16LE
 * byte-order mark, `Windows Registry Editor Version 5.00`, then `[key]` sections of
 * `"name"=data` lines, CRLF between lines. A name or REG_SZ data is quoted with `\\` and `\"`
 * escaped; other data is `dword:`, or `hex:`/`hex(n):` comma-separated bytes that wrap onto
 * indented lines after a trailing backslash. `hex(2)` is REG_EXPAND_SZ and `hex(1)` a REG_SZ
 * regedit could not quote, both UTF-16LE; Windows reads either up to its first NUL.
 */
function parseRegistryExport(
  bytes: Uint8Array,
  key: string,
  scope: WindowsRegistryValue["scope"],
): WindowsRegistryValue[] {
  const unreadable = (cause?: unknown) =>
    new PersonalUserEnvironmentError("Windows did not return a readable registry environment.", {
      cause,
    });
  if (bytes[0] !== 0xff || bytes[1] !== 0xfe) throw unreadable();
  let text: string;
  try {
    text = new TextDecoder("utf-16le", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch (error) {
    throw unreadable(error);
  }
  const header = "Windows Registry Editor Version 5.00";
  if (!text.startsWith(header)) throw unreadable();
  const values: WindowsRegistryValue[] = [];
  let section: string | undefined;
  let sawKey = false;
  let at = header.length;
  const fail = () => unreadable(new Error(`Malformed .reg data at character ${at}.`));
  const quoted = () => {
    // At an opening quote: the text up to the closing one, unescaped.
    let value = "";
    at++;
    for (;;) {
      const char = text[at];
      if (char === undefined) throw fail();
      at++;
      if (char === '"') return value;
      if (char === "\\" && (text[at] === "\\" || text[at] === '"')) {
        value += text[at];
        at++;
      } else value += char;
    }
  };
  const restOfLine = () => {
    const end = text.indexOf("\n", at);
    const line = text.slice(at, end === -1 ? text.length : end).replace(/\r$/u, "");
    at = end === -1 ? text.length : end + 1;
    return line;
  };
  while (at < text.length) {
    const char = text[at];
    if (char === "\r" || char === "\n" || char === " " || char === "\t") {
      at++;
      continue;
    }
    if (char === "[") {
      const line = restOfLine();
      if (!line.endsWith("]")) throw fail();
      section = line.slice(1, -1);
      if (section.toLowerCase() === key.toLowerCase()) sawKey = true;
      continue;
    }
    if (char !== '"' && char !== "@") throw fail();
    const name = char === "@" ? (at++, "") : quoted();
    if (text[at] !== "=") throw fail();
    at++;
    let kind: WindowsRegistryValue["kind"] | undefined;
    let value: string | undefined;
    if (text[at] === '"') {
      kind = "String";
      value = quoted();
      const trailing = restOfLine();
      if (trailing.trim()) throw fail();
    } else {
      let data = restOfLine();
      // A hex list wraps: a line that ends with a backslash continues on the next, indented.
      while (data.endsWith("\\")) data = data.slice(0, -1) + restOfLine().trimStart();
      const hex = /^hex(?:\(([0-9a-f]+)\))?:([0-9a-f,\s]*)$/iu.exec(data);
      if (hex) {
        const type = hex[1] === undefined ? 3 : Number.parseInt(hex[1], 16);
        const list = hex[2]!.replace(/\s/gu, "");
        const pairs = list ? list.split(",") : [];
        if (pairs.some((pair) => !/^[0-9a-f]{2}$/iu.test(pair))) throw fail();
        if (type === 1 || type === 2) {
          kind = type === 2 ? "ExpandString" : "String";
          const raw = Uint8Array.from(pairs, (pair) => Number.parseInt(pair, 16));
          const decoded = new TextDecoder("utf-16le").decode(
            raw.subarray(0, raw.byteLength - (raw.byteLength % 2)),
          );
          const nul = decoded.indexOf("\0");
          value = nul === -1 ? decoded : decoded.slice(0, nul);
        }
      } else if (!/^dword:[0-9a-f]{8}$/iu.test(data)) throw fail();
    }
    if (
      kind !== undefined &&
      value !== undefined &&
      name !== "" &&
      section?.toLowerCase() === key.toLowerCase()
    ) {
      values.push({ kind, name, scope, value });
    }
  }
  if (!sawKey) throw unreadable();
  return values;
}

/**
 * What a new terminal would see, without a profile: registry values over the
 * inherited ones. PATH is machine, then user, then inherited entries the
 * registry lacks (injected toolchains survive), then existing CLI directories.
 */
export function composeWindowsEnvironment(input: {
  readonly inherited: Readonly<Record<string, string>>;
  readonly isDirectory: (directory: string) => boolean;
  readonly registry: readonly WindowsRegistryValue[];
}): Record<string, string> {
  const environment = new Map<string, readonly [string, string]>();
  for (const [name, value] of Object.entries(input.inherited)) {
    environment.set(name.toUpperCase(), [name, value]);
  }
  const expand = windowsRegistryExpansion(input.inherited, input.registry);
  const registryPath: string[] = [];
  for (const scope of ["machine", "user"] as const) {
    for (const entry of input.registry) {
      if (entry.scope !== scope) continue;
      const key = entry.name.toUpperCase();
      if (key === "PATH") {
        registryPath.push(expand(entry));
        continue;
      }
      environment.set(key, [environment.get(key)?.[0] ?? entry.name, expand(entry)]);
    }
  }
  const value = (name: string) => environment.get(name.toUpperCase())?.[1] || undefined;
  const under = (root: string | undefined, ...segments: string[]) =>
    root && path.win32.isAbsolute(root) ? [path.win32.join(root, ...segments)] : [];
  const conventional = [
    ...under(value("APPDATA"), "npm"),
    ...(value("PNPM_HOME") ? under(value("PNPM_HOME")) : under(value("LOCALAPPDATA"), "pnpm")),
    ...(value("VOLTA_HOME")
      ? under(value("VOLTA_HOME"), "bin")
      : under(value("LOCALAPPDATA"), "Volta", "bin")),
    ...under(value("USERPROFILE"), ".local", "bin"),
    ...under(value("LOCALAPPDATA"), "Microsoft", "WinGet", "Links"),
    ...under(value("USERPROFILE"), "scoop", "shims"),
  ];
  const entries: string[] = [];
  const seen = new Set<string>();
  const add = (entry: string) => {
    const key = windowsPathKey(entry);
    if (!key || seen.has(key)) return;
    seen.add(key);
    entries.push(entry.trim());
  };
  for (const list of [...registryPath, value("PATH") ?? ""]) {
    for (const entry of list.split(";")) add(entry);
  }
  for (const directory of conventional) {
    if (!seen.has(windowsPathKey(directory)) && input.isDirectory(directory)) add(directory);
  }
  environment.set("PATH", ["PATH", entries.join(";")]);
  return Object.fromEntries(environment.values());
}

/**
 * Expands only REG_EXPAND_SZ values, the way the logon environment does:
 * `%NAME%` takes the registry value (user over machine, itself expanded) or
 * the inherited one. A self-reference, a cycle, an unknown name or a result
 * longer than an environment variable can hold stays literal.
 */
function windowsRegistryExpansion(
  inherited: Readonly<Record<string, string>>,
  registry: readonly WindowsRegistryValue[],
): (entry: WindowsRegistryValue) => string {
  const inheritedValues = new Map(
    Object.entries(inherited).map(([name, value]) => [name.toUpperCase(), value]),
  );
  const definitions = new Map<string, WindowsRegistryValue>();
  for (const scope of ["machine", "user"] as const) {
    for (const entry of registry) {
      if (entry.scope === scope && entry.name.toUpperCase() !== "PATH") {
        definitions.set(entry.name.toUpperCase(), entry);
      }
    }
  }
  const resolved = new Map<string, string | undefined>();
  const resolving = new Set<string>();
  const expandEntry = (entry: WindowsRegistryValue, depth: number): string => {
    if (entry.kind === "String") return entry.value;
    const owner = entry.name.toUpperCase();
    const expanded = entry.value.replace(/%([^%;]+)%/gu, (literal, name: string) => {
      const key = name.toUpperCase();
      if (key === owner) return literal;
      return lookup(key, depth + 1) ?? literal;
    });
    return expanded.length <= maximumWindowsVariableLength ? expanded : entry.value;
  };
  const lookup = (key: string, depth: number): string | undefined => {
    const definition = definitions.get(key);
    if (!definition) return inheritedValues.get(key);
    if (resolved.has(key)) return resolved.get(key);
    if (resolving.has(key) || depth > maximumExpansionDepth) return undefined;
    resolving.add(key);
    const value = expandEntry(definition, depth);
    resolving.delete(key);
    resolved.set(key, value);
    return value;
  };
  return (entry) => expandEntry(entry, 0);
}

function unquotedPathEntry(entry: string): string {
  return entry.trim().replace(/^"(.*)"$/u, "$1");
}

function windowsPathKey(entry: string): string {
  const unquoted = unquotedPathEntry(entry);
  if (!unquoted) return "";
  const normalized = path.win32.normalize(unquoted);
  const trimmed = /^[A-Za-z]:\\$/u.test(normalized) ? normalized : normalized.replace(/\\+$/u, "");
  return trimmed.toLowerCase();
}

function windowsRegExecutable(environment: Readonly<Record<string, string>>): string {
  const systemRoot = Object.entries(environment).find(
    ([name]) => name.toUpperCase() === "SYSTEMROOT",
  )?.[1];
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new PersonalUserEnvironmentError("SystemRoot does not name the Windows directory.");
  }
  return path.win32.join(systemRoot, "System32", "reg.exe");
}

function definedEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function isDirectory(directory: string): boolean {
  try {
    return statSync(directory).isDirectory();
  } catch {
    return false;
  }
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
 * own base environment — plus the Windows baseline on Windows. Names outside
 * it are the person's secrets, not the Deployment's configuration.
 */
export function filterUserEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(selectEnvironment(source, allowedEnvironmentNames, platform)).filter(
      ([, value]) => value.length <= 32_768,
    ),
  );
}

function requireUsablePath(
  environment: Record<string, string>,
  source: string,
  platform: NodeJS.Platform = process.platform,
): Readonly<Record<string, string>> {
  const executablePath = environment.PATH?.trim();
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (
    !executablePath ||
    !executablePath
      .split(paths.delimiter)
      .some((entry) => paths.isAbsolute(platform === "win32" ? unquotedPathEntry(entry) : entry))
  ) {
    throw new PersonalUserEnvironmentError(
      `The ${source} did not provide a usable executable PATH for local agents.`,
    );
  }
  return Object.freeze({ ...environment, PATH: executablePath });
}
