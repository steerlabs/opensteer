import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  withSignedHelperLifecycleLock,
  type SignedHelperProcess,
} from "../signed-helpers/signed-helper.js";
import { ensurePasswordsBrokerInstalled, passwordsBrokerIdentity } from "./install.js";
import {
  bundledPasswordsBrokerPath,
  passwordsBrokerAppName,
  passwordsBrokerAppPath,
  passwordsBrokerLockPath,
  passwordsBrokerRoot,
  passwordsBrokerSocketPath,
} from "./paths.js";
import { passwordsBrokerRequirement } from "./release-identity.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Opensteer Passwords paths", () => {
  it("keeps the release and development brokers apart", () => {
    const home = "/Users/person";

    expect(passwordsBrokerRoot(false, home)).toBe(
      "/Users/person/Library/Application Support/Opensteer/Passwords",
    );
    expect(passwordsBrokerRoot(true, home)).toBe(
      "/Users/person/Library/Application Support/Opensteer/Passwords (Development)",
    );
    for (const development of [false, true]) {
      const root = passwordsBrokerRoot(development, home);
      expect(passwordsBrokerAppPath(development, home)).toBe(
        path.join(root, "Opensteer Passwords.app"),
      );
      expect(passwordsBrokerSocketPath(development, home)).toBe(path.join(root, "ipc.sock"));
      expect(passwordsBrokerLockPath(development, home)).toBe(path.join(root, "lifecycle.lock"));
      // sun_path holds 104 bytes on macOS, which a typical home leaves room in.
      expect(Buffer.byteLength(passwordsBrokerSocketPath(development, home))).toBeLessThan(104);
    }
  });

  it("finds the bundled broker beside the other native resources", () => {
    expect(
      bundledPasswordsBrokerPath({
        developmentRoot: "/repo",
        packaged: true,
        resourcesPath: "/Applications/Opensteer.app/Contents/Resources",
      }),
    ).toBe("/Applications/Opensteer.app/Contents/Resources/passwords/Opensteer Passwords.app");
    expect(
      bundledPasswordsBrokerPath({ developmentRoot: "/repo", packaged: false, resourcesPath: "" }),
    ).toBe("/repo/apps/desktop/native/passwords/dist/Opensteer Passwords.app");
  });

  it("requires Opensteer's Developer ID and the build's own identifier", () => {
    for (const [development, identifier] of [
      [false, "com.opensteer.passwords"],
      [true, "com.opensteer.passwords.dev"],
    ] as const) {
      const requirement = passwordsBrokerRequirement(development, "ABCDE12345");
      expect(requirement).toContain("anchor apple generic");
      expect(requirement).toContain("certificate leaf[field.1.2.840.113635.100.6.1.13]");
      expect(requirement).toContain('certificate leaf[subject.OU] = "ABCDE12345"');
      expect(requirement).toContain(`identifier "${identifier}"`);
    }
  });
});

