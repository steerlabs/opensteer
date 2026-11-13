import {
  accessSync,
  closeSync,
  constants,
  lstatSync,
  openSync,
  readlinkSync,
  readSync,
  statSync,
} from "node:fs";
import path from "node:path";

export type CommandPlatform = "darwin" | "linux" | "win32";

/** The platform this process runs on, for resolving the commands it starts. */
export function hostCommandPlatform(platform: NodeJS.Platform = process.platform): CommandPlatform {
  if (platform === "darwin" || platform === "linux" || platform === "win32") return platform;
  throw new Error(`Opensteer does not run commands on ${platform}.`);
}

type Environment = Readonly<Record<string, string | undefined>>;

/** Filesystem facts the resolver needs, injected so every platform's rules are testable anywhere. */
export interface CommandProbes {
  isFile(path: string): boolean;
  /** POSIX: a regular file this process may execute. Windows: a regular file. */
  isExecutable(path: string): boolean;
  /** A Windows app execution alias: an OS-managed link that runs but cannot be opened. */
  isExecutionAlias(path: string): boolean;
  /** At most `bytes` bytes from the start of a file; undefined when it cannot be read. */
  readStart(path: string, bytes: number): Uint8Array | undefined;
}

export interface ResolvedCommand {
  /** Absolute, as found: an execution alias is kept, never canonicalized. */
  readonly path: string;
  /** `batch-shim`: a batch file npm or pnpm generated, which only forwards `%*` to its program. */
  readonly kind: "native" | "batch" | "batch-shim" | "powershell";
}

export interface LaunchPlan {
  readonly executable: string;
  readonly args: readonly string[];
  /** The complete command line for a batch launch through cmd.exe, argv[0] included. */
  readonly windowsCommandLine?: string;
}

const windowsKinds: Readonly<Record<string, ResolvedCommand["kind"]>> = {
  ".bat": "batch",
  ".cmd": "batch",
  ".com": "native",
  ".exe": "native",
  ".ps1": "powershell",
};
const defaultWindowsExtensions = ".COM;.EXE;.BAT;.CMD";

