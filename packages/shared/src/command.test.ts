import { describe, expect, it } from "vitest";
import {
  getEnvironmentValue,
  planLaunch,
  planShellLaunch,
  resolveCommand,
  type CommandProbes,
  type ResolvedCommand,
} from "./command.js";
import { generatedShims } from "./commandShims.test-support.js";

/** NTFS compares names without case. */
function windowsDisk(
  files: readonly string[],
  aliases: readonly string[] = [],
  contents: Readonly<Record<string, string>> = {},
): CommandProbes {
  const has = (list: readonly string[], candidate: string) =>
    list.some((file) => file.toLowerCase() === candidate.toLowerCase());
  return {
    isExecutable: (candidate) => has(files, candidate),
    isExecutionAlias: (candidate) => has(aliases, candidate),
    isFile: (candidate) => has(files, candidate),
    readStart: (candidate, bytes) =>
      contents[candidate] === undefined
        ? undefined
        : Buffer.from(contents[candidate]).subarray(0, bytes),
  };
}

function posixDisk(executables: readonly string[], plainFiles: readonly string[] = []) {
  return {
    isExecutable: (candidate: string) => executables.includes(candidate),
    isExecutionAlias: () => false,
    isFile: (candidate: string) =>
      executables.includes(candidate) || plainFiles.includes(candidate),
    readStart: () => undefined,
  } satisfies CommandProbes;
}

function onWindows(
  command: string,
  environment: Record<string, string>,
  probes: CommandProbes,
  cwd = "C:\\work",
) {
  return resolveCommand(command, { cwd, environment, platform: "win32", probes })?.path;
}

