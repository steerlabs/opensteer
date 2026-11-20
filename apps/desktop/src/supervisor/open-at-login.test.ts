import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hiddenDesktopLaunchArgument,
  linuxAutostartPath,
  openAtLoginChoiceFileStore,
  OpenAtLoginPolicy,
  OpenAtLoginService,
  shouldOpenDesktopWindowAtLaunch,
  type OpenAtLoginChoice,
  type OpenAtLoginChoiceStore,
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

describe("OpenAtLoginPolicy", () => {
  function policy(system: { enabled: boolean | null }) {
    const synced: boolean[] = [];
    let saved: OpenAtLoginChoice = { turnedOff: false, applied: null };
    const choices: OpenAtLoginChoiceStore = {
      load: async () => saved,
      save: async (choice) => {
        saved = choice;
      },
    };
    const value = new OpenAtLoginPolicy({
      service: {
        sync: async (enabled) => {
          synced.push(enabled);
          system.enabled = enabled;
        },
      },
      choices,
      systemEnabled: () => system.enabled,
    });
    return { synced, value, saved: () => saved };
  }

  it("opens at login when this Mac hosts a Home or lends itself to one", async () => {
    const { synced, value } = policy({ enabled: false });
    await expect(value.sync(true)).resolves.toBe(true);
    await expect(value.sync(false)).resolves.toBe(false);
    expect(synced).toEqual([true, false]);
  });

  it("keeps a Login Items switch-off the person made in System Settings", async () => {
    const system = { enabled: false as boolean | null };
    const { synced, value, saved } = policy(system);
    await value.sync(true);
    system.enabled = false;
    await expect(value.sync(true)).resolves.toBe(false);
    expect(synced).toEqual([true, false]);
    expect(saved().turnedOff).toBe(true);
    await expect(value.sync(true)).resolves.toBe(false);
  });

  it("lets the person turn it off and on again", async () => {
    const { value } = policy({ enabled: null });
    await expect(value.choose(false, true)).resolves.toBe(false);
    await expect(value.sync(true)).resolves.toBe(false);
    await expect(value.turnedOff()).resolves.toBe(true);
    await expect(value.choose(true, true)).resolves.toBe(true);
    await expect(value.sync(true)).resolves.toBe(true);
  });

  it("remembers the choice in a file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "open-at-login-choice-"));
    temporaryDirectories.push(directory);
    const store = openAtLoginChoiceFileStore(path.join(directory, "open-at-login.json"));
    await expect(store.load()).resolves.toEqual({ turnedOff: false, applied: null });
    await store.save({ turnedOff: true, applied: false });
    await expect(store.load()).resolves.toEqual({ turnedOff: true, applied: false });
  });
});
