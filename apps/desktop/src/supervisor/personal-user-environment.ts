import { harnessCatalog } from "@opensteer/core";
import { selectEnvironment } from "@opensteer/shared/userEnvironment";
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { userInfo, type UserInfo } from "node:os";
import path from "node:path";
import { z } from "zod";

const environmentSentinel = "__OPENSTEER_LOGIN_ENV_V1__";
const maximumProbeBytes = 1 * 1_024 * 1_024;
const defaultProbeTimeoutMs = 4_000;
const maximumProbeTimeoutMs = 5_000;
const maximumWindowsVariableLength = 32_767;
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
  readonly powershell: string;
  readonly timeoutMs: number;
}

export type WindowsRegistryProbe = (spec: WindowsRegistryProbeSpec) => Promise<Buffer>;

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
      const output = await this.#registryProbe({
        environment: inherited,
        maximumOutputBytes: maximumProbeBytes,
        powershell: windowsPowerShellExecutable(inherited),
        timeoutMs: this.#timeoutMs,
      });
      registry = parseWindowsRegistryEnvironment(output);
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
 * Reads machine then user environment values with their registry kinds,
 * unexpanded, as UTF-8 JSON. The bytes go to the raw standard output stream so
 * the encoding never depends on a console code page.
 */
const windowsRegistryScript = [
  "$ErrorActionPreference='Stop'",
  "$entries=New-Object System.Collections.Generic.List[object]",
  "foreach($scope in @(@('machine',[Microsoft.Win32.Registry]::LocalMachine,'System\\CurrentControlSet\\Control\\Session Manager\\Environment'),@('user',[Microsoft.Win32.Registry]::CurrentUser,'Environment'))){$key=$scope[1].OpenSubKey($scope[2]);if($null -eq $key){continue};try{foreach($name in $key.GetValueNames()){if($name -eq ''){continue};$kind=$key.GetValueKind($name);if($kind -ne [Microsoft.Win32.RegistryValueKind]::String -and $kind -ne [Microsoft.Win32.RegistryValueKind]::ExpandString){continue};$entries.Add([pscustomobject]@{scope=$scope[0];name=$name;kind=$kind.ToString();value=[string]$key.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)})}}finally{$key.Close()}}",
  "$bytes=(New-Object System.Text.UTF8Encoding $false).GetBytes((ConvertTo-Json -InputObject $entries.ToArray() -Compress))",
  "$stdout=[Console]::OpenStandardOutput()",
  "$stdout.Write($bytes,0,$bytes.Length)",
  "$stdout.Flush()",
].join(";");

export async function probeWindowsRegistryEnvironment(
  spec: WindowsRegistryProbeSpec,
): Promise<Buffer> {
  return runBoundedProbe(
    spec.powershell,
    ["-NoProfile", "-NonInteractive", "-Command", windowsRegistryScript],
    spec,
    {
      description: "Windows registry environment",
      failure: "Windows PowerShell could not read the registry environment",
    },
  );
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
    child.once("exit", (code, signal) => {
      if (code === 0) finish();
      else {
        finish(
          new PersonalUserEnvironmentError(`${messages.failure} (${signal ?? `exit ${code}`}).`),
        );
      }
    });
  });
}

export function parseWindowsRegistryEnvironment(output: Uint8Array): WindowsRegistryValue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(output));
  } catch (error) {
    throw new PersonalUserEnvironmentError(
      "Windows PowerShell did not return a readable registry environment.",
      { cause: error },
    );
  }
  const values = windowsRegistryValuesSchema.safeParse(parsed);
  if (!values.success) {
    throw new PersonalUserEnvironmentError(
      "Windows PowerShell returned an unrecognized registry environment.",
    );
  }
  return values.data;
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

function windowsPathKey(entry: string): string {
  const unquoted = entry.trim().replace(/^"(.*)"$/u, "$1");
  if (!unquoted) return "";
  const normalized = path.win32.normalize(unquoted);
  const trimmed = /^[A-Za-z]:\\$/u.test(normalized) ? normalized : normalized.replace(/\\+$/u, "");
  return trimmed.toLowerCase();
}

function windowsPowerShellExecutable(environment: Readonly<Record<string, string>>): string {
  const systemRoot = Object.entries(environment).find(
    ([name]) => name.toUpperCase() === "SYSTEMROOT",
  )?.[1];
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new PersonalUserEnvironmentError("SystemRoot does not name the Windows directory.");
  }
  return path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
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
    !executablePath.split(paths.delimiter).some((entry) => paths.isAbsolute(entry))
  ) {
    throw new PersonalUserEnvironmentError(
      `The ${source} did not provide a usable executable PATH for local agents.`,
    );
  }
  return Object.freeze({ ...environment, PATH: executablePath });
}