describe("resolveCommand on Windows", () => {
  it.each([
    {
      name: "a quoted PATH entry",
      path: '"C:\\Program Files\\Tool";C:\\other',
      files: ["C:\\Program Files\\Tool\\tool.exe", "C:\\other\\tool.exe"],
      expected: "C:\\Program Files\\Tool\\tool.exe",
    },
    {
      name: "past empty, relative, drive-relative and root-relative entries",
      path: ";bin;.;C:tools;\\tools;D:\\found",
      files: [
        "C:\\work\\bin\\tool.exe",
        "C:\\work\\tool.exe",
        "C:\\tools\\tool.exe",
        "D:\\found\\tool.exe",
      ],
      expected: "D:\\found\\tool.exe",
    },
    {
      name: "on a UNC entry",
      path: "\\\\server\\share\\bin",
      files: ["\\\\server\\share\\bin\\tool.cmd"],
      expected: "\\\\server\\share\\bin\\tool.cmd",
    },
    {
      name: "never in the working directory for a bare name",
      path: "D:\\elsewhere",
      files: ["C:\\work\\tool.exe"],
      expected: undefined,
    },
    {
      name: "with PATHEXT order inside one directory before the next directory",
      path: "C:\\a;C:\\b",
      pathext: ".CMD;.EXE",
      files: ["C:\\a\\tool.exe", "C:\\a\\tool.cmd", "C:\\b\\tool.cmd"],
      expected: "C:\\a\\tool.cmd",
    },
    {
      name: "with the default PATHEXT order when none is set",
      path: "C:\\a",
      pathext: "",
      files: ["C:\\a\\tool.bat", "C:\\a\\tool.exe", "C:\\a\\tool.com"],
      expected: "C:\\a\\tool.com",
    },
    {
      name: "only for kinds that can run, even when PATHEXT lists more",
      path: "C:\\a",
      pathext: ".PS1;.JS;.VBS;.CMD",
      files: ["C:\\a\\tool.ps1", "C:\\a\\tool.js", "C:\\a\\tool.vbs", "C:\\a\\tool.cmd"],
      expected: "C:\\a\\tool.cmd",
    },
    {
      name: "never as PowerShell through PATHEXT",
      path: "C:\\a",
      pathext: ".PS1",
      files: ["C:\\a\\tool.ps1"],
      expected: undefined,
    },
  ])("finds a command $name", ({ path, pathext, files, expected }) => {
    expect(
      onWindows(
        "tool",
        { PATH: path, ...(pathext === undefined ? {} : { PATHEXT: pathext }) },
        windowsDisk(files),
      ),
    ).toBe(expected);
  });

  it.each([
    ["tool.exe", ["C:\\a\\tool.exe", "C:\\a\\tool.exe.cmd"], "C:\\a\\tool.exe", "native"],
    ["tool.CMD", ["C:\\a\\tool.CMD.exe", "C:\\a\\tool.CMD"], "C:\\a\\tool.CMD", "batch"],
    ["tool.ps1", ["C:\\a\\tool.ps1"], "C:\\a\\tool.ps1", "powershell"],
    ["python3.12", ["C:\\a\\python3.12.exe"], "C:\\a\\python3.12.exe", "native"],
  ] as const)("takes %s's own executable extension as named", (command, files, path, kind) => {
    expect(
      resolveCommand(command, {
        cwd: "C:\\work",
        environment: { PATH: "C:\\a" },
        platform: "win32",
        probes: windowsDisk(files),
      }),
    ).toEqual({ kind, path });
  });

  it.each([
    [".\\tool", "C:\\work\\tool.cmd"],
    ["./tool", "C:\\work\\tool.cmd"],
    ["sub\\tool", "C:\\work\\sub\\tool.cmd"],
    ["..\\tool", "C:\\tool.cmd"],
    ["D:\\bin\\tool", "D:\\bin\\tool.cmd"],
    ["D:/bin/tool.cmd", "D:\\bin\\tool.cmd"],
    ["\\\\server\\share\\tool", "\\\\server\\share\\tool.cmd"],
    ["\\bin\\tool", "C:\\bin\\tool.cmd"],
  ])("resolves the path %s from the working directory, not PATH", (command, expected) => {
    const files = [expected, "C:\\path\\tool.cmd"];
    expect(onWindows(command, { PATH: "C:\\path" }, windowsDisk(files))).toBe(expected);
  });

  it("rejects a drive-relative command, whose directory the child cannot know", () => {
    expect(onWindows("C:tool.exe", { PATH: "C:\\" }, windowsDisk(["C:\\work\\tool.exe"]))).toBe(
      undefined,
    );
  });

  it("reads Path and PATHEXT in any case", () => {
    expect(
      onWindows("tool", { PathExt: ".BAT", Path: "C:\\a" }, windowsDisk(["C:\\a\\tool.bat"])),
    ).toBe("C:\\a\\tool.bat");
  });

  it("runs an app execution alias at its visible path, and only as a native program", () => {
    const aliases = "C:\\Users\\p\\AppData\\Local\\Microsoft\\WindowsApps";
    const probes = windowsDisk([], [`${aliases}\\winget.exe`, `${aliases}\\tool.cmd`]);
    expect(
      resolveCommand("winget", {
        cwd: "C:\\work",
        environment: { PATH: aliases },
        platform: "win32",
        probes,
      }),
    ).toEqual({ kind: "native", path: `${aliases}\\winget.exe` });
    expect(onWindows("tool", { PATH: aliases }, probes)).toBeUndefined();
  });
});

