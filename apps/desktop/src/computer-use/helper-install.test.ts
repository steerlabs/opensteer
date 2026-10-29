import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComputerUseLifecycleLockBusy,
  compareBundleVersions,
  computerUseLifecycleLockFlags,
  ensureHelperInstalled,
  isAdHocSignature,
  verifyComputerUseHelperSignature,
  withComputerUseHelperLifecycleLock,
  type ComputerUseHelperProcess,
} from "./helper-install.js";
import {
  computerUseHelperAppName,
  computerUseHelperLockPath,
  computerUseHelperRoot,
} from "./helper-paths.js";

const lockHolderFixture = path.join(import.meta.dirname, "lifecycle-lock-holder.fixture.ts");
const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    child.kill("SIGKILL");
    await once(child, "exit");
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("compareBundleVersions", () => {
  it("orders CFBundleVersion as macOS does", () => {
    expect(compareBundleVersions("1.2", "1.10")).toBe(-1);
    expect(compareBundleVersions("2", "1.99.99")).toBe(1);
    // A shorter version's missing components are zero, not absent.
    expect(compareBundleVersions("3.0.0", "3")).toBe(0);
    // Garbage never reads as newer than a real version.
    expect(compareBundleVersions("nope", "0.0.1")).toBe(-1);
  });
});

describe("isAdHocSignature", () => {
  it("recognizes only the whole line", () => {
    expect(isAdHocSignature("Identifier=x\nSignature=adhoc\nInfo.plist=not bound")).toBe(true);
    expect(isAdHocSignature("TeamIdentifier=ABCDE12345")).toBe(false);
    expect(isAdHocSignature("Signature=adhoc-ish")).toBe(false);
  });
});

describe("verifyComputerUseHelperSignature", () => {
  it("trusts the signing requirement, never the names codesign prints", async () => {
    const calls: string[][] = [];
    // What a self-signed certificate can print: any authority, any team.
    const run: ComputerUseHelperProcess = async (file, arguments_) => {
      calls.push([file, ...arguments_]);
      if (arguments_.some((argument) => argument.startsWith("-R="))) {
        throw new Error("code failed to satisfy specified code requirement(s)");
      }
      return "Identifier=com.opensteer.computer-use\nAuthority=Developer ID Application: Example\nTeamIdentifier=ABCDE12345\nCDHash=abc123\n";
    };

    await expect(
      verifyComputerUseHelperSignature(run, "/Helper.app", {
        allowAdHoc: false,
        expectedTeamId: "ABCDE12345",
      }),
    ).rejects.toThrow("Computer use helper is not signed by Opensteer.");
    const requirement = calls.flat().find((argument) => argument.startsWith("-R="));
    expect(requirement).toContain("anchor apple generic");
    expect(requirement).toContain("certificate leaf[field.1.2.840.113635.100.6.1.13]");
    expect(requirement).toContain('certificate leaf[subject.OU] = "ABCDE12345"');
    expect(requirement).toContain('identifier "com.opensteer.computer-use"');
  });
});

