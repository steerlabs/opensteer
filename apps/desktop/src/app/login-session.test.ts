import { EventEmitter } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopLoginSession, parseConsoleUsers, readConsoleUsers } from "./login-session.js";

const user = 501;

/** One `IOConsoleUsers` entry as `ioreg -a` prints it, with made-up identifiers. */
function consoleUser(
  input: {
    readonly loginDone?: boolean;
    readonly onConsole?: boolean;
    readonly userId?: number;
    readonly name?: string;
  } = {},
): string {
  return `		<dict>
			<key>CGSSessionUniqueSessionUUID</key>
			<string>0410F257-814E-4489-BB4B-6211EAE6EC15</string>
			<key>kCGSSessionAuditIDKey</key>
			<integer>100029</integer>
			<key>kCGSSessionGroupIDKey</key>
			<integer>20</integer>
			<key>kCGSSessionIDKey</key>
			<integer>257</integer>
			<key>kCGSSessionLoginwindowSafeLogin</key>
			<false/>
			<key>kCGSSessionOnConsoleKey</key>
			<${input.onConsole === false ? "false" : "true"}/>
			<key>kCGSSessionSystemSafeBoot</key>
			<false/>
			<key>kCGSSessionUserIDKey</key>
			<integer>${input.userId ?? user}</integer>
			<key>kCGSSessionUserNameKey</key>
			<string>${input.name ?? "person"}</string>
			<key>kCGSessionLoginDoneKey</key>
			<${input.loginDone === false ? "false" : "true"}/>
			<key>kCGSessionLongUserNameKey</key>
			<string>A Person</string>
			<key>kSCSecuritySessionID</key>
			<integer>100029</integer>
		</dict>
`;
}