describe("resolveCommand with a batch file", () => {
  const kindOf = (text: string | undefined) =>
    resolveCommand("C:\\bin\\tool.cmd", {
      cwd: "C:\\work",
      environment: {},
      platform: "win32",
      probes: windowsDisk(
        ["C:\\bin\\tool.cmd"],
        [],
        text === undefined ? {} : { "C:\\bin\\tool.cmd": text },
      ),
    })?.kind;
  const npmPreamble = generatedShims.npm.program.slice(
    0,
    generatedShims.npm.program.indexOf('"%dp0%'),
  );

  it.each([
    ["npm", "a Node script", generatedShims.npm.node],
    ["npm", "a program", generatedShims.npm.program],
    ["pnpm", "a Node script", generatedShims.pnpm.node],
    ["pnpm", "a program", generatedShims.pnpm.program],
  ])("recognizes %s's shim for %s as forwarding %*", (_manager, _target, text) => {
    expect(kindOf(text)).toBe("batch-shim");
  });

  it.each([
    ["a script that reads its parameters", '@echo off\r\nif exist "%~1" type "%~1"\r\n'],
    [
      "a hand-written forwarder",
      '@ECHO off\r\nSETLOCAL\r\nSET "dp0=%~dp0"\r\n"node" "%dp0%\\x.js" %*\r\n',
    ],
    ["a shim preamble before a script reading %1", `${npmPreamble}node "%dp0%\\x.js" %1 %*\r\n`],
    ["a shim preamble before a %* that is not last", "@SETLOCAL\r\nnode x.js %* > log.txt\r\n"],
    ["a shim preamble without %*", "@SETLOCAL\r\nnode x.js\r\n"],
    ["a shim preamble before a %~$PATH:1 search", "@SETLOCAL\r\nnode %~$PATH:1 %*\r\n"],
    [
      "a file larger than any generated shim",
      `${generatedShims.pnpm.program}${"REM\r\n".repeat(5000)}`,
    ],
    ["an unreadable file", undefined],
  ])("runs %s as an ordinary batch file", (_name, text) => {
    expect(kindOf(text)).toBe("batch");
  });
});

describe("resolveCommand on POSIX", () => {
  const resolve = (command: string, path: string, probes: CommandProbes) =>
    resolveCommand(command, {
      cwd: "/work",
      environment: { PATH: path },
      platform: "darwin",
      probes,
    })?.path;

  it("takes the first executable file on PATH", () => {
    const probes = posixDisk(["/b/tool"], ["/a/tool"]);
    expect(resolve("tool", "/a:/b", probes)).toBe("/b/tool");
  });

  it("skips empty and relative PATH entries", () => {
    const probes = posixDisk(["/work/tool", "/work/bin/tool", "/c/tool"]);
    expect(resolve("tool", ":bin:.:/c", probes)).toBe("/c/tool");
    expect(resolve("tool", ":bin:.", probes)).toBeUndefined();
  });

  it.each([
    ["./tool", "/work/tool"],
    ["bin/tool", "/work/bin/tool"],
    ["/opt/tool", "/opt/tool"],
  ])("resolves the path %s from the working directory", (command, expected) => {
    expect(resolve(command, "/path", posixDisk([expected, "/path/tool"]))).toBe(expected);
  });

  it("does not find a file it may not execute", () => {
    expect(resolve("/opt/tool", "", posixDisk([], ["/opt/tool"]))).toBeUndefined();
  });

  it("reads PATH case-sensitively", () => {
    expect(
      resolveCommand("tool", {
        cwd: "/work",
        environment: { Path: "/a" },
        platform: "linux",
        probes: posixDisk(["/a/tool"]),
      }),
    ).toBeUndefined();
  });
});

describe("getEnvironmentValue", () => {
  it("matches Windows names without case, keeping the spelling Node's spawn keeps", () => {
    const environment = { Path: "second", PATH: "first", path: undefined };
    expect(getEnvironmentValue(environment, "path", "win32")).toBe("first");
    expect(getEnvironmentValue({ Path: "only" }, "PATH", "win32")).toBe("only");
    expect(getEnvironmentValue(environment, "path", "linux")).toBeUndefined();
  });
});

const windowsEnvironment = { SystemRoot: "C:\\Windows" };
const ordinary: ResolvedCommand = { kind: "batch", path: "C:\\My Tools\\tool.cmd" };
const shim: ResolvedCommand = { kind: "batch-shim", path: "C:\\Program Files\\npm\\tool.cmd" };

function batchLine(script: ResolvedCommand, args: readonly string[]): string {
  const plan = planLaunch(script, args, { environment: windowsEnvironment, platform: "win32" });
  expect(plan).toMatchObject({ args: [], executable: "C:\\Windows\\System32\\cmd.exe" });
  return plan.windowsCommandLine!;
}

