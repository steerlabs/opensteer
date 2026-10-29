import { startEchoTestServer as startEchoServer } from "@opensteer/shared/test-support/tcpServer";
import { connect, createServer } from "node:net";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MachineAccessSetup } from "@opensteer/runner";
import {
  createMachineAccessDatabase,
  executeFile,
  machineAccessHistory,
  resetMachineAccessDatabase,
  runCommand,
  runShim,
  startMachineAccessScenario,
  startShim,
  updateAccessPolicy,
  waitForCondition,
  type MachineAccessScenario,
  type RunningShim,
  type ShimResult,
} from "./machine-access.test-support.js";

/**
 * The caller and the target are the same computer here, which is what makes
 * these assertions checkable: the shares are directories this test wrote, and
 * the commands run as the account running the test.
 *
 * The Host with its shell hub and routes, the target's `shell` module handler
 * attached over the real auxiliary handshake, and the built Go helper are all
 * production code. The caller's launch directory is produced by the production
 * `setupMachineAccess` from the exact machine list and bearer the Host
 * dispatched with the Run; the test then runs that directory's shims itself,
 * because no harness here can be asked to type an arbitrary `ssh` on demand.
 */
const baseDatabaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
/**
 * The account's home from its user record. The target's shell starts there and
 * its SFTP paths resolve from it, whatever HOME this process has; HOME itself
 * is inherited from the Runner's environment.
 */
const accountHome = userInfo().homedir;
const integration = baseDatabaseUrl ? describe : describe.skip;
let database: Awaited<ReturnType<typeof createMachineAccessDatabase>> | undefined;
let databaseUrl = "postgres://unconfigured";
// The helper runs `$SHELL -c`, so the tests pin the shell they assert against.
process.env.SHELL = "/bin/sh";