// The lifecycle lock is the kernel's, so this runs in the macOS CI job.
describe.runIf(process.platform === "darwin")("ensureHelperInstalled", () => {
  it("rejects with the build sentence when this build ships no helper", async () => {
    const harness = await installHarness();

    await expect(
      ensureHelperInstalled({
        bundledAppPath: path.join(harness.home, "nowhere", computerUseHelperAppName),
        deadline: soon(5_000),
        homeDirectory: harness.home,
        run: harness.run,
        teamId: null,
      }),
    ).rejects.toThrow(
      "Computer use helper is not built; run pnpm --filter desktop build:computer-use-helper.",
    );
  });

  it("installs when the canonical copy is absent", async () => {
    const harness = await installHarness();
    await harness.writeBundled("7");

    const installed = await ensureHelperInstalled(harness.options);

    expect(installed).toEqual({
      installed: true,
      launchFreshInstance: false,
      path: path.join(computerUseHelperRoot(harness.home), computerUseHelperAppName),
      protocolVersion: null,
      version: "7",
    });
    expect(await harness.installedVersion()).toBe("7");
    expect(harness.commands()).toContain("/usr/bin/ditto --noqtn");
    expect(harness.commands()).toContain("/usr/bin/codesign --verify --deep --strict");
    expect(harness.commands()).not.toContain("--prepare-replacement");
  });

  it("replaces an older canonical copy", async () => {
    const harness = await installHarness();
    await harness.writeBundled("12");
    await harness.writeInstalled("9");

    await expect(ensureHelperInstalled(harness.options)).resolves.toMatchObject({
      installed: true,
      version: "12",
    });
    expect(await harness.installedVersion()).toBe("12");
    expect(harness.commands()).toContain("--prepare-replacement");
  });

  it("keeps using a valid canonical helper whose running copy cannot stop yet", async () => {
    const harness = await installHarness({ prepareReplacementFails: true });
    await harness.writeBundled("12");
    await harness.writeInstalled("9");

    // Still a helper this app can talk to; the replacement is tried again on
    // the next connection rather than refusing the Mac until then.
    await expect(ensureHelperInstalled(harness.options)).resolves.toEqual({
      installed: false,
      launchFreshInstance: false,
      path: path.join(computerUseHelperRoot(harness.home), computerUseHelperAppName),
      protocolVersion: null,
      version: "9",
    });
    expect(await harness.installedVersion()).toBe("9");
    expect(harness.commands()).toContain("--prepare-replacement");
    expect(harness.log).toHaveBeenCalledWith(
      "desktop.computer-use.helper-replacement-refused",
      expect.objectContaining({ installed: "valid" }),
    );
  });

  it("replaces an invalid helper whose running copy cannot be verified, and launches afresh", async () => {
    const harness = await installHarness({
      installedVerifyFails: true,
      prepareReplacementFails: true,
    });
    await harness.writeBundled("12");
    await harness.writeInstalled("9");

    // Waiting for a process nobody can verify to quit would refuse this Mac
    // for as long as it runs, so the bundle is replaced and the next launch
    // starts a new instance that takes the socket from it.
    await expect(ensureHelperInstalled(harness.options)).resolves.toMatchObject({
      installed: true,
      launchFreshInstance: true,
      version: "12",
    });
    expect(await harness.installedVersion()).toBe("12");
  });

  it("leaves the same version alone", async () => {
    const harness = await installHarness();
    await harness.writeBundled("12");
    await harness.writeInstalled("12");

    await expect(ensureHelperInstalled(harness.options)).resolves.toMatchObject({
      installed: false,
      version: "12",
    });
    expect(harness.commands()).not.toContain("/usr/bin/ditto --noqtn");
  });

  it("never downgrades a newer canonical copy", async () => {
    const harness = await installHarness();
    await harness.writeBundled("12");
    // Stable and Beta refresh one path, so a Beta that installed 20 must keep
    // serving a Stable whose bundled helper is 12.
    await harness.writeInstalled("20");

    await expect(ensureHelperInstalled(harness.options)).resolves.toEqual({
      installed: false,
      launchFreshInstance: false,
      path: path.join(computerUseHelperRoot(harness.home), computerUseHelperAppName),
      protocolVersion: null,
      version: "20",
    });
    expect(await harness.installedVersion()).toBe("20");
  });

  it("verifies bundle integrity for an allowed development ad-hoc build", async () => {
    const harness = await installHarness({ adHoc: true });
    await harness.writeBundled("3");

    await expect(ensureHelperInstalled(harness.options)).resolves.toMatchObject({
      installed: true,
    });
    expect(harness.commands()).toContain("/usr/bin/codesign --verify --deep --strict");
  });

  it("replaces an equal-version development helper when its signed code changed", async () => {
    const harness = await installHarness({ installedCdHash: "old" });
    await harness.writeBundled("12");
    await harness.writeInstalled("12");

    await expect(ensureHelperInstalled(harness.options)).resolves.toMatchObject({
      installed: true,
      version: "12",
    });
  });

  it("keeps a release helper of the same version that the other channel signed", async () => {
    const harness = await installHarness({ installedCdHash: "beta" });
    await harness.writeBundled("12");
    await harness.writeInstalled("12");

    // Stable and Beta each sign their own build of one release: a different
    // hash at the same version is the same helper, not a conflict.
    await expect(
      ensureHelperInstalled({ ...harness.options, teamId: "ABCDE12345" }),
    ).resolves.toMatchObject({ installed: false, version: "12" });
    expect(harness.commands()).not.toContain("/usr/bin/ditto --noqtn");
  });

  it("replaces a release helper with a strictly newer one", async () => {
    const harness = await installHarness({ installedCdHash: "beta" });
    await harness.writeBundled("13");
    await harness.writeInstalled("12");

    await expect(
      ensureHelperInstalled({ ...harness.options, teamId: "ABCDE12345" }),
    ).resolves.toMatchObject({ installed: true, version: "13" });
  });

  it("replaces a release helper of the same version that speaks an older protocol", async () => {
    const harness = await installHarness({ installedCdHash: "release" });
    // A desktop built between releases carries the last release's version
    // with a newer protocol. Keeping the released helper of that version
    // would refuse this app's hello on every try.
    await harness.writeBundled("12", 8);
    await harness.writeInstalled("12", 7);

    await expect(
      ensureHelperInstalled({ ...harness.options, teamId: "ABCDE12345" }),
    ).resolves.toMatchObject({ installed: true, protocolVersion: 8, version: "12" });
    expect(harness.commands()).toContain("--prepare-replacement");
  });

  it("replaces a same-version helper built before helpers declared a protocol", async () => {
    const harness = await installHarness({ installedCdHash: "release" });
    await harness.writeBundled("12", 8);
    await harness.writeInstalled("12");

    await expect(
      ensureHelperInstalled({ ...harness.options, teamId: "ABCDE12345" }),
    ).resolves.toMatchObject({ installed: true, protocolVersion: 8, version: "12" });
  });

  it("keeps a same-version helper that speaks a newer protocol", async () => {
    const harness = await installHarness({ installedCdHash: "main" });
    // The released app of that version still speaks to it, so swapping it
    // back would only make the two apps trade the helper on every launch.
    await harness.writeBundled("12", 7);
    await harness.writeInstalled("12", 8);

    await expect(
      ensureHelperInstalled({ ...harness.options, teamId: "ABCDE12345" }),
    ).resolves.toMatchObject({ installed: false, protocolVersion: 8, version: "12" });
    expect(harness.commands()).not.toContain("/usr/bin/ditto --noqtn");
  });

  it("keeps an older-version helper that speaks a newer protocol", async () => {
    const harness = await installHarness({ installedCdHash: "branch" });
    await harness.writeBundled("13", 7);
    await harness.writeInstalled("12", 8);

    await expect(
      ensureHelperInstalled({ ...harness.options, teamId: "ABCDE12345" }),
    ).resolves.toMatchObject({ installed: false, protocolVersion: 8, version: "12" });
  });

  it("replaces a newer-version helper that cannot speak this app's protocol", async () => {
    const harness = await installHarness({ installedCdHash: "release" });
    await harness.writeBundled("12", 8);
    await harness.writeInstalled("13", 7);

    await expect(
      ensureHelperInstalled({ ...harness.options, teamId: "ABCDE12345" }),
    ).resolves.toMatchObject({ installed: true, protocolVersion: 8, version: "12" });
  });

  it("reads a protocol that is not a positive whole number as none", async () => {
    const harness = await installHarness({ installedCdHash: "release" });
    await harness.writeBundled("12", 1);
    // A string, a fraction or zero never outranks a declared protocol.
    for (const declared of ["99", 99.5, 0]) {
      await harness.writeInstalled("12", declared);

      await expect(
        ensureHelperInstalled({ ...harness.options, teamId: "ABCDE12345" }),
      ).resolves.toMatchObject({ installed: true, protocolVersion: 1, version: "12" });
    }
  });

  it("rejects an ad-hoc helper under the packaged release policy", async () => {
    const harness = await installHarness({ adHoc: true });
    await harness.writeBundled("12");

    await expect(
      ensureHelperInstalled({ ...harness.options, teamId: "ABCDE12345" }),
    ).rejects.toThrow(/ad-hoc signed/u);
  });

  it("leaves the previous copy in place when the copy fails verification", async () => {
    const harness = await installHarness({ verifyFails: true });
    await harness.writeBundled("12");
    await harness.writeInstalled("9");

    await expect(ensureHelperInstalled(harness.options)).rejects.toThrow(/codesign/u);
    expect(await harness.installedVersion()).toBe("9");
  });

  it("replaces an invalid canonical helper even when its claimed version is newer", async () => {
    const harness = await installHarness({ installedVerifyFails: true });
    await harness.writeBundled("12");
    await harness.writeInstalled("20");

    await expect(ensureHelperInstalled(harness.options)).resolves.toMatchObject({
      installed: true,
      version: "12",
    });
    expect(await harness.installedVersion()).toBe("12");
  });

  it("gives up at its deadline rather than racing another Opensteer's install", async () => {
    const harness = await installHarness();
    await harness.writeBundled("4");
    await mkdir(computerUseHelperRoot(harness.home), { mode: 0o700, recursive: true });
    const holder = heldUntilReleased(computerUseHelperLockPath(harness.home));
    await holder.held;

    await expect(ensureHelperInstalled({ ...harness.options, deadline: soon(40) })).rejects.toThrow(
      /Another Opensteer is starting or updating Computer use/u,
    );
    expect(harness.commands()).not.toContain("/usr/bin/ditto");
    holder.release();
    await holder.done;
  });
});