/**
 * cmd.exe parsing one line. With an environment, `%name%` first becomes a
 * defined variable's value. Then `"` toggles quoting; outside quotes `^` takes
 * the next character literally and an operator would start another command.
 */
function cmdParse(line: string, environment?: Readonly<Record<string, string>>): string {
  let text = "";
  for (let index = 0; index < line.length;) {
    const end = environment && line[index] === "%" ? line.indexOf("%", index + 1) : -1;
    const value = end > index ? environment?.[line.slice(index + 1, end)] : undefined;
    if (value === undefined) text += line[index++];
    else [text, index] = [text + value, end + 1];
  }
  let parsed = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === '"') quoted = !quoted;
    else if (!quoted && character === "^") index += 1;
    else if (!quoted && "&|<>()".includes(character))
      throw new Error(`cmd.exe would act on ${character} in ${text}`);
    parsed += text[index] ?? "";
  }
  return parsed;
}

/** What the script receives: the outer cmd's `/s` strips one quote pair, then it parses the rest once. */
function scriptCommandLine(line: string, script: string): string {
  const prefix = "cmd.exe /d /s /v:off /c ";
  expect(line.startsWith(`${prefix}""${script}"`) && line.endsWith('"')).toBe(true);
  const parsed = cmdParse(line.slice(prefix.length + 1, -1), { PATH: "C:\\Windows" });
  expect(parsed.startsWith(`"${script}"`)).toBe(true);
  return parsed.slice(script.length + 2);
}

/** How a batch file splits its command line into %1, %2…: at delimiters outside quotes. */
function batchParameters(text: string): string[] {
  const parameters: string[] = [];
  let current: string | undefined;
  let quoted = false;
  for (const character of text) {
    if (!quoted && /[ \t,;=]/u.test(character)) {
      if (current !== undefined) parameters.push(current);
      current = undefined;
      continue;
    }
    if (character === '"') quoted = !quoted;
    current = (current ?? "") + character;
  }
  if (current !== undefined) parameters.push(current);
  return parameters;
}

/** CommandLineToArgvW and the MSVC runtime. */
function commandLineToArgv(line: string): string[] {
  const args: string[] = [];
  let index = 0;
  while (index < line.length) {
    while (line[index] === " " || line[index] === "\t") index += 1;
    if (index >= line.length) break;
    let argument = "";
    let quoted = false;
    while (index < line.length && (quoted || (line[index] !== " " && line[index] !== "\t"))) {
      let backslashes = 0;
      while (line[index] === "\\") {
        backslashes += 1;
        index += 1;
      }
      if (line[index] !== '"') {
        argument += "\\".repeat(backslashes);
        if (index < line.length && (quoted || (line[index] !== " " && line[index] !== "\t")))
          argument += line[index++];
        continue;
      }
      argument += "\\".repeat(Math.floor(backslashes / 2));
      if (backslashes % 2 === 1) argument += '"';
      else if (quoted && line[index + 1] === '"') {
        argument += '"';
        index += 1;
      } else quoted = !quoted;
      index += 1;
    }
    args.push(argument);
  }
  return args;
}

const trickyArguments = [
  "plain",
  "with space",
  "",
  "naïve ☃ 日本語",
  'say "hi"',
  '"',
  "trailing\\",
  "trailing space\\",
  "C:\\dir with space\\",
  'back\\\\"slash',
  "tab\there",
  "%PATH%",
  "%",
  "!PATH!",
  "^",
  "a&calc",
  "a|calc",
  "a<b>c",
  "(paren)",
  "a,b;c=d",
  "&&calc &&",
];

