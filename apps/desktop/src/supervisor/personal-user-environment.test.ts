import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NativePersonalUserEnvironment,
  PersonalUserEnvironmentError,
  composeWindowsEnvironment,
  filterUserEnvironment,
  parseLoginShellEnvironment,
  parseWindowsRegistryEnvironment,
  probeLoginShell,
  probeWindowsRegistryEnvironment,
  type WindowsRegistryValue,
} from "./personal-user-environment.js";

/**
 * A .reg file as `reg.exe export` writes it: a UTF-16LE byte-order mark, the editor line, a blank
 * line, then each key's section followed by a blank line, every line ending in CRLF. The lines
 * below are written as Windows writes them, hex lists wrapped after 77 characters.
 */
const regExport = (...lines: string[]) =>
  Buffer.from(
    `\uFEFF${["Windows Registry Editor Version 5.00", "", ...lines, "", ""].join("\r\n")}`,
    "utf16le",
  );
const machineKey =
  "[HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment]";
const userKey = "[HKEY_CURRENT_USER\\Environment]";
/** HKLM's environment key: REG_EXPAND_SZ as hex(2), REG_SZ quoted. */
const machineExport = regExport(
  machineKey,
  '"ComSpec"=hex(2):25,00,53,00,79,00,73,00,74,00,65,00,6d,00,52,00,6f,00,6f,00,\\',
  "  74,00,25,00,5c,00,73,00,79,00,73,00,74,00,65,00,6d,00,33,00,32,00,5c,00,63,\\",
  "  00,6d,00,64,00,2e,00,65,00,78,00,65,00,00,00",
  '"NUMBER_OF_PROCESSORS"="8"',
  '"OS"="Windows_NT"',
  '"Path"=hex(2):25,00,53,00,79,00,73,00,74,00,65,00,6d,00,52,00,6f,00,6f,00,74,\\',
  "  00,25,00,5c,00,73,00,79,00,73,00,74,00,65,00,6d,00,33,00,32,00,3b,00,25,00,\\",
  "  53,00,79,00,73,00,74,00,65,00,6d,00,52,00,6f,00,6f,00,74,00,25,00,3b,00,25,\\",
  "  00,53,00,79,00,73,00,74,00,65,00,6d,00,52,00,6f,00,6f,00,74,00,25,00,5c,00,\\",
  "  53,00,79,00,73,00,74,00,65,00,6d,00,33,00,32,00,5c,00,57,00,62,00,65,00,6d,\\",
  "  00,3b,00,00,00",
  '"PATHEXT"=".COM;.EXE;.BAT;.CMD"',
  '"TOOLS"="C:\\\\machine-tools"',
  '"windir"=hex(2):25,00,53,00,79,00,73,00,74,00,65,00,6d,00,52,00,6f,00,6f,00,\\',
  "  74,00,25,00,00,00",
);
/**
 * HKCU's: a non-ASCII REG_EXPAND_SZ, a REG_SZ regedit wrote as hex(1), a name with a quote and an
 * equals sign, kinds that are not variables (dword, hex, hex(7), the unnamed default) and a
 * subkey whose values are not the key's.
 */