integration("Machine access, end to end", () => {
  beforeAll(async () => {
    database = await createMachineAccessDatabase(baseDatabaseUrl ?? "");
    databaseUrl = database.url;
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
    database = undefined;
  }, 120_000);

  let scenario: MachineAccessScenario | undefined;
  let readShare = "";
  let writeShare = "";
  let homeShare = "";

  beforeEach(async () => {
    await resetMachineAccessDatabase(databaseUrl);
    readShare = await realpath(await mkdtemp(join(tmpdir(), "opensteer-ma-read-")));
    writeShare = await realpath(await mkdtemp(join(tmpdir(), "opensteer-ma-write-")));
    homeShare = await realpath(await mkdtemp(join(accountHome, ".opensteer-ma-home-")));
  });

  afterEach(async () => {
    await scenario?.close();
    scenario = undefined;
    for (const directory of [readShare, writeShare, homeShare]) {
      if (directory) await rm(directory, { force: true, recursive: true });
    }
  }, 60_000);

  it("names the target in the Run's machine access, its known hosts and its pinned ssh config", async () => {
    scenario = await startMachineAccessScenario(databaseUrl, {
      fullDiskAccess: false,
      policy: {
        commands: true,
        forwarding: false,
        reach: "owner",
        shares: [
          { mode: "read", path: readShare },
          { mode: "read-write", path: writeShare },
        ],
      },
    });
    const { alias, launch, run, target } = scenario;
    expect(alias).toBe("example-mac");
    // Reporting Full Disk Access makes the target a Mac on whatever computer runs this.
    expect(run.machineAccess).toEqual({
      callerMachineName: "Caller computer",
      machines: [
        {
          alias: "example-mac",
          commands: true,
          forwarding: false,
          fullDiskAccess: false,
          hostPublicKey: target.hostPublicKey,
          lastSeenAt: expect.any(String),
          name: "Example Mac",
          platform: "darwin",
          runnerId: target.runnerId,
          shares: [
            { mode: "read", path: readShare },
            { mode: "read-write", path: writeShare },
          ],
          status: "online",
        },
      ],
      omittedMachines: 0,
    });
    expect(launch.machineAccessNotice).toContain(
      `- example-mac (macOS, online): shares ${readShare} (read-only), ${writeShare} (read-write); commands allowed; port forwarding off; macOS Full Disk Access off (some protected data may be unavailable).`,
    );

    const knownHosts = await readFile(join(launch.launchDirectory, "known_hosts"), "utf8");
    expect(knownHosts).toBe(`${target.runnerId} ${target.hostPublicKey}\n`);
    // Every security-relevant keyword is pinned in the managed block itself, so
    // nothing included later can change what this alias does.
    const config = await readFile(join(launch.launchDirectory, "ssh_config"), "utf8");
    expect(config.split("\n\n")[0]?.split("\n")).toEqual([
      "Host example-mac",
      `  HostName ${target.runnerId}`,
      "  User opensteer",
      expect.stringContaining("  ProxyCommand "),
      `  UserKnownHostsFile "${join(launch.launchDirectory, "known_hosts")}"`,
      "  StrictHostKeyChecking yes",
      "  CheckHostIP no",
      "  IdentitiesOnly yes",
      "  IdentityFile none",
      "  IdentityAgent none",
      "  PreferredAuthentications none",
      "  BatchMode yes",
      "  ControlMaster no",
      "  ControlPath none",
      "  ControlPersist no",
      "  ForwardAgent no",
      "  ForwardX11 no",
      "  ClearAllForwardings no",
      "  RequestTTY no",
      "  ServerAliveInterval 15",
      "  ServerAliveCountMax 3",
      "  GlobalKnownHostsFile /dev/null",
      "  KnownHostsCommand none",
      "  VerifyHostKeyDNS no",
      "  UpdateHostKeys no",
      "  HostKeyAlgorithms ssh-ed25519",
      "  CanonicalizeHostname no",
    ]);

    const resolved = await executeFile(
      "/usr/bin/ssh",
      ["-G", alias, "-F", join(launch.launchDirectory, "ssh_config")],
      { encoding: "utf8", maxBuffer: 4 * 1_024 * 1_024 },
    );
    const keywords = new Map(
      resolved.stdout
        .split("\n")
        .filter((line) => line.includes(" "))
        .map((line) => [line.slice(0, line.indexOf(" ")), line.slice(line.indexOf(" ") + 1)]),
    );
    expect(keywords.get("hostname")).toBe(target.runnerId);
    expect(keywords.get("user")).toBe("opensteer");
    expect(keywords.get("userknownhostsfile")).toBe(join(launch.launchDirectory, "known_hosts"));
    expect(keywords.get("globalknownhostsfile")).toBe("/dev/null");
    expect(keywords.get("stricthostkeychecking")).toBe("true");
    expect(keywords.get("checkhostip")).toBe("no");
    expect(keywords.get("identitiesonly")).toBe("yes");
    expect(keywords.get("identityfile")).toBe("none");
    expect(keywords.get("identityagent")).toBe("none");
    expect(keywords.get("preferredauthentications")).toBe("none");
    expect(keywords.get("batchmode")).toBe("yes");
    expect(keywords.get("controlmaster")).toBe("false");
    expect(keywords.get("controlpersist")).toBe("no");
    expect(keywords.get("forwardagent")).toBe("no");
    expect(keywords.get("forwardx11")).toBe("no");
    expect(keywords.get("clearallforwardings")).toBe("no");
    expect(keywords.get("requesttty")).toBe("false");
    expect(keywords.get("serveraliveinterval")).toBe("15");
    expect(keywords.get("serveralivecountmax")).toBe("3");
    expect(keywords.get("hostkeyalgorithms")).toBe("ssh-ed25519");
    expect(keywords.get("canonicalizehostname")).toBe("false");
    expect(keywords.get("proxycommand")).toContain("ssh-proxy --relay");
    expect(keywords.get("proxycommand")).toContain(launch.machineAccessRelaySocket);
  }, 120_000);

  it("runs a command on the target, half-closes its input, and leaks no Opensteer environment", async () => {
    scenario = await startMachineAccessScenario(databaseUrl, {
      policy: { commands: true, forwarding: false, reach: "owner", shares: [] },
    });
    const { alias, launch } = scenario;

    const exec = await runShim(launch, "ssh", [alias, "printf hello; printf err >&2; exit 3"]);
    expect(exec).toEqual({ code: 3, signal: null, stderr: "err", stdout: "hello" });

    const halfClosed = await runShim(launch, "ssh", [alias, "cat; echo done"], { input: "data" });
    expect(halfClosed).toEqual({ code: 0, signal: null, stderr: "", stdout: "datadone\n" });

    const home = await runShim(launch, "ssh", [alias, "echo $HOME"]);
    expect(home).toEqual({ code: 0, signal: null, stderr: "", stdout: `${homedir()}\n` });

    const leaked = await runShim(launch, "ssh", [alias, "env | grep -c OPENSTEER"]);
    expect(leaked.stdout).toBe("0\n");

    const cwd = await runShim(launch, "ssh", [alias, "pwd"]);
    expect(cwd.stdout).toBe(`${accountHome}\n`);

    // `rsync` reaches the target through the same shim, because it looks `ssh`
    // up on PATH like everything else. It is a command rather than an SFTP
    // client, so it reads what the account can read and no share is involved.
    const rsync = await executableOnPath("rsync");
    if (rsync) {
      const outside = await mkdtemp(join(tmpdir(), "opensteer-ma-outside-"));
      try {
        await writeFile(join(outside, "unshared.txt"), "not a share");
        const synced = await runCommand(
          rsync,
          [
            "-e",
            join(launch.launchDirectory, "bin", "ssh"),
            `${alias}:${join(outside, "unshared.txt")}`,
            join(outside, "copied.txt"),
          ],
          { environment: launch.environment },
        );
        expect(synced).toMatchObject({ code: 0 });
        await expect(readFile(join(outside, "copied.txt"), "utf8")).resolves.toBe("not a share");
      } finally {
        await rm(outside, { force: true, recursive: true });
      }
    }
  }, 120_000);

  it("serves shares over scp and sftp and refuses everything outside them", async () => {
    const remoteNames = ["download.txt", "a spaced name.txt", "ünïcødé-ファイル.txt"] as const;
    for (const name of remoteNames) await writeFile(join(readShare, name), `body of ${name}`);
    await mkdir(join(homeShare, "nested"), { recursive: true });
    await writeFile(join(homeShare, "nested", "home.txt"), "from home");
    scenario = await startMachineAccessScenario(databaseUrl, {
      policy: {
        commands: false,
        forwarding: false,
        reach: "owner",
        shares: [
          { mode: "read", path: readShare },
          { mode: "read", path: homeShare },
          { mode: "read-write", path: writeShare },
        ],
      },
    });
    const { alias, launch } = scenario;
    const local = await mkdtemp(join(tmpdir(), "opensteer-ma-local-"));
    try {
      for (const name of remoteNames) {
        const downloaded = await runShim(launch, "scp", [
          `${alias}:${join(readShare, name)}`,
          join(local, name),
        ]);
        expect(downloaded).toMatchObject({ code: 0 });
        await expect(readFile(join(local, name), "utf8")).resolves.toBe(`body of ${name}`);
      }

      await writeFile(join(local, "upload.txt"), "uploaded body");
      const refusedUpload = await runShim(launch, "scp", [
        join(local, "upload.txt"),
        `${alias}:${join(readShare, "upload.txt")}`,
      ]);
      expect(refusedUpload.code).not.toBe(0);
      expect(refusedUpload.stderr).toContain("Permission denied");
      await expect(readFile(join(readShare, "upload.txt"), "utf8")).rejects.toThrow();
      // `scp` reports only the status code, so the helper's own sentence is
      // checked where a client does surface it.
      const refusedPut = await sftpBatch(
        launch,
        alias,
        `put "${join(local, "upload.txt")}" "${join(readShare, "upload.txt")}"\n`,
      );
      expect(refusedPut.code).not.toBe(0);
      expect(refusedPut.stderr).toContain("Permission denied");

      const acceptedUpload = await runShim(launch, "scp", [
        join(local, "upload.txt"),
        `${alias}:${join(writeShare, "upload.txt")}`,
      ]);
      expect(acceptedUpload).toMatchObject({ code: 0 });
      await expect(readFile(join(writeShare, "upload.txt"), "utf8")).resolves.toBe("uploaded body");

      const unicodeUpload = await runShim(launch, "scp", [
        join(local, "ünïcødé-ファイル.txt"),
        `${alias}:${join(writeShare, "ünïcødé-ファイル.txt")}`,
      ]);
      expect(unicodeUpload).toMatchObject({ code: 0 });
      await expect(readFile(join(writeShare, "ünïcødé-ファイル.txt"), "utf8")).resolves.toBe(
        "body of ünïcødé-ファイル.txt",
      );

      // `/` and every ancestor of a share are synthetic: they list the branch
      // that leads to a share and nothing else the real directory holds.
      const listed = await sftpBatch(launch, alias, "ls -1 /\n");
      expect(listed).toMatchObject({ code: 0 });
      expect(sftpEntries(listed.stdout)).toEqual(
        new Set([topComponent(readShare), topComponent(homeShare), topComponent(writeShare)]),
      );

      // Shares are matched by path component, so a sibling that merely shares
      // the share's prefix is outside it.
      const outside = await sftpBatch(launch, alias, `ls -1 ${readShare}2\n`);
      expect(outside.code).not.toBe(0);
      // OpenSSH's sftp prints its own text for a status code, so the sentence
      // the helper actually sent is read where it is kept verbatim. The Host
      // records audit events off the control stream, so history catches up
      // after the client has already seen the refusal.
      const shares = [
        `${readShare} (read-only)`,
        `${homeShare} (read-only)`,
        `${writeShare} (read-write)`,
      ].sort();
      const { host, target } = scenario;
      const denials = async () =>
        (await machineAccessHistory(host, target.runnerId)).sessions
          .flatMap((session) => session.events)
          .flatMap((event) => (event.kind === "denied" ? [event.detail] : []));
      await expect
        .poll(denials)
        .toContain(`Not shared. ${target.name} shares: ${shares.join(", ")}.`);
      expect(await denials()).toContain(`Shared folder ${readShare} is read-only.`);

      const crossShareRename = await sftpBatch(
        launch,
        alias,
        `rename ${join(writeShare, "upload.txt")} ${join(readShare, "upload.txt")}\n`,
      );
      expect(crossShareRename.code).not.toBe(0);
      await expect(readFile(join(writeShare, "upload.txt"), "utf8")).resolves.toBe("uploaded body");

      // A relative path and a `~/` path both name the account's home, which is
      // the only namespace the agent was told about.
      const relative = await sftpBatch(
        launch,
        alias,
        `get "${relativeToHome(homeShare)}/nested/home.txt" "${join(local, "relative.txt")}"\n`,
      );
      expect(relative).toMatchObject({ code: 0 });
      await expect(readFile(join(local, "relative.txt"), "utf8")).resolves.toBe("from home");

      const tilde = await sftpBatch(
        launch,
        alias,
        `get "~/${relativeToHome(homeShare)}/nested/home.txt" "${join(local, "tilde.txt")}"\n`,
      );
      expect(tilde).toMatchObject({ code: 0 });
      await expect(readFile(join(local, "tilde.txt"), "utf8")).resolves.toBe("from home");
    } finally {
      await rm(local, { force: true, recursive: true });
    }
  }, 180_000);

  it("refuses commands, interactive terminals and port forwarding exactly as the policy says", async () => {
    scenario = await startMachineAccessScenario(databaseUrl, {
      policy: { commands: false, forwarding: false, reach: "owner", shares: [] },
    });
    const { alias, host, launch, target } = scenario;
    const machine = target.name;

    const refusedCommand = await runShim(launch, "ssh", [alias, "true"]);
    expect(refusedCommand).toEqual({
      code: 126,
      signal: null,
      stderr: `${machine} does not allow commands from other computers.\n`,
      stdout: "",
    });

    const refusedShell = await runShim(launch, "ssh", [alias]);
    expect(refusedShell).toEqual({
      code: 126,
      signal: null,
      stderr: "Opensteer does not provide interactive terminals; run a command.\n",
      stdout: "",
    });

    const echo = await startEchoServer();
    try {
      const refusedPort = await freeLocalPort();
      const refusedForward = startShim(launch, "ssh", [
        "-N",
        "-L",
        `${refusedPort}:127.0.0.1:${echo.port}`,
        alias,
      ]);
      await waitForForwardListener(refusedForward, refusedPort);
      expect(await probeEcho(refusedPort)).toBe("channel-refused");
      refusedForward.kill();
      await refusedForward.exited;

      await updateAccessPolicy(host, {
        expectedRevision: 2,
        key: "policy-forwarding",
        policy: { commands: false, forwarding: true, reach: "owner", shares: [] },
        runnerId: target.runnerId,
      });
      const allowedPort = await freeLocalPort();
      const allowedForward = startShim(launch, "ssh", [
        "-N",
        "-L",
        `${allowedPort}:127.0.0.1:${echo.port}`,
        alias,
      ]);
      await waitForForwardListener(allowedForward, allowedPort);
      await waitForCondition(async () => (await probeEcho(allowedPort)) === "ping-pong");
      allowedForward.kill();
      await allowedForward.exited;
    } finally {
      await echo.close();
    }
  }, 180_000);
});