describe("planLaunch", () => {
  it("runs a native program as itself", () => {
    expect(
      planLaunch({ kind: "native", path: "/bin/tool" }, ["a b"], {
        environment: {},
        platform: "darwin",
      }),
    ).toEqual({ args: ["a b"], executable: "/bin/tool" });
  });

  it("runs named PowerShell with Windows PowerShell, without a profile or prompts", () => {
    expect(
      planLaunch({ kind: "powershell", path: "C:\\a\\tool.ps1" }, ["x"], {
        environment: { SYSTEMROOT: "D:\\Win" },
        platform: "win32",
      }),
    ).toEqual({
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "C:\\a\\tool.ps1",
        "x",
      ],
      executable: "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    });
  });

  it("needs SystemRoot to find cmd.exe", () => {
    expect(() => planLaunch(ordinary, [], { environment: {}, platform: "win32" })).toThrow(
      /SystemRoot/u,
    );
  });

  it.each([
    [ordinary, '""C:\\My Tools\\tool.cmd" plain ^"a^ b^" ^"x^&y^""'],
    [shim, '""C:\\Program Files\\npm\\tool.cmd" plain ^^^"a^^^ b^^^" x^^^&y"'],
  ])("starts the batch file $path as one cmd.exe command line", (script, expected) => {
    expect(batchLine(script, ["plain", "a b", "x&y"])).toBe(`cmd.exe /d /s /v:off /c ${expected}`);
  });

  it("gives an ordinary batch file each argument as its %~n, through cmd's one parse", () => {
    const args = ["--flag", ...trickyArguments.filter((argument) => !argument.includes('"'))];
    const parameters = batchParameters(scriptCommandLine(batchLine(ordinary, args), ordinary.path));
    expect(parameters.map((parameter) => parameter.replace(/^"|"$/gu, ""))).toEqual(args);
    // A plain word stays bare, so `if "%1"=="--flag"` still matches.
    expect(parameters[0]).toBe("--flag");
  });

  it("refuses a quote an ordinary batch file's parameters cannot hold", () => {
    expect(() => batchLine(ordinary, ['say "hi"'])).toThrow(/double quote/u);
  });

  it("gives a shim's program exactly the arguments, through cmd's parse of its %* line too", () => {
    const forwarded = scriptCommandLine(batchLine(shim, trickyArguments), shim.path);
    // Text `%*` expands to is not expanded again, only parsed.
    const programLine = cmdParse(`"C:\\node\\node.exe" "C:\\npm\\cli.js"${forwarded}`);
    expect(commandLineToArgv(programLine).slice(2)).toEqual(trickyArguments);
  });

  it.each(["a\0b", "a\nb", "a\rb"])("refuses an argument cmd.exe would cut: %j", (argument) => {
    expect(() => batchLine(ordinary, [argument])).toThrow(/NUL or a line break/u);
    expect(() => batchLine(shim, [argument])).toThrow(/NUL or a line break/u);
  });

  it("refuses a script path cmd.exe would expand", () => {
    expect(() =>
      planLaunch({ kind: "batch", path: "C:\\100%\\tool.cmd" }, [], {
        environment: windowsEnvironment,
        platform: "win32",
      }),
    ).toThrow(/%/u);
  });

  it("does not start a Windows script elsewhere", () => {
    expect(() => planLaunch(shim, [], { environment: {}, platform: "linux" })).toThrow(
      /Windows batch script/u,
    );
  });
});

describe("planShellLaunch", () => {
  it("runs POSIX shell source with /bin/sh", () => {
    expect(
      planShellLaunch("npm install && PORT=1 npm start", { environment: {}, platform: "darwin" }),
    ).toEqual({ args: ["-c", "npm install && PORT=1 npm start"], executable: "/bin/sh" });
  });

  it("hands Windows shell source to cmd.exe as written, inside one outer quote pair", () => {
    const source = 'npm install && "C:\\My Tools\\server.cmd" --port %PORT% > log.txt';
    expect(planShellLaunch(source, { environment: windowsEnvironment, platform: "win32" })).toEqual(
      {
        args: [],
        executable: "C:\\Windows\\System32\\cmd.exe",
        windowsCommandLine: `cmd.exe /d /s /c "${source}"`,
      },
    );
  });

  it.each(["a\0b", "a\nb", "a\rb"])("refuses Windows source cmd.exe would cut: %j", (source) => {
    expect(() =>
      planShellLaunch(source, { environment: windowsEnvironment, platform: "win32" }),
    ).toThrow(/NUL or a line break/u);
  });
});