// The lifecycle lock is the kernel's, so this runs in the macOS CI job.
describe.runIf(process.platform === "darwin")("ensurePasswordsBrokerInstalled", () => {
  it("rejects with the build sentence when this build ships no broker", async () => {
    const harness = await installHarness();

    await expect(
      ensurePasswordsBrokerInstalled({
        ...harness.options,
        bundledAppPath: path.join(harness.home, "nowhere", passwordsBrokerAppName),
      }),
    ).rejects.toThrow(
      "Opensteer Passwords is not built; run pnpm --filter desktop build:passwords-broker.",
    );
  });

  it("installs the development broker into its own root with ditto --noqtn", async () => {
    const harness = await installHarness();
    await harness.writeBundled("7");

    await expect(ensurePasswordsBrokerInstalled(harness.options)).resolves.toEqual({
      installed: true,
      launchFreshInstance: false,
      path: passwordsBrokerAppPath(true, harness.home),
      protocolVersion: null,
      version: "7",
    });
    expect(await harness.installedVersion(true)).toBe("7");
    expect(await harness.installedVersion(false)).toBeNull();
    expect(harness.commands()).toContain("/usr/bin/ditto --noqtn");
    expect(harness.commands()).toContain("/usr/bin/codesign --verify --deep --strict");
  });

  it("installs the release broker into the release root, held to the Developer ID", async () => {
    const harness = await installHarness({ development: false });
    await harness.writeBundled("7");

    await expect(ensurePasswordsBrokerInstalled(harness.release)).resolves.toMatchObject({
      installed: true,
      path: passwordsBrokerAppPath(false, harness.home),
    });
    expect(await harness.installedVersion(true)).toBeNull();
    expect(harness.commands()).toContain('identifier "com.opensteer.passwords"');
  });

  it("refuses a Developer ID development broker in a release build", async () => {
    const harness = await installHarness({
      adHoc: false,
      signedIdentifier: "com.opensteer.passwords.dev",
    });
    await harness.writeBundled("7");

    await expect(ensurePasswordsBrokerInstalled(harness.release)).rejects.toThrow(
      "Opensteer Passwords has the wrong bundle identifier.",
    );
    expect(harness.commands()).not.toContain("/usr/bin/ditto");
  });

  it("names the ad-hoc signature as why a contributor package refuses its broker", async () => {
    // A contributor package is ad-hoc signed and ships the development broker.
    const harness = await installHarness({ signedIdentifier: "com.opensteer.passwords.dev" });
    await harness.writeBundled("7");

    await expect(ensurePasswordsBrokerInstalled(harness.release)).rejects.toThrow(
      "Opensteer Passwords is ad-hoc signed in a packaged build.",
    );
    expect(harness.commands()).not.toContain("/usr/bin/ditto");
  });

  it("refuses the release broker in a development build", async () => {
    const harness = await installHarness({ signedIdentifier: "com.opensteer.passwords" });
    await harness.writeBundled("7");

    await expect(ensurePasswordsBrokerInstalled(harness.options)).rejects.toThrow(
      "Opensteer Passwords has the wrong bundle identifier.",
    );
  });

  it("refuses an ad-hoc broker in a release build", async () => {
    const harness = await installHarness({ adHoc: true, development: false });
    await harness.writeBundled("7");

    await expect(ensurePasswordsBrokerInstalled(harness.release)).rejects.toThrow(
      "Opensteer Passwords is ad-hoc signed in a packaged build.",
    );
  });

  it("asks the running broker to step aside before replacing an older one", async () => {
    const harness = await installHarness();
    await harness.writeBundled("12");
    await harness.writeInstalled("9");

    await expect(ensurePasswordsBrokerInstalled(harness.options)).resolves.toMatchObject({
      installed: true,
      version: "12",
    });
    // From the copy sealed inside the desktop, never the user-writable staging copy.
    expect(harness.prepareReplacementRanFrom).toEqual([
      path.join(harness.options.bundledAppPath, "Contents", "MacOS", "Opensteer Passwords"),
    ]);
  });

  it("keeps a valid broker whose running copy will not stop yet", async () => {
    const harness = await installHarness({ prepareReplacementFails: true });
    await harness.writeBundled("12");
    await harness.writeInstalled("9");

    await expect(ensurePasswordsBrokerInstalled(harness.options)).resolves.toEqual({
      installed: false,
      launchFreshInstance: false,
      path: passwordsBrokerAppPath(true, harness.home),
      protocolVersion: null,
      version: "9",
    });
    expect(harness.log).toHaveBeenCalledWith(
      "desktop.passwords.broker-replacement-refused",
      expect.objectContaining({ installed: "valid" }),
    );
  });

  it("replaces an invalid broker it cannot stop, and launches afresh", async () => {
    const harness = await installHarness({
      installedVerifyFails: true,
      prepareReplacementFails: true,
    });
    await harness.writeBundled("12");
    await harness.writeInstalled("9");

    await expect(ensurePasswordsBrokerInstalled(harness.options)).resolves.toMatchObject({
      installed: true,
      launchFreshInstance: true,
      version: "12",
    });
  });

  it("never downgrades a newer release broker", async () => {
    const harness = await installHarness({ development: false });
    await harness.writeBundled("12");
    await harness.writeInstalled("20", false);

    await expect(ensurePasswordsBrokerInstalled(harness.release)).resolves.toMatchObject({
      installed: false,
      version: "20",
    });
    expect(harness.commands()).not.toContain("/usr/bin/ditto");
  });

  it("keeps a release broker of the same version that the other channel signed", async () => {
    const harness = await installHarness({ development: false, installedCdHash: "beta" });
    await harness.writeBundled("12");
    await harness.writeInstalled("12", false);

    await expect(ensurePasswordsBrokerInstalled(harness.release)).resolves.toMatchObject({
      installed: false,
    });
  });

  it("replaces an equal-version development broker whose code changed", async () => {
    const harness = await installHarness({ installedCdHash: "old" });
    await harness.writeBundled("12");
    await harness.writeInstalled("12");

    await expect(ensurePasswordsBrokerInstalled(harness.options)).resolves.toMatchObject({
      installed: true,
    });
  });

  it("leaves the previous copy when the staged copy fails verification", async () => {
    const harness = await installHarness({ stagedVerifyFails: true });
    await harness.writeBundled("12");
    await harness.writeInstalled("9");

    await expect(ensurePasswordsBrokerInstalled(harness.options)).rejects.toThrow(/codesign/u);
    expect(await harness.installedVersion(true)).toBe("9");
  });

  it("gives up at its deadline rather than racing another Opensteer's install", async () => {
    const harness = await installHarness();
    await harness.writeBundled("4");
    await mkdir(passwordsBrokerRoot(true, harness.home), { mode: 0o700, recursive: true });
    let release: () => void = () => undefined;
    let held: () => void = () => undefined;
    const holding = new Promise<void>((resolvePromise) => {
      held = resolvePromise;
    });
    const holder = withSignedHelperLifecycleLock(
      {
        deadline: { at: Date.now() + 5_000 },
        identity: passwordsBrokerIdentity(true),
        lockPath: passwordsBrokerLockPath(true, harness.home),
      },
      async () => {
        held();
        await new Promise<void>((resolvePromise) => {
          release = resolvePromise;
        });
      },
    );
    await holding;

    await expect(
      ensurePasswordsBrokerInstalled({ ...harness.options, deadline: { at: Date.now() + 40 } }),
    ).rejects.toMatchObject({
      code: "not-running",
      message: "Another Opensteer is starting or updating Opensteer Passwords. Try again shortly.",
    });
    expect(harness.commands()).not.toContain("/usr/bin/ditto");
    release();
    await holder;
  });
});

