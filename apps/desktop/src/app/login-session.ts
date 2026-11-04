import { execFile } from "node:child_process";

const consoleUsersArguments = ["-a", "-n", "Root", "-d", "1"];
const consoleUsersCommand = "/usr/sbin/ioreg";
/** The registry root prints a few hundred kilobytes. */
const consoleUsersOutputLimit = 4 * 1_024 * 1_024;
const consoleUsersTimeout = 2_000;

interface ConsoleUser {
  readonly loginDone: boolean;
  readonly onConsole: boolean;
  readonly userId: number | null;
}

/** The registry root as `ioreg` prints it. Its output names people, so it never leaves here. */
export function readConsoleUsers(
  options: {
    readonly command?: string;
    readonly outputLimit?: number;
    readonly timeout?: number;
  } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      options.command ?? consoleUsersCommand,
      consoleUsersArguments,
      {
        encoding: "utf8",
        killSignal: "SIGKILL",
        maxBuffer: options.outputLimit ?? consoleUsersOutputLimit,
        timeout: options.timeout ?? consoleUsersTimeout,
      },
      (error, output) => {
        if (error) reject(new Error("The login registry could not be read."));
        else resolve(output);
      },
    );
  });
}

/**
 * The logins in `IOConsoleUsers`, one per GUI session, or null for anything but
 * the flat entries `ioreg -a` prints: a wrong answer here hands a proof to the
 * wrong login, so unfamiliar output is never read past.
 */
export function parseConsoleUsers(plist: string): readonly ConsoleUser[] | null {
  const parts = plist.split("<key>IOConsoleUsers</key>");
  if (parts.length !== 2 || !plist.trimEnd().endsWith("</plist>")) return null;
  const entries = /^\s*<array>([\s\S]*?)<\/array>/u.exec(parts[1]!)?.[1];
  if (entries === undefined) return null;
  const entry = /\s*<dict>([\s\S]*?)<\/dict>/uy;
  const users: ConsoleUser[] = [];
  let end = 0;
  for (let found = entry.exec(entries); found !== null; found = entry.exec(entries)) {
    const user = parseConsoleUser(found[1]!);
    if (user === null) return null;
    users.push(user);
    end = entry.lastIndex;
  }
  return entries.slice(end).trim() === "" ? users : null;
}

function parseConsoleUser(fields: string): ConsoleUser | null {
  const field =
    /\s*<key>([^<]*)<\/key>\s*(?:<(true|false)\/>|<integer>(\d+)<\/integer>|<string>[^<]*<\/string>|<string\/>)/uy;
  const facts = new Map<string, boolean | number | null>();
  let end = 0;
  for (let found = field.exec(fields); found !== null; found = field.exec(fields)) {
    const [, key, flag, integer] = found;
    if (facts.has(key!)) return null;
    facts.set(key!, flag ? flag === "true" : integer ? Number(integer) : null);
    end = field.lastIndex;
  }
  if (fields.slice(end).trim() !== "") return null;
  const userId = facts.get("kCGSSessionUserIDKey");
  return {
    loginDone: facts.get("kCGSessionLoginDoneKey") === true,
    onConsole: facts.get("kCGSSessionOnConsoleKey") === true,
    userId: typeof userId === "number" ? userId : null,
  };
}

/**
 * Whether this Mac's only GUI login is this app's, on the console. Every login
 * shares loopback, and nothing a listener can see says which login's browser
 * connected: a person on a virtual display approves in a browser that reaches a
 * listener in the console's login. So a return may use loopback only when no
 * other login exists. Read each time, never remembered, and false whenever it
 * cannot be established. Only macOS reports this.
 */
export class DesktopLoginSession {
  readonly #listeners = new Set<(active: boolean) => void>();
  readonly #dispose: (() => void)[] = [];
  readonly #platform: NodeJS.Platform;
  readonly #read: () => Promise<string>;
  readonly #user: number | undefined;

  constructor(
    power: NodeJS.EventEmitter,
    platform: NodeJS.Platform,
    facts: { readonly read: () => Promise<string>; readonly user: number | undefined } = {
      read: readConsoleUsers,
      user: process.getuid?.(),
    },
  ) {
    this.#platform = platform;
    this.#read = facts.read;
    this.#user = facts.user;
    if (platform !== "darwin") return;
    for (const [event, active] of [
      ["user-did-resign-active", false],
      ["user-did-become-active", true],
    ] as const) {
      const changed = () => {
        for (const listener of this.#listeners) listener(active);
      };
      power.on(event, changed);
      this.#dispose.push(() => power.off(event, changed));
    }
  }

  async soleLogin(): Promise<boolean> {
    if (this.#platform !== "darwin" || this.#user === undefined) return false;
    const users = await this.#read().then(parseConsoleUsers, () => null);
    if (users?.length !== 1) return false;
    const [only] = users;
    return only?.userId === this.#user && only.onConsole && only.loginDone;
  }

  /** An early warning to stop listening; `soleLogin` is what decides. */
  subscribe(listener: (active: boolean) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  dispose(): void {
    for (const dispose of this.#dispose.splice(0)) dispose();
    this.#listeners.clear();
  }
}
