import { rm } from "node:fs/promises";
import path from "node:path";
import { replacePrivateFileAtomically } from "@opensteer/shared/atomicPrivateFile";
import { z } from "zod";

export const hiddenDesktopLaunchArgument = "--opensteer-start-hidden";

const XdgEnvironmentSchema = z.object({
  XDG_CONFIG_HOME: z.string().optional(),
});

interface LoginItemSettings {
  readonly args?: string[];
  readonly openAtLogin: boolean;
}

export interface OpenAtLoginDependencies {
  readonly applicationName: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly executablePath: string;
  readonly homeDirectory: string;
  readonly packaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly replaceFile?: typeof replacePrivateFileAtomically;
  readonly setLoginItemSettings: (settings: LoginItemSettings) => void;
}

export class OpenAtLoginService {
  readonly #dependencies: OpenAtLoginDependencies;

  constructor(dependencies: OpenAtLoginDependencies) {
    this.#dependencies = dependencies;
  }

  async sync(enabled: boolean): Promise<void> {
    if (!this.#dependencies.packaged) return;
    if (this.#dependencies.platform === "darwin") {
      this.#dependencies.setLoginItemSettings({
        openAtLogin: enabled,
      });
      return;
    }
    if (this.#dependencies.platform === "win32") {
      this.#dependencies.setLoginItemSettings({
        args: enabled ? [hiddenDesktopLaunchArgument] : [],
        openAtLogin: enabled,
      });
      return;
    }
    if (this.#dependencies.platform !== "linux") return;

    const filePath = linuxAutostartPath(
      this.#dependencies.environment,
      this.#dependencies.homeDirectory,
    );
    if (!enabled) {
      await rm(filePath, { force: true });
      return;
    }
    await (this.#dependencies.replaceFile ?? replacePrivateFileAtomically)(
      filePath,
      linuxDesktopEntry(this.#dependencies.applicationName, this.#dependencies.executablePath),
    );
  }
}

export function shouldOpenDesktopWindowAtLaunch(input: {
  readonly arguments: readonly string[];
  /** Modern macOS login items no longer carry a hidden-launch attribute. */
  readonly wasOpenedAtLogin: boolean;
}): boolean {
  return !input.wasOpenedAtLogin && !input.arguments.includes(hiddenDesktopLaunchArgument);
}

export function linuxAutostartPath(environment: NodeJS.ProcessEnv, homeDirectory: string): string {
  const configured = XdgEnvironmentSchema.parse(environment).XDG_CONFIG_HOME?.trim();
  const configDirectory = configured || path.join(path.resolve(homeDirectory), ".config");
  if (!path.isAbsolute(configDirectory)) {
    throw new Error("XDG_CONFIG_HOME must be an absolute path.");
  }
  return path.join(configDirectory, "autostart", "opensteer.desktop");
}

function linuxDesktopEntry(applicationName: string, executablePath: string): string {
  const name = applicationName.trim();
  if (!name || /[\r\n]/u.test(name)) throw new Error("The application name is invalid.");
  const executable = path.resolve(executablePath);
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${name}`,
    `Exec=${desktopExecArgument(executable)} ${hiddenDesktopLaunchArgument}`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

function desktopExecArgument(value: string): string {
  return `"${value.replace(/[\\`"$]/gu, "\\$&")}"`;
}