export const nodeCommandProbes: CommandProbes = {
  isFile,
  isExecutable: (candidate) => {
    if (!isFile(candidate)) return false;
    if (process.platform === "win32") return true;
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  // Node reads an APPEXECLINK reparse point as a link, but opening it fails;
  // a dangling ordinary link instead fails as missing.
  isExecutionAlias: (candidate) => {
    try {
      if (!lstatSync(candidate).isSymbolicLink()) return false;
      readlinkSync(candidate);
    } catch {
      return false;
    }
    try {
      statSync(candidate);
      return false;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code !== "ENOENT" && code !== "ENOTDIR" && code !== "ELOOP";
    }
  },
  readStart: (candidate, bytes) => {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(candidate, "r");
      const buffer = Buffer.alloc(bytes);
      return buffer.subarray(0, readSync(descriptor, buffer, 0, bytes, 0));
    } catch {
      return undefined;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  },
};

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * A variable as the child would see it. Windows names are case-insensitive;
 * when an object holds several spellings, Node's spawn keeps the first in sort
 * order, so that one is the child's.
 */
export function getEnvironmentValue(
  environment: Environment,
  name: string,
  platform: CommandPlatform,
): string | undefined {
  if (platform !== "win32") return environment[name];
  const wanted = name.toUpperCase();
  const key = Object.keys(environment)
    .filter(
      (candidate) => candidate.toUpperCase() === wanted && environment[candidate] !== undefined,
    )
    .sort()[0];
  return key === undefined ? undefined : environment[key];
}

/**
 * The file `command` names for a child with this environment and working
 * directory. A name with a separator is a path from `cwd`; a bare name is
 * looked up on PATH, whose empty and relative entries are skipped because
 * they would depend on the Runner's own directory.
 */
export function resolveCommand(
  command: string,
  options: {
    readonly platform: CommandPlatform;
    readonly environment: Environment;
    readonly cwd: string;
    readonly probes?: CommandProbes;
  },
): ResolvedCommand | undefined {
  if (!command || command.includes("\0")) return undefined;
  const probes = options.probes ?? nodeCommandProbes;
  return options.platform === "win32"
    ? resolveWindowsCommand(command, options.environment, options.cwd, probes)
    : resolvePosixCommand(command, options.environment, options.cwd, probes);
}

function resolvePosixCommand(
  command: string,
  environment: Environment,
  cwd: string,
  probes: CommandProbes,
): ResolvedCommand | undefined {
  const { posix } = path;
  const native = (candidate: string) =>
    probes.isExecutable(candidate) ? { kind: "native" as const, path: candidate } : undefined;
  if (command.includes("/")) return native(posix.resolve(cwd, command));
  for (const directory of (environment.PATH ?? "").split(":")) {
    if (!posix.isAbsolute(directory)) continue;
    const found = native(posix.join(directory, command));
    if (found) return found;
  }
  return undefined;
}

function resolveWindowsCommand(
  command: string,
  environment: Environment,
  cwd: string,
  probes: CommandProbes,
): ResolvedCommand | undefined {
  const { win32 } = path;
  // `C:tool` names the current directory of drive C, which a child has no stable notion of.
  if (/^[A-Za-z]:(?![\\/])/u.test(command)) return undefined;
  const extensions = (
    getEnvironmentValue(environment, "PATHEXT", "win32") || defaultWindowsExtensions
  )
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => extension !== ".ps1" && windowsKinds[extension] !== undefined);
  const find = (base: string): ResolvedCommand | undefined => {
    const named = windowsKinds[win32.extname(base).toLowerCase()];
    if (named) return probeWindows(base, named, probes);
    for (const extension of extensions) {
      const found = probeWindows(base + extension, windowsKinds[extension]!, probes);
      if (found) return found;
    }
    return undefined;
  };
  if (/[\\/]/u.test(command)) return find(win32.resolve(cwd, command));
  const pathValue = getEnvironmentValue(environment, "PATH", "win32") ?? "";
  for (const entry of pathValue.split(";")) {
    const directory = entry.replaceAll('"', "").trim();
    if (!isFullyQualifiedWindowsPath(directory)) continue;
    const found = find(win32.join(directory, command));
    if (found) return found;
  }
  return undefined;
}

function probeWindows(
  candidate: string,
  kind: ResolvedCommand["kind"],
  probes: CommandProbes,
): ResolvedCommand | undefined {
  if (probes.isFile(candidate)) {
    const shim =
      kind === "batch" && isForwardingShim(probes.readStart(candidate, shimByteLimit + 1));
    return { kind: shim ? "batch-shim" : kind, path: candidate };
  }
  if (kind === "native" && probes.isExecutionAlias(candidate)) return { kind, path: candidate };
  return undefined;
}

const shimByteLimit = 16 * 1024;
const shimPreambles = [
  // npm's cmd-shim 4 through 9.
  "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n",
  // pnpm's @zkochan/cmd-shim 5 through 9.
  "@SETLOCAL\r\n",
];

/**
 * A generator's preamble, and the script's parameters reach it only as its
 * own folder (`%~dp0`) and a trailing `%*` that cmd parses once more before
 * the program reads its argv.
 */
function isForwardingShim(start: Uint8Array | undefined): boolean {
  if (!start || start.length > shimByteLimit) return false;
  const text = new TextDecoder().decode(start);
  if (!shimPreambles.some((preamble) => text.startsWith(preamble))) return false;
  const parameters = (text.match(/%(?:~[^0-9\s%]*)?[0-9*]/gu) ?? []).map((parameter) =>
    parameter.toLowerCase(),
  );
  return (
    parameters.includes("%*") &&
    parameters.every((parameter) => parameter === "%~dp0" || parameter === "%*") &&
    !/(?<! )%\*|%\*(?!\r\n|$)/u.test(text)
  );
}

function isFullyQualifiedWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) || /^[\\/]{2}[^\\/]/u.test(value);
}

/**
 * How to start `resolved` with `args`. Call it once, after every wrapper has
 * added its arguments: a batch launch serializes them into a single cmd.exe
 * command line.
 */
