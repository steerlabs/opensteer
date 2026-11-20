import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  type OpenAtLoginChoiceStore,
  type OpenAtLoginRecord,
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
  const home = { hostsHome: true, enrolledRunners: false };
  const nothing = { hostsHome: false, enrolledRunners: false };
  function policy(input: { system?: { enabled: boolean | null }; saved?: unknown } = {}) {
    const system = input.system ?? { enabled: false };
    const synced: boolean[] = [];
    let saved: OpenAtLoginRecord | null = null;
    const choices: OpenAtLoginChoiceStore = {
      load: async () => saved,
      save: async (record) => {
        saved = record;
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
    return { synced, system, value, saved: () => saved };
  }

  it("opens at login when this Mac hosts a Home or lends itself to one", async () => {
    const { synced, value } = policy();
    await value.sync(home);
    await value.sync(nothing);
    expect(synced).toEqual([true, false]);
  });

  it("shows what macOS will do, and that a Mac with nothing to open for has no switch", async () => {
    const { value } = policy();
    await expect(value.effective(nothing)).resolves.toEqual({ on: false, available: false });
    await value.sync(home);
    await expect(value.effective(home)).resolves.toEqual({ on: true, available: true });
  });

  it("never undoes System Settings, either way, until what Opensteer wants changes", async () => {
    const { synced, system, value } = policy();
    await value.sync(home);
    system.enabled = false;
    await value.sync(home);
    await expect(value.effective(home)).resolves.toMatchObject({ on: false });
    system.enabled = true;
    await value.sync(home);
    await expect(value.effective(home)).resolves.toMatchObject({ on: true });
    expect(synced).toEqual([true]);
  });

  it("keeps an item the person disabled before upgrading", async () => {
    const { synced, value } = policy({ system: { enabled: false } });
    await value.sync({ hostsHome: true, enrolledRunners: true });
    expect(synced).toEqual([]);
  });

  it("lets the person turn it off and on again", async () => {
    const { synced, value } = policy({ system: { enabled: null } });
    await value.choose(false, home);
    await value.sync(home);
    await expect(value.effective(home)).resolves.toMatchObject({ on: false });
    await value.choose(true, home);
    await value.sync(home);
    expect(synced).toEqual([false, true]);
  });

  it("reads its own record, and a previous build's choice as what that build registered", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "open-at-login-choice-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "open-at-login.json");
    const store = openAtLoginChoiceFileStore(file);
    await expect(store.load(home)).resolves.toBeNull();
    await writeFile(file, JSON.stringify({ turnedOff: true, applied: true }));
    await expect(store.load(home)).resolves.toEqual({
      version: 2,
      choice: "off",
      registered: true,
    });
    await store.save({ version: 2, choice: null, registered: false });
    await expect(store.load(home)).resolves.toEqual({
      version: 2,
      choice: null,
      registered: false,
    });
  });
});
