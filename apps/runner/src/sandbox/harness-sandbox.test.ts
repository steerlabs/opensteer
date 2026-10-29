import type { HarnessProviderState } from "@opensteer/harness";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  harnessSandboxMounts,
  harnessSandboxRequired,
  programSandboxMounts,
  type HarnessSandboxLayout,
  type HarnessSandboxRunPlan,
} from "./harness-sandbox.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("harness sandbox mounts", () => {
  it("masks the shared attachment cache and exposes only this Thread's verified directory", async () => {
    const fixture = await createFixture();
    const root = join(fixture.externalRoot, "attachments");
    const own = join(root, "thr_a");
    const other = join(root, "thr_b");
    await mkdir(own, { recursive: true });
    await mkdir(other);
    const args = await mounts(fixture, { attachmentDirectory: own }, fixture.environment, {
      attachmentRoot: root,
    });
    expect(maskIndex(args, "0700", root)).toBeGreaterThanOrEqual(0);
    expect(segmentIndex(args, readOnlyBind(own))).toBeGreaterThanOrEqual(0);
    expect(args).not.toContain(other);
  });
  it("masks every shared root once, ancestors first, before any re-exposure", async () => {
    const fixture = await createFixture();
    const args = await mounts(fixture);

    expect(args.slice(0, 7)).toEqual(["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"]);

    const masked = maskedPaths(args);
    expect(new Set(masked).size).toBe(masked.length);
    expect(new Set(masked)).toEqual(
      new Set([
        fixture.temporaryDirectory,
        fixture.dataDirectory,
        fixture.backingRoot,
        fixture.home,
        "/tmp",
      ]),
    );
    expect(maskIndex(args, "0700", fixture.dataDirectory)).toBeGreaterThanOrEqual(0);
    expect(maskIndex(args, "0700", fixture.backingRoot)).toBeGreaterThanOrEqual(0);
    expect(maskIndex(args, "0700", fixture.home)).toBeGreaterThanOrEqual(0);
    expect(maskIndex(args, "1777", fixture.temporaryDirectory)).toBeGreaterThanOrEqual(0);
    expect(maskIndex(args, "1777", "/tmp")).toBeGreaterThanOrEqual(0);

    // The fixture lives under the system temporary directory, so the tmpfs
    // that erases the data directory must be created inside the one that
    // erases its ancestor, not before it.
    expect(masked.indexOf(fixture.temporaryDirectory)).toBeLessThan(
      masked.indexOf(fixture.dataDirectory),
    );
    expect(masked.indexOf(fixture.dataDirectory)).toBeLessThan(masked.indexOf(fixture.backingRoot));

    // Nothing comes back before every mask is in place, and the directory the
    // harness will use as TMPDIR is created between the two.
    const lastMask = Math.max(...maskIndexes(args));
    const configuredTmp = segmentIndex(args, ["--dir", fixture.configuredTemporaryDirectory]);
    expect(configuredTmp).toBeGreaterThan(lastMask);
    const exposures = exposureIndexes(args);
    expect(exposures.length).toBeGreaterThan(0);
    expect(Math.min(...exposures)).toBeGreaterThan(configuredTmp);
  });

  it("re-exposes only this profile's and this Thread's directories", async () => {
    const fixture = await createFixture();
    const args = await mounts(fixture);

    expect(segmentIndex(args, bind(fixture.providerHome))).toBeGreaterThanOrEqual(0);
    expect(segmentIndex(args, bind(fixture.storeDirectory))).toBeGreaterThanOrEqual(0);
    expect(segmentIndex(args, readOnlyBind(fixture.threadState))).toBeGreaterThanOrEqual(0);
    expect(segmentIndex(args, readOnlyBind(fixture.integrationSkills))).toBeGreaterThanOrEqual(0);

    expect(args).not.toContain(fixture.integrationSkillsRoot);
    expect(args).not.toContain(fixture.profilesRoot);
    expect(args).not.toContain(fixture.identityFile);
  });

  it("gives a program its Workspace and its private files read-only, and nothing of the Run's", async () => {
    const fixture = await createFixture();
    const programRoot = join(fixture.privateRoot, "watches", "executions", "boot", "twa_1", "1");
    await mkdir(programRoot, { recursive: true });
    const args = await programSandboxMounts(fixture.layout, {
      environment: fixture.environment,
      privateDirectory: programRoot,
      workspacePath: fixture.workspaceA,
    });

    expect(segmentIndex(args, readOnlyBind(programRoot))).toBeGreaterThanOrEqual(0);
    expect(segmentIndex(args, bind(programRoot))).toBe(-1);
    expect(segmentIndex(args, bind(fixture.workspaceA))).toBeGreaterThanOrEqual(0);
    expect(maskedPaths(args)).toEqual(
      expect.arrayContaining([fixture.dataDirectory, fixture.backingRoot, fixture.home]),
    );
    for (const hidden of [
      fixture.providerHome,
      fixture.storeDirectory,
      fixture.threadState,
      fixture.integrationSkills,
      fixture.workspaceB,
      fixture.identityFile,
    ]) {
      expect(args).not.toContain(hidden);
    }
  });

  it("refuses a program private directory outside the data directory", async () => {
    const fixture = await createFixture();
    await expect(
      programSandboxMounts(fixture.layout, {
        environment: fixture.environment,
        privateDirectory: fixture.externalRoot,
        workspacePath: fixture.workspaceA,
      }),
    ).rejects.toThrow(/outside the Runner data directory/u);
  });

  it("binds a store that is the provider home exactly once", async () => {
    const fixture = await createFixture();
    const args = await mounts(fixture, {
      providerState: {
        ...fixture.providerState,
        store: { directory: fixture.providerHome, id: "store_1" },
      },
    });

    expect(args.filter((value) => value === fixture.providerHome)).toHaveLength(2);
  });

  it("gives the Run a private home when HOME is an ordinary absolute path", async () => {
    const fixture = await createFixture();
    const args = await mounts(fixture);

    expect(maskIndex(args, "0700", fixture.home)).toBeGreaterThanOrEqual(0);
  });

  it("masks the OS account's home when the environment names none", async () => {
    const fixture = await createFixture();
    const { HOME: _home, ...withoutHome } = fixture.environment;

    const args = await mounts(fixture, {}, withoutHome);

    expect(args).not.toContain(fixture.home);
    expect(maskIndex(args, "0700", resolve(homedir()))).toBeGreaterThanOrEqual(0);
  });

  it("refuses a home it cannot make a private directory of its own", async () => {
    const fixture = await createFixture();

    await expect(mounts(fixture, {}, { ...fixture.environment, HOME: "/" })).rejects.toThrow(
      /private home directory/,
    );
    await expect(
      mounts(fixture, {}, { ...fixture.environment, HOME: "relative/home" }),
    ).rejects.toThrow(/private home directory/);
  });

  it("gives the Run a private tmp holding TMPDIR and the machine-access launch directory", async () => {
    const fixture = await createFixture();
    const args = await mounts(fixture);

    const privateTmp = maskIndex(args, "1777", fixture.temporaryDirectory);
    expect(privateTmp).toBeGreaterThanOrEqual(0);
    if (fixture.temporaryDirectory === "/tmp") {
      expect(args.filter((value) => value === "/tmp")).toHaveLength(1);
    } else {
      // Two unrelated paths; both are masked, and depth decides their order.
      expect(maskIndex(args, "1777", "/tmp")).toBeGreaterThanOrEqual(0);
    }

    // The configured TMPDIR and the launch directory only exist inside the
    // private tmp if bwrap creates them after the tmpfs that would erase them.
    const configuredTmp = segmentIndex(args, ["--dir", fixture.configuredTemporaryDirectory]);
    expect(configuredTmp).toBeGreaterThan(privateTmp);
    expect(segmentIndex(args, bind(fixture.launchDirectory))).toBeGreaterThan(configuredTmp);
  });

  it("binds a Workspace under a backing root that is itself inside the data directory", async () => {
    const fixture = await createFixture();
    const args = await mounts(fixture, { writableRoots: [fixture.workspaceB, fixture.namespaceA] });

    const masked = maskedPaths(args);
    expect(masked.indexOf(fixture.dataDirectory)).toBeLessThan(masked.indexOf(fixture.backingRoot));
    const workspace = segmentIndex(args, bind(fixture.workspaceA));
    expect(workspace).toBeGreaterThan(Math.max(...maskIndexes(args)));
    expect(segmentIndex(args, bind(fixture.workspaceB))).toBeGreaterThanOrEqual(0);
    expect(segmentIndex(args, bind(fixture.namespaceA))).toBeGreaterThanOrEqual(0);
  });

  it("refuses a Workspace root that is a backing root itself", async () => {
    const fixture = await createFixture();

    await expect(mounts(fixture, { workspacePath: fixture.backingRoot })).rejects.toThrow(
      /over|backing root|overlaps/,
    );
    await expect(
      mounts(fixture, { workspacePath: fixture.externalRoot }, fixture.environment, {
        workspaceRoots: [fixture.externalRoot],
      }),
    ).rejects.toThrow(/over|backing root|overlaps/);
  });

  it("refuses a Workspace inside the data directory but under no backing root", async () => {
    const fixture = await createFixture();

    await expect(mounts(fixture, { workspacePath: fixture.privateRoot })).rejects.toThrow(
      /overlaps/,
    );
  });

  it("refuses provider state outside the data directory or missing from the machine", async () => {
    const fixture = await createFixture();

    await expect(
      mounts(fixture, {
        providerState: { ...fixture.providerState, providerHomeDirectory: fixture.home },
      }),
    ).rejects.toThrow(/outside/);
    await expect(
      mounts(fixture, {
        providerState: {
          ...fixture.providerState,
          providerHomeDirectory: join(fixture.dataDirectory, "no-such-profile"),
        },
      }),
    ).rejects.toThrow(/cannot expose/);
  });

  it("refuses an ambient profile, which has no Runner-private provider home", async () => {
    const fixture = await createFixture();

    await expect(
      mounts(fixture, {
        providerState: {
          ...fixture.providerState,
          kind: "ambient",
          providerHomeDirectory: undefined,
        },
      }),
    ).rejects.toThrow(/isolated harness profiles/);
  });

  it("exposes a certificate bundle only when a masked root would hide it", async () => {
    const fixture = await createFixture();

    const masked = await mounts(
      fixture,
      {},
      { ...fixture.environment, NODE_EXTRA_CA_CERTS: fixture.maskedCertificate },
    );
    expect(segmentIndex(masked, readOnlyBind(fixture.maskedCertificate))).toBeGreaterThanOrEqual(0);

    const visible = await mounts(
      fixture,
      {},
      { ...fixture.environment, NODE_EXTRA_CA_CERTS: fixture.unmaskedCertificate },
    );
    expect(visible).not.toContain(fixture.unmaskedCertificate);
  });

  it("follows a certificate symlink to its target and keeps the named path too", async () => {
    const fixture = await createFixture();

    const args = await mounts(
      fixture,
      {},
      { ...fixture.environment, NODE_EXTRA_CA_CERTS: fixture.linkedCertificate },
    );

    expect(segmentIndex(args, readOnlyBind(fixture.homeCertificate))).toBeGreaterThanOrEqual(0);
    expect(
      segmentIndex(args, ["--ro-bind", fixture.homeCertificate, fixture.linkedCertificate]),
    ).toBeGreaterThanOrEqual(0);
  });

  it("refuses a certificate bundle that is not a regular file", async () => {
    const fixture = await createFixture();

    await expect(
      mounts(fixture, {}, { ...fixture.environment, NODE_EXTRA_CA_CERTS: fixture.dataDirectory }),
    ).rejects.toThrow(/must name a file/);
  });

  it("ends with the private namespaces and starts no new session", async () => {
    const fixture = await createFixture();
    const args = await mounts(fixture);

    expect(args.slice(-6)).toEqual([
      "--unshare-user",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--unshare-cgroup-try",
      "--die-with-parent",
    ]);
    expect(args).not.toContain("--new-session");
    expect(args).not.toContain("--as-pid-1");
  });
});

