import { readFile, rm } from "node:fs/promises";
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

const OpenAtLoginChoiceSchema = z.object({
  turnedOff: z.boolean(),
  applied: z.boolean().nullable(),
});
export type OpenAtLoginChoice = z.infer<typeof OpenAtLoginChoiceSchema>;

export interface OpenAtLoginChoiceStore {
  load(): Promise<OpenAtLoginChoice>;
  save(choice: OpenAtLoginChoice): Promise<void>;
}

export function openAtLoginChoiceFileStore(filePath: string): OpenAtLoginChoiceStore {
  return {
    load: async () => {
      const text = await readFile(filePath, "utf8").catch(() => null);
      let value: unknown = null;
      try {
        value = text === null ? null : JSON.parse(text);
      } catch {
        value = null;
      }
      return OpenAtLoginChoiceSchema.safeParse(value).data ?? { turnedOff: false, applied: null };
    },
    save: (choice) => replacePrivateFileAtomically(filePath, `${JSON.stringify(choice)}\n`),
  };
}

/**
 * Opensteer opens at login while this Mac hosts a Home or lends itself to
 * one, unless the person turned that off — here, or in System Settings'
 * Login Items, which this notices rather than undoing.
 */
export class OpenAtLoginPolicy {
  readonly #service: Pick<OpenAtLoginService, "sync">;
  readonly #choices: OpenAtLoginChoiceStore;
  /** What macOS says now; null where the system cannot be asked. */
  readonly #systemEnabled: () => boolean | null;

  constructor(options: {
    readonly service: Pick<OpenAtLoginService, "sync">;
    readonly choices: OpenAtLoginChoiceStore;
    readonly systemEnabled: () => boolean | null;
  }) {
    this.#service = options.service;
    this.#choices = options.choices;
    this.#systemEnabled = options.systemEnabled;
  }

  /** Resolves whether Opensteer now opens at login. */
  async sync(eligible: boolean): Promise<boolean> {
    const saved = await this.#choices.load();
    const turnedOff =
      saved.turnedOff || (saved.applied === true && this.#systemEnabled() === false);
    return await this.#apply(eligible, turnedOff);
  }

  async choose(on: boolean, eligible: boolean): Promise<boolean> {
    return await this.#apply(eligible, !on);
  }

  async turnedOff(): Promise<boolean> {
    return (await this.#choices.load()).turnedOff;
  }

  async #apply(eligible: boolean, turnedOff: boolean): Promise<boolean> {
    const wanted = eligible && !turnedOff;
    await this.#service.sync(wanted);
    await this.#choices.save({ turnedOff, applied: wanted });
    return wanted;
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