/** Waits for `ssh -N -L` to be listening, and says why if it stopped instead. */
async function waitForForwardListener(shim: RunningShim, port: number): Promise<void> {
  let exited: ShimResult | undefined;
  void shim.exited.then((result) => (exited = result));
  const deadline = Date.now() + 15_000;
  for (;;) {
    if ((await probeEcho(port)) !== "no-listener") return;
    if (exited) throw new Error(`ssh -N -L stopped: ${JSON.stringify(exited)}`);
    if (Date.now() >= deadline) throw new Error("ssh -N -L never listened");
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

/** The first match on PATH, or nothing when this computer has no such tool. */
async function executableOnPath(name: string): Promise<string | undefined> {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue in PATH order, exactly as a shell would.
    }
  }
  return undefined;
}

function topComponent(path: string): string {
  return `/${path.split("/")[1] ?? ""}`;
}

function relativeToHome(path: string): string {
  return path.slice(accountHome.length + 1);
}

function sftpEntries(output: string): Set<string> {
  return new Set(
    output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("sftp>")),
  );
}

async function sftpBatch(launch: MachineAccessSetup, alias: string, script: string) {
  const batch = join(launch.launchDirectory, `batch-${Math.random().toString(36).slice(2)}.txt`);
  await writeFile(batch, script);
  try {
    return await runShim(launch, "sftp", ["-b", batch, alias]);
  } finally {
    await rm(batch, { force: true });
  }
}

async function freeLocalPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no free port");
  const { port } = address;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * What a connection through a forwarded port finds: nothing listening yet, a
 * listener whose channel the target refused, or a working round trip.
 */
function probeEcho(port: number): Promise<"no-listener" | "channel-refused" | "ping-pong"> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    let settled = false;
    const settle = (value: "no-listener" | "channel-refused" | "ping-pong") => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    let connected = false;
    socket.once("error", () => settle(connected ? "channel-refused" : "no-listener"));
    socket.once("connect", () => {
      connected = true;
      socket.write("ping");
    });
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).toString("utf8") === "ping") settle("ping-pong");
    });
    socket.once("close", () => settle("channel-refused"));
    setTimeout(() => settle("channel-refused"), 3_000).unref();
  });
}
