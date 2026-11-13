import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  type WindowsRegistryValue,
} from "./personal-user-environment.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Personal user environment", () => {
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
        "",
      ].join("\0"),
    );
    expect(parseLoginShellEnvironment(output)).toEqual({
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
    const registryProbe = vi.fn(async () =>
      Buffer.from(
        JSON.stringify([
          {
            kind: "ExpandString",
            name: "Path",
            scope: "machine",
            value: "%SystemRoot%\\system32;%SystemRoot%",
          },
          { kind: "ExpandString", name: "Path", scope: "user", value: "%PNPM_HOME%" },
          {
            kind: "ExpandString",
            name: "PNPM_HOME",
            scope: "user",
            value: "%LOCALAPPDATA%\\pnpm",
          },
          { kind: "String", name: "OPENAI_API_KEY", scope: "user", value: "must-not-cross" },
        ]),
      ),
    );
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
        powershell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
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
      registryProbe: async () => [],
    });
    await expect(environment.resolve()).resolves.toMatchObject({
      PATH: '"C:\\Windows\\System32";"D:\\Tools"',
    });
  });

  it("decodes the registry probe's UTF-8 JSON and rejects anything else", () => {
    const value: WindowsRegistryValue = {
      kind: "ExpandString",
      name: "Path",
      scope: "user",
      value: "%USERPROFILE%\\Zoë\\工具",
    };
    expect(parseWindowsRegistryEnvironment(Buffer.from(JSON.stringify([value]), "utf8"))).toEqual([
      value,
    ]);
    expect(() => parseWindowsRegistryEnvironment(Buffer.from([0x5b, 0xff, 0x5d]))).toThrow(
      PersonalUserEnvironmentError,
    );
    expect(() =>
      parseWindowsRegistryEnvironment(Buffer.from(JSON.stringify([{ ...value, kind: "Binary" }]))),
    ).toThrow(/unrecognized/u);
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