// The lifecycle lock is the kernel's, so this runs in the macOS CI job.
describe.runIf(process.platform === "darwin")("the helper lifecycle lock", () => {
  it("admits one holder at a time and hands it on when the holder is done", async () => {
    const lockPath = await lockFile();
    let holders = 0;
    let most = 0;
    const hold = async (): Promise<void> => {
      await withComputerUseHelperLifecycleLock({ deadline: soon(5_000), lockPath }, async () => {
        holders += 1;
        most = Math.max(most, holders);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
        holders -= 1;
      });
    };

    await Promise.all([hold(), hold(), hold()]);

    expect(most).toBe(1);
  });

  it("refuses a waiter whose deadline passes while somebody else holds it", async () => {
    const lockPath = await lockFile();
    const holder = heldUntilReleased(lockPath);
    await holder.held;

    await expect(
      withComputerUseHelperLifecycleLock({ deadline: soon(40), lockPath }, async () => "late"),
    ).rejects.toBeInstanceOf(ComputerUseLifecycleLockBusy);
    holder.release();
    await holder.done;
  });

  it("reads the deadline on every attempt, so a joiner can extend it", async () => {
    const lockPath = await lockFile();
    const holder = heldUntilReleased(lockPath);
    await holder.held;
    const deadline = { at: Date.now() + 40 };

    const waiting = withComputerUseHelperLifecycleLock({ deadline, lockPath }, async () => "held");
    deadline.at = Date.now() + 5_000;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
    holder.release();

    await expect(waiting).resolves.toBe("held");
  });
});