async function installHarness(
  behavior: {
    readonly adHoc?: boolean;
    readonly development?: boolean;
    readonly installedCdHash?: string;
    readonly installedVerifyFails?: boolean;
    readonly prepareReplacementFails?: boolean;
    readonly signedIdentifier?: string;
    readonly stagedVerifyFails?: boolean;
  } = {},
) {
  const home = await mkdtemp("/tmp/osp-install-");
  roots.push(home);
  const bundledAppPath = path.join(home, "bundled", passwordsBrokerAppName);
  const calls: string[][] = [];
  const versions = new Map<string, string>();
  const prepareReplacementRanFrom: string[] = [];
  const development = behavior.development ?? true;
  const identifier =
    behavior.signedIdentifier ??
    (development ? "com.opensteer.passwords.dev" : "com.opensteer.passwords");
  const adHoc = behavior.adHoc ?? development;
  const run: SignedHelperProcess = async (file, arguments_) => {
    calls.push([file, ...arguments_]);
    if (file === "/usr/bin/plutil") {
      const version = versions.get(path.resolve(arguments_.at(-1) ?? ""));
      if (!version) throw new Error("no plist");
      return JSON.stringify({ CFBundleVersion: version });
    }
    if (file === "/usr/bin/ditto") {
      const [, from, to] = arguments_;
      if (!from || !to) throw new Error("ditto needs a source and a target");
      await cp(from, to, { recursive: true });
      versions.set(
        path.resolve(to, "Contents", "Info.plist"),
        versions.get(path.resolve(from, "Contents", "Info.plist")) ?? "0",
      );
      return "";
    }
    if (file === "/usr/bin/codesign" && arguments_[0] === "-dv") {
      const appPath = arguments_.at(-1) ?? "";
      const installed =
        appPath === passwordsBrokerAppPath(true, home) ||
        appPath === passwordsBrokerAppPath(false, home);
      const cdHash = installed ? (behavior.installedCdHash ?? "same") : "same";
      return adHoc
        ? `Identifier=${identifier}\nSignature=adhoc\nCDHash=${cdHash}\n`
        : `Identifier=${identifier}\nAuthority=Developer ID Application: Example\nTeamIdentifier=ABCDE12345\nCDHash=${cdHash}\n`;
    }
    if (file === "/usr/bin/codesign" && arguments_[0] === "--verify") {
      const appPath = path.resolve(arguments_.at(-1) ?? "");
      if (behavior.stagedVerifyFails && appPath.includes("/.install-")) {
        throw new Error("codesign refused the staged copy");
      }
      if (
        behavior.installedVerifyFails &&
        (appPath === passwordsBrokerAppPath(true, home) ||
          appPath === passwordsBrokerAppPath(false, home))
      ) {
        throw new Error("codesign refused the canonical copy");
      }
      return "";
    }
    if (arguments_.length === 1 && arguments_[0] === "--prepare-replacement") {
      prepareReplacementRanFrom.push(file);
      if (behavior.prepareReplacementFails) throw new Error("the broker is still running");
      return "";
    }
    throw new Error(`unexpected command ${file}`);
  };
  const log = vi.fn();
  const writeBundle = async (appPath: string, version: string) => {
    const plistPath = path.join(appPath, "Contents", "Info.plist");
    await mkdir(path.dirname(plistPath), { recursive: true });
    await writeFile(plistPath, `<plist>${version}</plist>`);
    versions.set(path.resolve(plistPath), version);
  };
  const options = {
    bundledAppPath,
    deadline: { at: Date.now() + 5_000 },
    development: true,
    homeDirectory: home,
    log,
    run,
  };
  return {
    commands: () => calls.map((call) => call.join(" ")).join("\n"),
    home,
    installedVersion: async (forDevelopment: boolean) => {
      const plistPath = path.join(
        passwordsBrokerAppPath(forDevelopment, home),
        "Contents",
        "Info.plist",
      );
      const body = await readFile(plistPath, "utf8").catch(() => null);
      return body === null ? null : (/<plist>(.*)<\/plist>/u.exec(body)?.[1] ?? null);
    },
    log,
    options,
    prepareReplacementRanFrom,
    release: { ...options, development: false },
    writeBundled: (version: string) => writeBundle(bundledAppPath, version),
    writeInstalled: (version: string, forDevelopment = true) =>
      writeBundle(passwordsBrokerAppPath(forDevelopment, home), version),
  };
}

// Exercise local ad-hoc broker journeys explicitly; packaged paths still pin the fixture team.
vi.mock("../signed-helpers/signing-build.js", () => ({
  signingTeamId: "ABCDE12345",
  developmentTrust: true,
}));
