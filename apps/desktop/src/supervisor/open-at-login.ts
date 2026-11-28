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

const OpenAtLoginRecordSchema = z.object({
  version: z.literal(2),
  /** The person's own choice in Opensteer; null until they make one. */
  choice: z.enum(["on", "off"]).nullable(),
  /** What Opensteer last asked macOS for. */
  registered: z.boolean(),
});
export type OpenAtLoginRecord = z.infer<typeof OpenAtLoginRecordSchema>;
/** What the build before menu bar mode saved, when the person had a Home or a Device. */
const PreviousChoiceSchema = z.object({ turnedOff: z.boolean(), applied: z.boolean().nullable() });

export interface OpenAtLoginEligibility {
  readonly hostsHome: boolean;
  readonly enrolledRunners: boolean;
}

export interface OpenAtLoginChoiceStore {
  /** The saved record, a previous build's choice migrated, or null when there is none. */
  load(eligibility: OpenAtLoginEligibility): Promise<OpenAtLoginRecord | null>;
  save(record: OpenAtLoginRecord): Promise<void>;
}

export function openAtLoginChoiceFileStore(filePath: string): OpenAtLoginChoiceStore {
  return {
    load: async (eligibility) => {
      const text = await readFile(filePath, "utf8").catch(() => null);
      let value: unknown = null;
      try {
        value = text === null ? null : JSON.parse(text);
      } catch {
        value = null;
      }
      const record = OpenAtLoginRecordSchema.safeParse(value);
      if (record.success) return record.data;
      const previous = PreviousChoiceSchema.safeParse(value);
      if (!previous.success) return null;
      return {
        version: 2,
        choice: previous.data.turnedOff ? "off" : null,
        registered: previous.data.applied ?? eligibility.enrolledRunners,
      };
    },
    save: (record) => replacePrivateFileAtomically(filePath, `${JSON.stringify(record)}\n`),
  };
}

/**
 * Opensteer opens at login while this Mac hosts a Home or lends itself to one,
 * unless the person turned that off here. It asks macOS only when what it
 * wants changes, never to undo what the person set in System Settings' Login
 * Items, and it shows what macOS will actually do.
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

  async sync(eligibility: OpenAtLoginEligibility): Promise<void> {
    const loaded = await this.#record(eligibility);
    const record = this.#observed(loaded);
    if (record !== loaded) await this.#choices.save(record);
    const wanted = eligible(eligibility) && record.choice !== "off";
    if (wanted === record.registered) {
      await this.#choices.save(record);
      return;
    }
    await this.#service.sync(wanted);
    await this.#choices.save({ ...record, registered: wanted });
  }

  async choose(on: boolean, eligibility: OpenAtLoginEligibility): Promise<void> {
    const wanted = eligible(eligibility) && on;
    await this.#service.sync(wanted);
    await this.#choices.save({ version: 2, choice: on ? "on" : "off", registered: wanted });
  }

  async effective(
    eligibility: OpenAtLoginEligibility,
  ): Promise<{ readonly on: boolean; readonly available: boolean }> {
    const record = await this.#record(eligibility);
    return {
      on: this.#systemEnabled() ?? record.registered,
      available: eligible(eligibility),
    };
  }

  /**
   * A Mac with no record yet starts from what the previous build registered:
   * that build opened at login exactly when this Mac had a Device Runner. What
   * macOS says now is then read against it like any other record.
   */
  async #record(eligibility: OpenAtLoginEligibility): Promise<OpenAtLoginRecord> {
    return (
      (await this.#choices.load(eligibility)) ?? {
        version: 2,
        choice: null,
        registered: eligibility.enrolledRunners,
      }
    );
  }

  /**
   * macOS saying something other than what Opensteer last asked it for is the
   * person's choice in System Settings, and is kept as theirs: losing and
   * regaining a Home later never undoes it.
   */
  #observed(record: OpenAtLoginRecord): OpenAtLoginRecord {
    const system = this.#systemEnabled();
    if (system === null || system === record.registered) return record;
    return { version: 2, choice: system ? "on" : "off", registered: system };
  }
}

function eligible(eligibility: OpenAtLoginEligibility): boolean {
  return eligibility.hostsHome || eligibility.enrolledRunners;
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