export function planLaunch(
  resolved: ResolvedCommand,
  args: readonly string[],
  options: { readonly platform: CommandPlatform; readonly environment: Environment },
): LaunchPlan {
  if (resolved.kind === "native") return { args: [...args], executable: resolved.path };
  if (options.platform !== "win32")
    throw new Error(
      `${resolved.path} is a Windows ${resolved.kind === "powershell" ? "PowerShell" : "batch"} script.`,
    );
  const system32 = path.win32.join(windowsSystemRoot(options.environment), "System32");
  if (resolved.kind === "powershell") {
    return {
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        resolved.path,
        ...args,
      ],
      executable: path.win32.join(system32, "WindowsPowerShell", "v1.0", "powershell.exe"),
    };
  }
  return {
    args: [],
    executable: path.win32.join(system32, "cmd.exe"),
    windowsCommandLine: batchCommandLine(resolved.path, args, resolved.kind === "batch-shim"),
  };
}

/**
 * How to run `command` as shell source, the way the computer runs an app's
 * start string: `/bin/sh -c` on POSIX, `cmd.exe /d /s /c` on Windows. The
 * text is the author's own shell code, so it is quoted for cmd's outer pair
 * only and never escaped as one argument; `/s` strips exactly that pair.
 */
export function planShellLaunch(
  command: string,
  options: { readonly platform: CommandPlatform; readonly environment: Environment },
): LaunchPlan {
  if (options.platform !== "win32") return { args: ["-c", command], executable: "/bin/sh" };
  if (/[\0\r\n]/u.test(command))
    throw new Error("cmd.exe cannot run a command that contains NUL or a line break.");
  return {
    args: [],
    executable: path.win32.join(windowsSystemRoot(options.environment), "System32", "cmd.exe"),
    windowsCommandLine: `cmd.exe /d /s /c "${command}"`,
  };
}

function windowsSystemRoot(environment: Environment): string {
  const root = getEnvironmentValue(environment, "SystemRoot", "win32");
  if (!root || !isFullyQualifiedWindowsPath(root))
    throw new Error("A Windows shell or script needs SystemRoot in the environment it runs with.");
  return root;
}

/**
 * `cmd.exe /d /s /v:off /c "<script> <args>"`. `/s` strips just the outer
 * quotes, and every quote inside is caret-escaped so cmd never enters a
 * quoted run where a caret would stay literal.
 */
function batchCommandLine(script: string, args: readonly string[], shim: boolean): string {
  if (/["%\0\r\n]/u.test(script))
    throw new Error(`cmd.exe cannot run a script whose path contains ", %, or a line break.`);
  const escaped = args.map((argument) => {
    if (/[\0\r\n]/u.test(argument))
      throw new Error("cmd.exe cannot pass an argument that contains NUL or a line break.");
    return shim ? shimArgument(argument) : batchParameter(argument);
  });
  return `cmd.exe /d /s /v:off /c ""${script}"${escaped.map((argument) => ` ${argument}`).join("")}"`;
}

const cmdMetacharacters = /[ \t"%!^&|<>(),;=]/gu;

/**
 * Quoted for the program the shim runs, then escaped twice: once for this
 * line and once for the shim's line that expands `%*`.
 */
function shimArgument(argument: string): string {
  return quoteWindowsArgument(argument).replace(cmdMetacharacters, "^^^$&");
}

/**
 * The batch file reads `%~1` back as `argument`. A parameter is quoted when
 * cmd or the batch's own splitting would act on it; nothing can escape a
 * quote inside one.
 */
function batchParameter(argument: string): string {
  if (argument.includes('"'))
    throw new Error("A batch file cannot receive an argument that contains a double quote.");
  const parameter =
    argument === "" || /[\s,;=&|<>()^%!]/u.test(argument) ? `"${argument}"` : argument;
  return parameter.replace(cmdMetacharacters, "^$&");
}

/** The quoting CommandLineToArgvW and the MSVC runtime read back as `argument`. */
function quoteWindowsArgument(argument: string): string {
  if (argument !== "" && !/[ \t\v"]/u.test(argument)) return argument;
  let quoted = '"';
  let backslashes = 0;
  for (const character of argument) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    quoted += "\\".repeat(character === '"' ? backslashes * 2 + 1 : backslashes) + character;
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}