describe.runIf(process.platform === "darwin")("the helper lifecycle lock on macOS", () => {
  it("opens with darwin's O_EXLOCK, which Node does not export", async () => {
    // The flag is a literal because Node's constants lack it; if a Node ever
    // exports it, the two must agree.
    const exported = (constants as Readonly<Record<string, number | undefined>>).O_EXLOCK;
    if (exported !== undefined) expect(lockFlags() & exported).toBe(exported);
    expect(lockFlags() & 0x20).toBe(0x20);
    expect(lockFlags() & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);

    // What the value means, proven on the kernel rather than read from a
    // header: a second open of a file somebody holds is refused at once.
    const lockPath = await lockFile();
    const first = await open(lockPath, lockFlags(), 0o600);
    const second = await open(lockPath, lockFlags(), 0o600).catch((error: unknown) => error);
    expect(second).toMatchObject({ code: "EAGAIN" });
    await first.close();
    const third = await open(lockPath, lockFlags(), 0o600);
    await third.close();
  });

  it("never removes its file, which is what the lock is on", async () => {
    const lockPath = await lockFile();

    await withComputerUseHelperLifecycleLock({ deadline: soon(1_000), lockPath }, async () => "ok");

    await expect(lstat(lockPath)).resolves.toMatchObject({});
  });

  it("excludes another process, and is freed by the kernel when that process is killed", async () => {
    const lockPath = await lockFile();
    const other = lockProcess(lockPath, 10_000);
    await expect(other.next()).resolves.toBe("held");

    // Another Opensteer holds it: this one waits, and is refused at its deadline.
    await expect(
      withComputerUseHelperLifecycleLock({ deadline: soon(150), lockPath }, async () => "raced"),
    ).rejects.toBeInstanceOf(ComputerUseLifecycleLockBusy);
    let entered = false;
    const waiting = withComputerUseHelperLifecycleLock({ deadline: soon(10_000), lockPath }, () => {
      entered = true;
      return Promise.resolve("after");
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    expect(entered).toBe(false);

    // No pid, age or heartbeat decides it: the holder dies, and with it the lock.
    other.child.kill("SIGKILL");
    await other.exited;
    await expect(waiting).resolves.toBe("after");
  });

  it("keeps another process out while this one holds it", async () => {
    const lockPath = await lockFile();
    const holder = heldUntilReleased(lockPath);
    await holder.held;

    try {
      // Deliver the result only after exit, as when the parent is slow to read it.
      const refused = lockProcess(lockPath, 150, { deliverAfterExit: true });
      await expect(refused.next()).resolves.toBe("busy");
      await refused.exited;

      holder.release();
      await holder.done;
      const admitted = lockProcess(lockPath, 5_000);
      await expect(admitted.next()).resolves.toBe("held");
      admitted.child.stdin?.end();
      await expect(admitted.next()).resolves.toBe("released");
      await admitted.exited;
    } finally {
      holder.release();
      await holder.done;
    }
  });
});

/** A lock path in a fresh directory. */
async function lockFile(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "opensteer-cu-lock-"));
  roots.push(directory);
  return path.join(directory, "lifecycle.lock");
}

