import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NativePersonalUserEnvironment,
  PersonalUserEnvironmentError,
  parseLoginShellEnvironment,
  probeLoginShell,
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

  it("uses Windows PATH and PATHEXT directly without a shell probe", async () => {
    const probe = vi.fn();
    const environment = new NativePersonalUserEnvironment({
      environment: {
        PATH: "C:\\Users\\alex\\bin;C:\\Windows\\System32",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        SECRET_TOKEN: "no",
      },
      platform: "win32",
      probe,
    });
    await expect(environment.resolve()).resolves.toEqual({
      PATH: "C:\\Users\\alex\\bin;C:\\Windows\\System32",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    });
    expect(probe).not.toHaveBeenCalled();
  });
});