describe("harness sandbox without a fresh procfs", () => {
  it("binds the container's /proc writable and keeps the pid namespace shared", async () => {
    const fixture = await createFixture();
    const args = await mounts(fixture, {}, fixture.environment, { freshProc: false });

    expect(args.slice(0, 8)).toEqual([
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--bind",
      "/proc",
      "/proc",
    ]);
    expect(args).not.toContain("--proc");
    expect(args).not.toContain("--unshare-pid");
    expect(args.slice(-5)).toEqual([
      "--unshare-user",
      "--unshare-ipc",
      "--unshare-uts",
      "--unshare-cgroup-try",
      "--die-with-parent",
    ]);
    expect(maskIndex(args, "0700", fixture.dataDirectory)).toBeGreaterThan(0);
  });
});

describe("harness sandbox requirement", () => {
  it("applies to isolated-service Linux Runners and nowhere else", () => {
    expect(harnessSandboxRequired("linux", { kind: "isolated-service" })).toBe(true);
    expect(harnessSandboxRequired("linux", { kind: "native-user" })).toBe(false);
    expect(harnessSandboxRequired("darwin", { kind: "isolated-service" })).toBe(false);
    expect(harnessSandboxRequired("darwin", { kind: "native-user" })).toBe(false);
    expect(harnessSandboxRequired("win32", { kind: "isolated-service" })).toBe(false);
    expect(harnessSandboxRequired("win32", { kind: "native-user" })).toBe(false);
  });
});