const userExport = regExport(
  userKey,
  '@="not a variable"',
  '"BLOB"=hex:01,02',
  '"COUNT"=dword:00000001',
  '"LIST"=hex(7):61,00,00,00,62,00,00,00,00,00',
  '"LITERAL"=hex(1):25,00,54,00,4f,00,4f,00,4c,00,53,00,25,00,00,00',
  '"OneDrive"="C:\\\\Users\\\\Zoë\\\\OneDrive"',
  '"Path"=hex(2):25,00,55,00,53,00,45,00,52,00,50,00,52,00,4f,00,46,00,49,00,4c,\\',
  "  00,45,00,25,00,5c,00,41,00,70,00,70,00,44,00,61,00,74,00,61,00,5c,00,4c,00,\\",
  "  6f,00,63,00,61,00,6c,00,5c,00,4d,00,69,00,63,00,72,00,6f,00,73,00,6f,00,66,\\",
  "  00,74,00,5c,00,57,00,69,00,6e,00,64,00,6f,00,77,00,73,00,41,00,70,00,70,00,\\",
  "  73,00,3b,00,25,00,50,00,4e,00,50,00,4d,00,5f,00,48,00,4f,00,4d,00,45,00,25,\\",
  "  00,3b,00,00,00",
  '"PNPM_HOME"=hex(2):25,00,4c,00,4f,00,43,00,41,00,4c,00,41,00,50,00,50,00,44,\\',
  "  00,41,00,54,00,41,00,25,00,5c,00,70,00,6e,00,70,00,6d,00,00,00",
  '"Say \\"hi\\"=x"="a \\"quoted\\" value\\\\"',
  '"TEMP"=hex(2):25,00,55,00,53,00,45,00,52,00,50,00,52,00,4f,00,46,00,49,00,4c,\\',
  "  00,45,00,25,00,5c,00,41,00,70,00,70,00,44,00,61,00,74,00,61,00,5c,00,4c,00,\\",
  "  6f,00,63,00,61,00,6c,00,5c,00,54,00,65,00,6d,00,70,00,00,00",
  '"TOOLS"=hex(2):25,00,55,00,53,00,45,00,52,00,50,00,52,00,4f,00,46,00,49,00,\\',
  "  4c,00,45,00,25,00,5c,00,4f,00,70,00,65,00,6e,00,73,00,74,00,65,00,65,00,72,\\",
  "  00,20,00,5a,00,6f,00,eb,00,20,00,e5,5d,77,51,5c,00,62,00,69,00,6e,00,00,00",
  "",
  "[HKEY_CURRENT_USER\\Environment\\Volatile]",
  '"Path"="C:\\\\must-not-read"',
);
const exportOf = (key: string, ...lines: string[]) => regExport(key, ...lines);

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Personal user environment", () => {
  it("keeps both spellings of the HTTPS proxy on macOS and Linux", () => {
    const source = {
      HTTPS_PROXY: "http://proxy-upper.invalid:8080",
      https_proxy: "http://proxy-lower.invalid:8080",
    };
    expect(filterUserEnvironment(source, "darwin")).toEqual(source);
    expect(filterUserEnvironment(source, "linux")).toEqual(source);
  });

  it("parses only bounded path/config fields after the login-shell sentinel", () => {
    const output = Buffer.from(
      [
        "startup noise",
        "__OPENSTEER_LOGIN_ENV_V1__",
        "PATH=/opt/homebrew/bin:/usr/bin",
        "HOME=/attacker-override",
        "CODEX_HOME=/Users/person/.codex",
        "OPENSTEER_CLAUDE_EXECUTABLE=/opt/claude/claude",
        "OPENAI_API_KEY=must-not-cross",
        "CUSTOM_SECRET=must-not-cross",
        "HTTPS_PROXY=http://person:fake-proxy-password@proxy.example.test:8080",
        "NO_PROXY=localhost",
        "NODE_EXTRA_CA_CERTS=/etc/company/ca.pem",
        "",
      ].join("\0"),
    );
    expect(parseLoginShellEnvironment(output)).toEqual({
      // How engines reach the network, as in the person's own terminal.
      HTTPS_PROXY: "http://person:fake-proxy-password@proxy.example.test:8080",
      NO_PROXY: "localhost",
      NODE_EXTRA_CA_CERTS: "/etc/company/ca.pem",
      CODEX_HOME: "/Users/person/.codex",
      OPENSTEER_CLAUDE_EXECUTABLE: "/opt/claude/claude",
      HOME: "/attacker-override",
      PATH: "/opt/homebrew/bin:/usr/bin",
    });
  });

  it("caches the resolved account environment and overrides shell-supplied identity fields", async () => {
    const probe = vi.fn(async () =>
      Buffer.from(
        "__OPENSTEER_LOGIN_ENV_V1__\0PATH=/opt/homebrew/bin:/usr/bin\0HOME=/wrong\0SECRET=no\0",
      ),
    );
    const environment = new NativePersonalUserEnvironment({
      environment: { PATH: "/minimal" },
      platform: "darwin",
      probe,
      userInfo: () => ({
        gid: 20,
        homedir: "/Users/person",
        shell: "/bin/zsh",
        uid: 501,
        username: "alex",
      }),
    });
    await expect(environment.resolve()).resolves.toMatchObject({
      HOME: "/Users/person",
      LOGNAME: "alex",
      PATH: "/opt/homebrew/bin:/usr/bin",
      SHELL: "/bin/zsh",
      USER: "alex",
    });
    await environment.resolve();
    expect(probe).toHaveBeenCalledOnce();
    expect(JSON.stringify(await environment.resolve())).not.toContain("SECRET");
  });

  it("keeps every byte a probe wrote before it exited", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(path.join(tmpdir(), "opensteer-login-shell-"));
    temporaryDirectories.push(directory);
    const shell = path.join(directory, "chatty-shell");
    await writeFile(shell, "#!/bin/sh\nhead -c 300000 /dev/zero | tr '\\000' a\n", { mode: 0o700 });
    await chmod(shell, 0o700);
    const output = await probeLoginShell({
      environment: { HOME: directory, PATH: "/usr/bin:/bin" },
      maximumOutputBytes: 400_000,
      shell,
      timeoutMs: 5_000,
    });
    expect(output.byteLength).toBe(300_000);
  });

  it("bounds the native login-shell probe to five seconds or less", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(path.join(tmpdir(), "opensteer-login-shell-"));
    temporaryDirectories.push(directory);
    const shell = path.join(directory, "slow-shell");
    await writeFile(shell, "#!/bin/sh\nsleep 1\n", { mode: 0o700 });
    await chmod(shell, 0o700);
    await expect(
      probeLoginShell({
        environment: { HOME: directory, PATH: "/usr/bin:/bin" },
        maximumOutputBytes: 1_024,
        shell,
        timeoutMs: 20,
      }),
    ).rejects.toThrow(/timed out/u);
    expect(
      () =>
        new NativePersonalUserEnvironment({
          platform: "darwin",
          timeoutMs: 5_001,
        }),
    ).toThrow(/1 through 5000/u);
  });

  it("caches probe failure and never falls back to the packaged app PATH", async () => {
    const probe = vi.fn(async () => {
      throw new PersonalUserEnvironmentError("login shell failed");
    });
    const environment = new NativePersonalUserEnvironment({
      environment: { PATH: "/Applications/Opensteer.app/Contents/MacOS" },
      platform: "darwin",
      probe,
      userInfo: () => ({
        gid: 20,
        homedir: "/Users/person",
        shell: "/bin/zsh",
        uid: 501,
        username: "alex",
      }),
    });
    await expect(environment.resolve()).rejects.toThrow("login shell failed");
    await expect(environment.resolve()).rejects.toThrow("login shell failed");
    expect(probe).toHaveBeenCalledOnce();
  });

  it("reads the Windows registry once, without a shell, and keeps the baseline but no secrets", async () => {
    const shellProbe = vi.fn();
    const registryProbe = vi.fn(async () => ({
      machine: exportOf(
        machineKey,
        '"Path"=hex(2):25,00,53,00,79,00,73,00,74,00,65,00,6d,00,52,00,6f,00,6f,00,74,\\',
        "  00,25,00,5c,00,73,00,79,00,73,00,74,00,65,00,6d,00,33,00,32,00,3b,00,25,00,\\",
        "  53,00,79,00,73,00,74,00,65,00,6d,00,52,00,6f,00,6f,00,74,00,25,00,00,00",
      ),
      user: exportOf(
        userKey,
        '"OPENAI_API_KEY"="must-not-cross"',
        '"Path"=hex(2):25,00,50,00,4e,00,50,00,4d,00,5f,00,48,00,4f,00,4d,00,45,00,25,\\',
        "  00,00,00",
        '"PNPM_HOME"=hex(2):25,00,4c,00,4f,00,43,00,41,00,4c,00,41,00,50,00,50,00,44,\\',
        "  00,41,00,54,00,41,00,25,00,5c,00,70,00,6e,00,70,00,6d,00,00,00",
      ),
    }));
    const log = vi.fn();
    const environment = new NativePersonalUserEnvironment({
      environment: {
        ComSpec: "C:\\Windows\\system32\\cmd.exe",
        LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local",
        NODE_OPTIONS: "--require C:\\evil.js",
        Path: "C:\\Windows\\system32;C:\\dev\\node_modules\\.bin",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        SECRET_TOKEN: "no",
        SystemRoot: "C:\\Windows",
      },
      isDirectory: () => false,
      log,
      platform: "win32",
      probe: shellProbe,
      registryProbe,
    });
    await expect(environment.resolve()).resolves.toEqual({
      ComSpec: "C:\\Windows\\system32\\cmd.exe",
      LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local",
      PATH: "C:\\Windows\\system32;C:\\Windows;C:\\Users\\Ada\\AppData\\Local\\pnpm;C:\\dev\\node_modules\\.bin",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      PNPM_HOME: "C:\\Users\\Ada\\AppData\\Local\\pnpm",
      SystemRoot: "C:\\Windows",
    });
    await environment.resolve();
    expect(registryProbe).toHaveBeenCalledOnce();
    expect(registryProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        reg: "C:\\Windows\\System32\\reg.exe",
        // A bound a registry export cannot plausibly meet, not PowerShell's start-up.
        timeoutMs: 30_000,
      }),
    );
    expect(shellProbe).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("says so when the Windows registry is unreadable and uses only the inherited environment", async () => {
    const log = vi.fn();
    const environment = new NativePersonalUserEnvironment({
      environment: { Path: "C:\\Windows\\system32", SystemRoot: "C:\\Windows" },
      isDirectory: () => false,
      log,
      platform: "win32",
      registryProbe: async () => {
        throw new PersonalUserEnvironmentError("The Windows registry environment probe timed out.");
      },
    });
    await expect(environment.resolve()).resolves.toEqual({
      PATH: "C:\\Windows\\system32",
      SystemRoot: "C:\\Windows",
    });
    expect(log).toHaveBeenCalledWith(
      "personal.user_environment.windows_registry_unavailable",
      expect.objectContaining({
        detail: expect.stringContaining("only the environment Opensteer started with"),
        error: "The Windows registry environment probe timed out.",
      }),
    );
  });

  it("accepts a Windows PATH whose entries are quoted", async () => {
    const environment = new NativePersonalUserEnvironment({
      environment: { Path: '"C:\\Windows\\System32";"D:\\Tools"', SystemRoot: "C:\\Windows" },
      isDirectory: () => false,
      platform: "win32",
      registryProbe: async () => ({
        machine: exportOf(machineKey),
        user: exportOf(userKey),
      }),
    });
    await expect(environment.resolve()).resolves.toMatchObject({
      PATH: '"C:\\Windows\\System32";"D:\\Tools"',
    });
  });

  it("reads each key's REG_SZ and REG_EXPAND_SZ values from reg.exe's UTF-16LE export, unexpanded", () => {
    expect(parseWindowsRegistryEnvironment({ machine: machineExport, user: userExport })).toEqual([
      {
        kind: "ExpandString",
        name: "ComSpec",
        scope: "machine",
        value: "%SystemRoot%\\system32\\cmd.exe",
      },
      { kind: "String", name: "NUMBER_OF_PROCESSORS", scope: "machine", value: "8" },
      { kind: "String", name: "OS", scope: "machine", value: "Windows_NT" },
      {
        kind: "ExpandString",
        name: "Path",
        scope: "machine",
        value: "%SystemRoot%\\system32;%SystemRoot%;%SystemRoot%\\System32\\Wbem;",
      },
      { kind: "String", name: "PATHEXT", scope: "machine", value: ".COM;.EXE;.BAT;.CMD" },
      { kind: "String", name: "TOOLS", scope: "machine", value: "C:\\machine-tools" },
      { kind: "ExpandString", name: "windir", scope: "machine", value: "%SystemRoot%" },
      { kind: "String", name: "LITERAL", scope: "user", value: "%TOOLS%" },
      { kind: "String", name: "OneDrive", scope: "user", value: "C:\\Users\\Zoë\\OneDrive" },
      {
        kind: "ExpandString",
        name: "Path",
        scope: "user",
        value: "%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;%PNPM_HOME%;",
      },
      { kind: "ExpandString", name: "PNPM_HOME", scope: "user", value: "%LOCALAPPDATA%\\pnpm" },
      { kind: "String", name: 'Say "hi"=x', scope: "user", value: 'a "quoted" value\\' },
      {
        kind: "ExpandString",
        name: "TEMP",
        scope: "user",
        value: "%USERPROFILE%\\AppData\\Local\\Temp",
      },
      {
        kind: "ExpandString",
        name: "TOOLS",
        scope: "user",
        value: "%USERPROFILE%\\Opensteer Zoë 工具\\bin",
      },
    ]);
  });

  it("exports both keys with reg.exe's export command into files it removes, within its bound", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(path.join(tmpdir(), "opensteer-reg-"));
    temporaryDirectories.push(directory);
    await writeFile(path.join(directory, "machine.reg"), machineExport);
    await writeFile(path.join(directory, "user.reg"), userExport);
    // A stand-in for reg.exe: `export <key> <file> /y` copies that key's export to <file>.
    const reg = path.join(directory, "reg");
    await writeFile(
      reg,
      [
        "#!/bin/sh",
        `echo "$*" >> '${directory}/calls'`,
        '[ "$1" = export ] && [ "$4" = /y ] || exit 2',
        'case "$2" in',
        `  'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment') cp '${directory}/machine.reg' "$3" ;;`,
        `  'HKEY_CURRENT_USER\\Environment') cp '${directory}/user.reg' "$3" ;;`,
        "  *) exit 1 ;;",
        "esac",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    const spec = {
      environment: { PATH: "/usr/bin:/bin" },
      maximumOutputBytes: 8 * 1_024 * 1_024,
      reg,
      timeoutMs: 5_000,
    };
    const exports = await probeWindowsRegistryEnvironment(spec);
    expect(Buffer.from(exports.machine).equals(machineExport)).toBe(true);
    expect(Buffer.from(exports.user).equals(userExport)).toBe(true);
    const files = (await readFile(path.join(directory, "calls"), "utf8"))
      .trim()
      .split("\n")
      .map((call) => call.split(" ").at(-2)!);
    expect(files).toHaveLength(2);
    for (const file of files) await expect(stat(file)).rejects.toThrow();
    await expect(
      probeWindowsRegistryEnvironment({ ...spec, maximumOutputBytes: 1_024 }),
    ).rejects.toThrow("The Windows registry environment response is too large.");
    await writeFile(reg, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    await expect(probeWindowsRegistryEnvironment(spec)).rejects.toThrow(
      "Windows could not export the registry environment (exit 1).",
    );
    await writeFile(reg, "#!/bin/sh\nexec sleep 5\n", { mode: 0o700 });
    await expect(probeWindowsRegistryEnvironment({ ...spec, timeoutMs: 50 })).rejects.toThrow(
      "The Windows registry environment probe timed out.",
    );
  });

  it("composes a new logon's environment from the two exports: user over machine, PATH machine then user", () => {
    const environment = composeWindowsEnvironment({
      inherited: {
        LOCALAPPDATA: "C:\\Users\\Zoë\\AppData\\Local",
        Path: "C:\\injected",
        SystemRoot: "C:\\Windows",
        USERPROFILE: "C:\\Users\\Zoë",
      },
      isDirectory: () => false,
      registry: parseWindowsRegistryEnvironment({ machine: machineExport, user: userExport }),
    });
    expect(environment.PATH?.split(";")).toEqual([
      "C:\\Windows\\system32",
      "C:\\Windows",
      "C:\\Windows\\System32\\Wbem",
      "C:\\Users\\Zoë\\AppData\\Local\\Microsoft\\WindowsApps",
      "C:\\Users\\Zoë\\AppData\\Local\\pnpm",
      "C:\\injected",
    ]);
    expect(environment).toMatchObject({
      ComSpec: "C:\\Windows\\system32\\cmd.exe",
      // hex(1) is REG_SZ: never expanded.
      LITERAL: "%TOOLS%",
      TEMP: "C:\\Users\\Zoë\\AppData\\Local\\Temp",
      TOOLS: "C:\\Users\\Zoë\\Opensteer Zoë 工具\\bin",
      windir: "C:\\Windows",
    });
  });

  it("rejects an export that is not the key's .reg file as Windows writes it", () => {
    const read = (machine: Uint8Array) =>
      parseWindowsRegistryEnvironment({ machine, user: exportOf(userKey) });
    const unreadable = /readable registry environment/u;
    // UTF-8, as plain `reg query` or a code page would give: no byte-order mark.
    expect(() =>
      read(Buffer.from(`Windows Registry Editor Version 5.00\r\n\r\n${machineKey}\r\n`)),
    ).toThrow(unreadable);
    expect(() => read(Buffer.from(`\uFEFFREGEDIT4\r\n\r\n${machineKey}\r\n`, "utf16le"))).toThrow(
      unreadable,
    );
    // Another key's export only.
    expect(() => read(exportOf(userKey))).toThrow(unreadable);
    // A hex list cut off, a byte that is not hex, an unterminated name or value.
    expect(() => read(exportOf(machineKey, '"Path"=hex(2):25,00,\\'))).toThrow(unreadable);
    expect(() => read(exportOf(machineKey, '"Path"=hex(2):25,0'))).toThrow(unreadable);
    expect(() => read(exportOf(machineKey, '"Path"=hex(2):25,zz'))).toThrow(unreadable);
    expect(() => read(exportOf(machineKey, '"Path="C:\\\\x"'))).toThrow(unreadable);
    expect(() => read(exportOf(machineKey, '"Path"="C:\\\\x'))).toThrow(unreadable);
    expect(() => read(exportOf(machineKey, '"Path"=dword:1'))).toThrow(unreadable);
    // Unpaired UTF-16.
    const broken = Buffer.concat([exportOf(machineKey), Buffer.from([0x00, 0xd8])]);
    expect(() => read(broken)).toThrow(unreadable);
  });

  it("expands only REG_EXPAND_SZ values and leaves self-references, cycles and unknown names literal", () => {
    const registry: WindowsRegistryValue[] = [
      { kind: "ExpandString", name: "Path", scope: "machine", value: "C:\\Windows;%PATH%" },
      { kind: "ExpandString", name: "PATH", scope: "user", value: "%TOOLS%\\bin;%MISSING%\\bin" },
      { kind: "String", name: "LITERAL", scope: "machine", value: "%TOOLS%" },
      { kind: "ExpandString", name: "TOOLS", scope: "machine", value: "C:\\machine-tools" },
      { kind: "ExpandString", name: "TOOLS", scope: "user", value: "%USERPROFILE%\\tools" },
      { kind: "ExpandString", name: "LOOP_A", scope: "user", value: "%LOOP_B%" },
      { kind: "ExpandString", name: "LOOP_B", scope: "user", value: "%LOOP_A%" },
      { kind: "ExpandString", name: "SELF", scope: "user", value: "x%self%y" },
    ];
    const environment = composeWindowsEnvironment({
      inherited: { USERPROFILE: "C:\\Users\\Zoë" },
      isDirectory: () => false,
      registry,
    });
    expect(environment).toMatchObject({
      LITERAL: "%TOOLS%",
      PATH: "C:\\Windows;%PATH%;C:\\Users\\Zoë\\tools\\bin;%MISSING%\\bin",
      SELF: "x%self%y",
      TOOLS: "C:\\Users\\Zoë\\tools",
    });
    expect(environment.LOOP_A).toMatch(/^%LOOP_[AB]%$/u);
  });

  it("composes PATH from machine, user, inherited, then existing package-manager directories", () => {
    const existing = new Set([
      "C:\\Users\\Ada\\AppData\\Roaming\\npm",
      "D:\\volta\\bin",
      "C:\\Users\\Ada\\scoop\\shims",
      "C:\\Users\\Ada\\.local\\bin",
    ]);
    const environment = composeWindowsEnvironment({
      inherited: {
        APPDATA: "C:\\Users\\Ada\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local",
        PATH: "c:\\windows\\SYSTEM32\\;C:\\injected\\toolchain;;C:\\Users\\Ada\\.local\\bin",
        USERPROFILE: "C:\\Users\\Ada",
      },
      isDirectory: (directory) => existing.has(directory),
      registry: [
        { kind: "String", name: "Path", scope: "machine", value: "C:\\Windows\\System32" },
        { kind: "String", name: "Path", scope: "user", value: '"C:\\Program Files\\Tool"' },
        { kind: "String", name: "VOLTA_HOME", scope: "user", value: "D:\\volta" },
      ],
    });
    expect(environment.PATH?.split(";")).toEqual([
      "C:\\Windows\\System32",
      '"C:\\Program Files\\Tool"',
      "C:\\injected\\toolchain",
      "C:\\Users\\Ada\\.local\\bin",
      "C:\\Users\\Ada\\AppData\\Roaming\\npm",
      "D:\\volta\\bin",
      "C:\\Users\\Ada\\scoop\\shims",
    ]);
  });

  it("filters the Desktop environment with the Windows baseline only on Windows", () => {
    const source = {
      CLAUDE_CODE_GIT_BASH_PATH: "D:\\Git\\bin\\bash.exe",
      ComSpec: "C:\\Windows\\system32\\cmd.exe",
      HOME: "/Users/ada",
      NODE_OPTIONS: "--require evil.js",
      Path: "C:\\Windows\\system32",
      ProgramData: "C:\\ProgramData",
      SystemRoot: "C:\\Windows",
    };
    expect(filterUserEnvironment(source, "win32")).toEqual({
      CLAUDE_CODE_GIT_BASH_PATH: "D:\\Git\\bin\\bash.exe",
      ComSpec: "C:\\Windows\\system32\\cmd.exe",
      HOME: "/Users/ada",
      PATH: "C:\\Windows\\system32",
      ProgramData: "C:\\ProgramData",
      SystemRoot: "C:\\Windows",
    });
    expect(filterUserEnvironment(source, "darwin")).toEqual({
      CLAUDE_CODE_GIT_BASH_PATH: "D:\\Git\\bin\\bash.exe",
      HOME: "/Users/ada",
    });
  });
});
