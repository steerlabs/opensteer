import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hiddenDesktopLaunchArgument,
  linuxAutostartPath,
  OpenAtLoginService,
  shouldOpenDesktopWindowAtLaunch,
} from "./open-at-login.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("OpenAtLoginService", () => {
  it("uses an explicit hidden launch argument on Windows", async () => {
    const setLoginItemSettings = vi.fn();
    const service = openAtLoginService(
      "win32",
      "C:\\Opensteer\\Opensteer.exe",
      setLoginItemSettings,
    );

    await service.sync(true);
    await service.sync(false);

    expect(setLoginItemSettings.mock.calls).toEqual([
      [
        {
          args: [hiddenDesktopLaunchArgument],
          openAtLogin: true,
        },
      ],
      [{ args: [], openAtLogin: false }],
    ]);
  });

  it("writes and removes the XDG autostart entry on Linux", async () => {
    const directory = await temporaryDirectory();
    const configDirectory = path.join(directory, "xdg");
    const executable = path.join(directory, "Open Steer", "opensteer");
    const setLoginItemSettings = vi.fn();
    const service = new OpenAtLoginService({
      applicationName: "Opensteer",
      environment: { XDG_CONFIG_HOME: configDirectory },
      executablePath: executable,
      homeDirectory: directory,
      packaged: true,
      platform: "linux",
      setLoginItemSettings,
    });

    await service.sync(true);
    const filePath = linuxAutostartPath({ XDG_CONFIG_HOME: configDirectory }, directory);
    await expect(readFile(filePath, "utf8")).resolves.toContain(
      `Exec="${executable}" ${hiddenDesktopLaunchArgument}`,
    );
    expect(setLoginItemSettings).not.toHaveBeenCalled();

    await service.sync(false);
    await expect(readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not touch login startup state from an unpackaged build", async () => {
    const setLoginItemSettings = vi.fn();
    const replaceFile = vi.fn(async () => undefined);
    const service = new OpenAtLoginService({
      applicationName: "Opensteer",
      environment: {},
      executablePath: "/Applications/Opensteer.app",
      homeDirectory: "/Users/test",
      packaged: false,
      platform: "linux",
      replaceFile,
      setLoginItemSettings,
    });

    await service.sync(true);
    await service.sync(false);

    expect(replaceFile).not.toHaveBeenCalled();
    expect(setLoginItemSettings).not.toHaveBeenCalled();
  });

  it("opens a window only for an ordinary launch", () => {
    expect(shouldOpenDesktopWindowAtLaunch({ arguments: [], wasOpenedAtLogin: false })).toBe(true);
    expect(
      shouldOpenDesktopWindowAtLaunch({
        arguments: [hiddenDesktopLaunchArgument],
        wasOpenedAtLogin: false,
      }),
    ).toBe(false);
    expect(shouldOpenDesktopWindowAtLaunch({ arguments: [], wasOpenedAtLogin: true })).toBe(false);
  });
});

function openAtLoginService(
  platform: NodeJS.Platform,
  executablePath: string,
  setLoginItemSettings: (settings: {
    readonly args?: string[];
    readonly openAtLogin: boolean;
  }) => void,
): OpenAtLoginService {
  return new OpenAtLoginService({
    applicationName: "Opensteer",
    environment: {},
    executablePath,
    homeDirectory: "/Users/test",
    packaged: true,
    platform,
    setLoginItemSettings,
  });
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "opensteer-open-at-login-"));
  temporaryDirectories.push(directory);
  return directory;
}