function soon(milliseconds: number): { readonly at: number } {
  return { at: Date.now() + milliseconds };
}

function lockFlags(): number {
  if (computerUseLifecycleLockFlags === null) throw new Error("This platform has no O_EXLOCK");
  return computerUseLifecycleLockFlags;
}

/** This process holding the lock until `release` is called. */
function heldUntilReleased(lockPath: string) {
  let release: () => void = () => undefined;
  let held: () => void = () => undefined;
  const heldPromise = new Promise<void>((resolvePromise) => {
    held = resolvePromise;
  });
  const done = withComputerUseHelperLifecycleLock({ deadline: soon(5_000), lockPath }, async () => {
    held();
    await new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
  });
  return { done, held: heldPromise, release: () => release() };
}

/**
 * Another Opensteer process taking the same lock through the real module.
 * `next` resolves with each line it prints: `held`, `busy` or `released`.
 */
function lockProcess(
  lockPath: string,
  waitMs: number,
  options: { readonly deliverAfterExit?: boolean } = {},
) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", lockHolderFixture, lockPath, String(waitMs)],
    { cwd: path.dirname(lockHolderFixture), stdio: ["pipe", "pipe", "inherit"] },
  );
  children.push(child);
  // stdout delivery and child exit have no consumer-side ordering. Subscribe
  // at spawn so a slow reader cannot miss an exit that already happened.
  const exited = once(child, "exit");
  const lines: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  let buffered = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    if (options.deliverAfterExit) {
      void exited.then(() => receive(chunk));
    } else {
      receive(chunk);
    }
  });
  function receive(chunk: string): void {
    buffered += chunk;
    for (;;) {
      const end = buffered.indexOf("\n");
      if (end < 0) break;
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else lines.push(line);
    }
  }
  return {
    child,
    exited,
    next: async (): Promise<string> => {
      const line = lines.shift();
      if (line !== undefined) return line;
      return await new Promise<string>((resolvePromise) => waiters.push(resolvePromise));
    },
  };
}