function bind(path: string): readonly string[] {
  return ["--bind", path, path];
}

function readOnlyBind(path: string): readonly string[] {
  return ["--ro-bind", path, path];
}

/** The index where `segment` begins in `args`, or -1 when it is absent. */
function segmentIndex(args: readonly string[], segment: readonly string[]): number {
  return args.findIndex((_value, index) =>
    segment.every((expected, offset) => args[index + offset] === expected),
  );
}

function maskIndex(args: readonly string[], mode: string, path: string): number {
  return segmentIndex(args, ["--perms", mode, "--tmpfs", path]);
}

/** Where each tmpfs mask begins, in the order bwrap will create them. */
function maskIndexes(args: readonly string[]): readonly number[] {
  const indexes: number[] = [];
  for (const [index, value] of args.entries()) if (value === "--tmpfs") indexes.push(index);
  return indexes;
}

function maskedPaths(args: readonly string[]): readonly string[] {
  const paths: string[] = [];
  for (const index of maskIndexes(args)) {
    const path = args[index + 1];
    if (path !== undefined) paths.push(path);
  }
  return paths;
}

/** Every bind that brings something back, past the inherited root and /proc. */
function exposureIndexes(args: readonly string[]): readonly number[] {
  const indexes: number[] = [];
  for (const [index, value] of args.entries()) {
    if (value !== "--bind" && value !== "--ro-bind") continue;
    const source = args[index + 1];
    if (source === "/" || source === "/proc") continue;
    indexes.push(index);
  }
  return indexes;
}