/** The registry root around the array, including the nesting the array must not be confused with. */
function registry(users: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>IOConsoleLocked</key>
	<false/>
${users}	<key>IOKitBuildVersion</key>
	<string>Darwin Kernel Version 27.0.0</string>
	<key>IOKitDiagnostics</key>
	<dict>
		<key>Classes</key>
		<dict>
			<key>ACMKernelService</key>
			<integer>7</integer>
		</dict>
	</dict>
	<key>IORegistryEntryChildren</key>
	<array>
		<dict>
			<key>IOObjectClass</key>
			<string>IOPlatformExpertDevice</string>
		</dict>
	</array>
</dict>
</plist>
`;
}

const usersKey = (entries: string) => `	<key>IOConsoleUsers</key>\n	<array>\n${entries}	</array>\n`;

function login(read: () => Promise<string>, platform: NodeJS.Platform = "darwin") {
  const power = new EventEmitter();
  return { login: new DesktopLoginSession(power, platform, { read, user }), power };
}

const allows = (output: string) => login(async () => output).login.soleLogin();

describe("DesktopLoginSession", () => {
  it("allows the one login, when it is ours, on the console and finished logging in", async () => {
    await expect(allows(registry(usersKey(consoleUser())))).resolves.toBe(true);
  });

  it.each([
    [
      "a second login, even with ours on the console",
      consoleUser() + consoleUser({ onConsole: false, userId: 502 }),
    ],
    [
      "a second login, with ours off the console",
      consoleUser({ onConsole: false }) + consoleUser({ userId: 502 }),
    ],
    ["a login that has not finished", consoleUser({ loginDone: false })],
    ["a login that is not on the console", consoleUser({ onConsole: false })],
    ["only another person's login", consoleUser({ userId: 502 })],
    ["no logins", ""],
  ])("refuses %s", async (_label, entries) => {
    await expect(allows(registry(usersKey(entries)))).resolves.toBe(false);
  });

  it("refuses an entry that does not state a fact the rule needs", async () => {
    for (const key of [
      "kCGSSessionOnConsoleKey",
      "kCGSessionLoginDoneKey",
      "kCGSSessionUserIDKey",
    ]) {
      const entry = consoleUser().replace(
        new RegExp(`\\s*<key>${key}</key>\\s*<(?:true/|false/|integer>\\d+</integer)>`, "u"),
        "",
      );
      expect(entry).not.toContain(key);
      await expect(allows(registry(usersKey(entry)))).resolves.toBe(false);
    }
  });

  it("is not fooled by a person's name", async () => {
    const name = "&lt;/dict&gt;&lt;dict&gt;&lt;key&gt;kCGSSessionUserIDKey&lt;/key&gt;";
    await expect(allows(registry(usersKey(consoleUser({ name }))))).resolves.toBe(true);
    expect(parseConsoleUsers(registry(usersKey(consoleUser({ name }))))).toHaveLength(1);
  });

  it.each([
    ["no array at all", registry("")],
    ["an empty self-closed array", registry("	<key>IOConsoleUsers</key>\n	<array/>\n")],
    ["text that is not a plist", "ioreg: not available"],
    ["empty output", ""],
    ["output cut off inside an entry", registry(usersKey(consoleUser())).slice(0, 700)],
    ["two arrays", registry(usersKey(consoleUser()) + usersKey(consoleUser()))],
    [
      "something other than a dict in the array",
      registry(usersKey(`${consoleUser()}<string>x</string>`)),
    ],
    [
      "a nested value in an entry",
      registry(usersKey(consoleUser().replace("<false/>", "<dict></dict>"))),
    ],
    [
      "a repeated key in an entry",
      registry(usersKey(consoleUser().replace("kCGSSessionIDKey", "kCGSSessionUserIDKey"))),
    ],
    [
      "a user id that is not a number",
      registry(usersKey(consoleUser().replace("<integer>501</integer>", "<string>501</string>"))),
    ],
  ])("refuses %s", async (_label, output) => {
    await expect(allows(output)).resolves.toBe(false);
  });

  it("refuses when the registry cannot be read", async () => {
    const { login: session } = login(async () => {
      throw new Error("ioreg failed");
    });
    await expect(session.soleLogin()).resolves.toBe(false);
  });

  it("refuses when its own user is unknown", async () => {
    const session = new DesktopLoginSession(new EventEmitter(), "darwin", {
      read: async () => registry(usersKey(consoleUser())),
      user: undefined,
    });
    await expect(session.soleLogin()).resolves.toBe(false);
  });

  it.each(["linux", "win32"] as const)("never reads the registry on %s", async (platform) => {
    const read = vi.fn(async () => registry(usersKey(consoleUser())));
    await expect(login(read, platform).login.soleLogin()).resolves.toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it("reads the registry every time rather than remembering", async () => {
    let output = registry(usersKey(consoleUser()));
    const { login: session } = login(async () => output);
    await expect(session.soleLogin()).resolves.toBe(true);
    output = registry(usersKey(consoleUser() + consoleUser({ onConsole: false, userId: 502 })));
    await expect(session.soleLogin()).resolves.toBe(false);
  });

  it("reports the system's session changes until disposed", () => {
    const { login: session, power } = login(async () => "");
    const changed = vi.fn();
    session.subscribe(changed);
    power.emit("user-did-resign-active");
    power.emit("user-did-become-active");
    expect(changed.mock.calls).toEqual([[false], [true]]);
    session.dispose();
    power.emit("user-did-resign-active");
    expect(changed).toHaveBeenCalledTimes(2);
  });
});

describe("readConsoleUsers", () => {
  const directories: string[] = [];
  async function script(body: string): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), "opensteer-ioreg-"));
    directories.push(directory);
    const file = path.join(directory, "ioreg");
    await writeFile(file, `#!/bin/sh\n${body}\n`);
    await chmod(file, 0o755);
    return file;
  }
  afterEach(async () => {
    for (const directory of directories.splice(0))
      await rm(directory, { force: true, recursive: true });
  });

  it("returns what the tool prints", async () => {
    await expect(
      readConsoleUsers({ command: await script("printf registry"), timeout: 2_000 }),
    ).resolves.toBe("registry");
  });

  it("rejects a non-zero exit", async () => {
    await expect(
      readConsoleUsers({ command: await script("printf partial; exit 3"), timeout: 2_000 }),
    ).rejects.toBeDefined();
  });

  it("gives up on a tool that hangs, within its timeout", async () => {
    const started = Date.now();
    await expect(
      readConsoleUsers({ command: await script("exec sleep 30"), timeout: 100 }),
    ).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("gives up on output past its bound", async () => {
    await expect(
      readConsoleUsers({
        command: await script("exec yes registry"),
        outputLimit: 4_096,
        timeout: 2_000,
      }),
    ).rejects.toBeDefined();
  });

  it("rejects a tool that is not there", async () => {
    await expect(
      readConsoleUsers({ command: "/nonexistent/ioreg", timeout: 2_000 }),
    ).rejects.toBeDefined();
  });
});