async function installHarness(
  behavior: {
    adHoc?: boolean;
    installedCdHash?: string;
    installedVerifyFails?: boolean;
    prepareReplacementFails?: boolean;
    verifyFails?: boolean;
  } = {},
) {
  const home = await mkdtemp(path.join(tmpdir(), "opensteer-cu-install-"));
  roots.push(home);
  const bundledAppPath = path.join(home, "bundled", computerUseHelperAppName);
  const calls: string[][] = [];
  const plists = new Map<string, Record<string, unknown>>();
  const run: ComputerUseHelperProcess = async (file, arguments_) => {
    calls.push([file, ...arguments_]);
    if (file === "/usr/bin/plutil") {
      const plistPath = arguments_.at(-1) ?? "";
      const plist = plists.get(path.resolve(plistPath));
      if (!plist) throw new Error(`no plist at ${plistPath}`);
      return JSON.stringify(plist);
    }
    if (file === "/usr/bin/ditto") {
      const [, from, to] = arguments_;
      if (!from || !to) throw new Error("ditto needs a source and a target");
      await cp(from, to, { recursive: true });
      plists.set(
        path.resolve(to, "Contents", "Info.plist"),
        plists.get(path.resolve(from, "Contents", "Info.plist")) ?? { CFBundleVersion: "0" },
      );
      return "";
    }
    if (file === "/usr/bin/codesign" && arguments_[0] === "-dv") {
      const appPath = arguments_.at(-1) ?? "";
      const installed = appPath.includes(`${computerUseHelperRoot(home)}/`);
      const cdHash = installed ? (behavior.installedCdHash ?? "same") : "same";
      return behavior.adHoc
        ? `Identifier=com.opensteer.computer-use\nSignature=adhoc\nCDHash=${cdHash}\n`
        : `Identifier=com.opensteer.computer-use\nAuthority=Developer ID Application: Example\nTeamIdentifier=ABCDE12345\nCDHash=${cdHash}\n`;
    }
    if (file === "/usr/bin/codesign" && arguments_[0] === "--verify") {
      if (behavior.verifyFails) throw new Error("codesign refused the staged copy");
      const appPath = path.resolve(arguments_.at(-1) ?? "");
      const canonical = path.resolve(computerUseHelperRoot(home), computerUseHelperAppName);
      if (behavior.installedVerifyFails && appPath === canonical) {
        throw new Error("codesign refused the canonical copy");
      }
      return "";
    }
    if (arguments_.length === 1 && arguments_[0] === "--prepare-replacement") {
      if (behavior.prepareReplacementFails) {
        throw new Error("the canonical helper is still running");
      }
      return "";
    }
    throw new Error(`unexpected command ${file}`);
  };
  const log = vi.fn();
  /** `protocol` is what the bundle's plist declares; a helper built before declaring one has none. */
  const writeBundle = async (appPath: string, version: string, protocol?: unknown) => {
    const plistPath = path.join(appPath, "Contents", "Info.plist");
    await mkdir(path.dirname(plistPath), { recursive: true });
    await writeFile(plistPath, `<plist>${version}</plist>`);
    plists.set(path.resolve(plistPath), {
      CFBundleVersion: version,
      ...(protocol === undefined ? {} : { OpensteerProtocolVersion: protocol }),
    });
  };
  return {
    bundledAppPath,
    commands: () => calls.map((call) => call.join(" ")).join("\n"),
    home,
    installedVersion: async () => {
      const plistPath = path.join(
        computerUseHelperRoot(home),
        computerUseHelperAppName,
        "Contents",
        "Info.plist",
      );
      const body = await readFile(plistPath, "utf8").catch(() => null);
      return body === null ? null : /<plist>(.*)<\/plist>/u.exec(body)?.[1];
    },
    log,
    options: { bundledAppPath, deadline: soon(5_000), homeDirectory: home, log, run, teamId: null },
    run,
    writeBundled: (version: string, protocol?: unknown) =>
      writeBundle(bundledAppPath, version, protocol),
    writeInstalled: (version: string, protocol?: unknown) =>
      writeBundle(
        path.join(computerUseHelperRoot(home), computerUseHelperAppName),
        version,
        protocol,
      ),
  };
}