interface Fixture {
  readonly backingRoot: string;
  readonly configuredTemporaryDirectory: string;
  readonly dataDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly externalRoot: string;
  readonly home: string;
  readonly homeCertificate: string;
  readonly identityFile: string;
  readonly integrationSkills: string;
  readonly integrationSkillsRoot: string;
  readonly launchDirectory: string;
  readonly layout: HarnessSandboxLayout;
  readonly linkedCertificate: string;
  readonly maskedCertificate: string;
  readonly namespaceA: string;
  readonly privateRoot: string;
  readonly profilesRoot: string;
  readonly providerHome: string;
  readonly providerState: HarnessProviderState;
  readonly run: HarnessSandboxRunPlan;
  readonly storeDirectory: string;
  readonly temporaryDirectory: string;
  readonly threadState: string;
  readonly unmaskedCertificate: string;
  readonly workspaceA: string;
  readonly workspaceB: string;
}

async function mounts(
  fixture: Fixture,
  run: Partial<HarnessSandboxRunPlan> = {},
  environment: Readonly<Record<string, string>> = fixture.environment,
  layout: Partial<HarnessSandboxLayout> = {},
): Promise<readonly string[]> {
  return harnessSandboxMounts(
    { ...fixture.layout, ...layout },
    { ...fixture.run, ...run },
    environment,
  );
}

/**
 * The default PortableFS topology: the Workspace backing root lives under the
 * Runner data directory, so both are masked and only this Run's Workspace
 * comes back.
 */
async function createFixture(): Promise<Fixture> {
  const root = await temporaryDirectory("opensteer-sandbox-");
  const dataDirectory = join(root, "data");
  const privateRoot = join(dataDirectory, "private");
  const harnessState = join(privateRoot, "harness-state");
  const profilesRoot = join(harnessState, "harness-profiles");
  const providerHome = join(profilesRoot, "hi_1", "provider-home");
  const storeDirectory = join(harnessState, "harness-stores", "codex", "store");
  const threadState = join(harnessState, "threads", "thr_1");
  const integrationSkillsRoot = join(harnessState, "integration-skills");
  const integrationSkills = join(integrationSkillsRoot, "thr_1");
  const backingRoot = join(dataDirectory, "workspaces");
  const namespaceA = join(backingRoot, "user_a");
  const workspaceA = join(namespaceA, "ws1");
  const workspaceB = join(backingRoot, "user_b", "ws1");
  const externalRoot = join(root, "external-workspaces");
  const home = join(root, "home");
  for (const directory of [
    providerHome,
    storeDirectory,
    threadState,
    integrationSkills,
    workspaceA,
    workspaceB,
    externalRoot,
    home,
  ]) {
    await mkdir(directory, { recursive: true });
  }
  const identityFile = join(dataDirectory, "identity.json");
  const maskedCertificate = join(dataDirectory, "control-ca.pem");
  const homeCertificate = join(home, "control-ca.pem");
  for (const file of [identityFile, maskedCertificate, homeCertificate]) {
    await writeFile(file, "{}\n");
  }
  const linkedCertificate = join(dataDirectory, "linked-ca.pem");
  await symlink(homeCertificate, linkedCertificate);
  // Every path the fixture owns sits under a mask, so the one bundle no mask
  // hides has to be a real file elsewhere on this machine.
  const unmaskedCertificate = await realpath(process.execPath);

  const temporaryDirectoryPath = await realpath(tmpdir());
  const launchDirectory = await temporaryDirectory("opensteer-sandbox-launch-");
  const configuredTemporaryDirectory = join(temporaryDirectoryPath, "opensteer-run-tmp");
  const environment: Readonly<Record<string, string>> = {
    HOME: home,
    PATH: "/usr/bin:/bin",
    TMPDIR: configuredTemporaryDirectory,
  };
  const providerState: HarnessProviderState = {
    continuationKey: "ck_codex_1",
    kind: "isolated",
    privateStateRoot: dataDirectory,
    providerHomeDirectory: providerHome,
    store: { directory: storeDirectory, id: "store_codex_1" },
  };

  return {
    backingRoot,
    configuredTemporaryDirectory,
    dataDirectory,
    environment,
    externalRoot,
    home,
    homeCertificate,
    identityFile,
    integrationSkills,
    integrationSkillsRoot,
    launchDirectory,
    layout: {
      dataDirectory,
      freshProc: true,
      temporaryDirectory: temporaryDirectoryPath,
      workspaceRoots: [backingRoot],
    },
    linkedCertificate,
    maskedCertificate,
    namespaceA,
    privateRoot,
    profilesRoot,
    providerHome,
    providerState,
    run: {
      environment,
      integrationSkillsDirectory: integrationSkills,
      launchDirectory,
      providerState,
      threadStateDirectory: threadState,
      workspacePath: workspaceA,
      writableRoots: [],
    },
    storeDirectory,
    temporaryDirectory: temporaryDirectoryPath,
    threadState,
    unmaskedCertificate,
    workspaceA,
    workspaceB,
  };
}

/** Canonical so every expectation compares the path the sandbox will realpath. */
async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return realpath(directory);
}
