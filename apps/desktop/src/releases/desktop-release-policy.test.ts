import { readEmbeddedDesktopRelease } from "../config.js";
import {
  desktopAppUpdateYaml,
  desktopUpdateFeed,
  stageDesktopUpdatePolicy,
} from "./desktop-update-policy.js";
import { createRequire } from "node:module";
import { chmod, mkdtemp, mkdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPackage } from "@electron/asar";

const require = createRequire(import.meta.url);
const {
  verifyAppUpdateConfig,
  allowOwnerWrites,
  readPackagedDesktopPolicy,
  verifyDesktopApplicationIdentity,
  verifyPackagedRuntimeImports,
} = require("../../scripts/after-pack.cjs") as {
  readonly verifyAppUpdateConfig: (resources: string, desktop: unknown) => void;
  readonly allowOwnerWrites: (bundlePath: string) => void;
  readonly readPackagedDesktopPolicy: (archivePath: string) => unknown;
  readonly verifyDesktopApplicationIdentity: (
    desktop: unknown,
    appInfo: { readonly id: string; readonly productName: string },
    protocols: readonly { readonly schemes: readonly string[] }[],
  ) => void;
  readonly verifyPackagedRuntimeImports: (archivePath: string) => void;
};
const { desktopReleaseIdentity, validateReleaseEntitlements } =
  require("../../scripts/macos-release-identity.cjs") as {
    readonly desktopReleaseIdentity: () => MacosReleaseIdentity;
    readonly validateReleaseEntitlements: (entitlements: Record<string, unknown>) => void;
  };
const verifySignedDesktop = require("../../scripts/after-sign.cjs") as ((context: {
  readonly electronPlatformName: string;
}) => Promise<void>) & {
  readonly computerUseArchitecturesAreUniversal: (architectures: string) => boolean;
};
const verifyWindowsInstaller = require("../../scripts/after-all-artifact-build.cjs") as (result: {
  readonly artifactPaths: readonly string[];
  readonly platformToTargets: ReadonlyMap<{ readonly name: string }, ReadonlySet<string>>;
}) => Promise<readonly string[]>;
const temporaryDirectories: string[] = [];

interface MacosReleaseIdentity {
  readonly bundleId: string;
  readonly productName: string;
  readonly teamId: string;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Desktop release policy", () => {
  it("pins the single macOS identity", () => {
    expect(desktopReleaseIdentity()).toMatchObject({
      bundleId: "com.opensteer.opensteer",
      productName: "Opensteer",
      teamId: "ABCDE12345",
    });
  });

  it("allows only Opensteer's reviewed hardened-runtime entitlements", () => {
    expect(() =>
      validateReleaseEntitlements({
        "com.apple.security.cs.allow-jit": true,
        "com.apple.security.device.audio-input": true,
      }),
    ).not.toThrow();
    for (const value of [false, undefined, "true"]) {
      expect(() =>
        validateReleaseEntitlements({
          "com.apple.security.cs.allow-jit": true,
          "com.apple.security.device.audio-input": value,
        }),
      ).toThrow();
    }
    expect(() =>
      validateReleaseEntitlements({ "com.apple.security.cs.allow-jit": true }),
    ).toThrow();
    expect(() => validateReleaseEntitlements({})).toThrow(/reviewed hardened-runtime/u);
    expect(() =>
      validateReleaseEntitlements({
        "com.apple.security.cs.allow-jit": true,
        "com.apple.security.device.audio-input": true,
        "com.apple.security.get-task-allow": true,
      }),
    ).toThrow(/reviewed hardened-runtime/u);
    // Every command an agent runs descends from this app, so Apple events
    // — sending in Messages among them — belong to the helper alone.
    expect(() =>
      validateReleaseEntitlements({
        "com.apple.security.automation.apple-events": true,
        "com.apple.security.cs.allow-jit": true,
        "com.apple.security.device.audio-input": true,
      }),
    ).toThrow(/reviewed hardened-runtime/u);
  });

  it.each([
    {
      application: { id: "com.opensteer.opensteer", name: "Opensteer" },
      oauth: {
        accountCallback: "com.opensteer.opensteer:/oauth/account-callback",
        hostCallback: "com.opensteer.opensteer:/oauth/host-callback",
      },
      scheme: "com.opensteer.opensteer",
    },
  ])("binds the manifest to its packaged app and URI scheme", (profile) => {
    const desktop = {
      application: profile.application,
      oauth: { ...profile.oauth, clientId: "client" },
    };
    expect(() =>
      verifyDesktopApplicationIdentity(
        desktop,
        { id: profile.application.id, productName: profile.application.name },
        [{ schemes: [profile.scheme] }],
      ),
    ).not.toThrow();
    expect(() =>
      verifyDesktopApplicationIdentity(
        desktop,
        { id: profile.application.id, productName: profile.application.name },
        [{ schemes: ["wrong-scheme"] }],
      ),
    ).toThrow(/OAuth scheme/u);
  });

  it("requires Account and portal origins in the packaged policy", async () => {
    for (const overrides of [{ accountUrl: undefined }, { portalUrl: undefined }]) {
      const invalid = await archivedPolicy(overrides);
      expect(() => readPackagedDesktopPolicy(invalid.archive)).toThrow();
    }
  });

  // Squirrel.Mac clears quarantine from every file of a downloaded update and
  // later replaces the bundle; a read-only release input made every update fail.
  it("leaves every packaged entry owner-writable without changing other permissions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "opensteer-desktop-modes-"));
    temporaryDirectories.push(root);
    const bundle = path.join(root, "Opensteer.app");
    const resource = path.join(bundle, "Contents", "Resources", "passwords");
    await mkdir(resource, { recursive: true });
    const data = path.join(resource, "release.json");
    const tool = path.join(resource, "tool");
    await writeFile(data, "{}\n");
    await writeFile(tool, "#!/bin/sh\n");
    await symlink("release.json", path.join(resource, "link"));
    await chmod(data, 0o444);
    await chmod(tool, 0o555);
    await chmod(resource, 0o555);
    try {
      allowOwnerWrites(bundle);
      expect((await stat(data)).mode & 0o7777).toBe(0o644);
      expect((await stat(tool)).mode & 0o7777).toBe(0o755);
      expect((await stat(resource)).mode & 0o7777).toBe(0o755);
      expect(await readlink(path.join(resource, "link"))).toBe("release.json");
    } finally {
      await chmod(resource, 0o755);
    }
  });

  // The committed manifests, staged exactly as packaging stages them, must pass
  // the packaging gate; synthetic fixtures alone missed new optional fields.
  it.each([
    ["desktop-release.json", "darwin", "arm64"],
    ["desktop-release.json", "darwin", "x64"],
  ] as const)("packages the committed %s staged for %s/%s", async (file, os, arch) => {
    vi.stubEnv("OPENSTEER_DESKTOP_RELEASE", "1");
    try {
      const staged = stageDesktopUpdatePolicy(
        readEmbeddedDesktopRelease(path.join(import.meta.dirname, file)),
        os,
        arch,
        undefined,
      );
      const fixture = await archivedManifest(staged);
      expect(readPackagedDesktopPolicy(fixture.archive)).toEqual(staged);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // A contributor package launches as a packaged app, so its embedded policy
  // alone decides whether it reaches the production Account.
  it("stages non-release packages without updates or production services", async () => {
    vi.stubEnv("OPENSTEER_DESKTOP_RELEASE", "0");
    try {
      const committed = readEmbeddedDesktopRelease(
        path.join(import.meta.dirname, "desktop-release.json"),
      );
      const staged = stageDesktopUpdatePolicy(committed, "development", "arm64", undefined);
      expect(staged).not.toHaveProperty("updates");
      expect(staged).not.toHaveProperty("accountUrl");
      expect(staged).not.toHaveProperty("portalUrl");
      const fixture = await archivedManifest(staged);
      expect(readPackagedDesktopPolicy(fixture.archive)).toEqual(staged);
      await expect(
        archivedManifest(committed).then(({ archive }) => readPackagedDesktopPolicy(archive)),
      ).rejects.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    { updates: { owner: "steerlabs", repo: "opensteer", channel: "insider" } },
    { application: { id: "com.opensteer.opensteer", name: "Opensteer", channel: "beta" } },
    { updates: { feedUrl: "http://updates.opensteer.test/feed.json" } },
    { updates: { feedUrl: "https://updates.opensteer.test/feed.json", extra: true } },
    { updates: "https://updates.opensteer.test/feed.json" },
    {
      application: {
        id: "com.opensteer.opensteer",
        name: "Opensteer",
        stage: "beta",
      },
    },
  ])("rejects an invalid update feed or release stage", async (overrides) => {
    const fixture = await archivedPolicy(overrides);
    expect(() => readPackagedDesktopPolicy(fixture.archive)).toThrow(
      /manifest is invalid|unexpected manifest shape/u,
    );
  });

  it.each([
    { schemaVersion: 6 },
    { capabilities: { connect: true } },
    { accountUrl: ["https://accounts.opensteer.test"] },
  ])("rejects an invalid or obsolete embedded policy", async (overrides) => {
    const fixture = await archivedPolicy(overrides);
    expect(() => readPackagedDesktopPolicy(fixture.archive)).toThrow(
      /manifest is invalid|unexpected manifest shape/u,
    );
  });

  it("rejects a packaged runtime with an unresolved transitive import", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "opensteer-desktop-imports-"));
    temporaryDirectories.push(root);
    const source = path.join(root, "source");
    await mkdir(path.join(source, "dist"), { recursive: true });
    await mkdir(path.join(source, "node_modules", "fixture-runtime"), { recursive: true });
    await writeFile(path.join(source, "dist", "main.js"), 'import "fixture-runtime";');
    await writeFile(path.join(source, "dist", "preload.cjs"), "module.exports = {};");
    await writeFile(path.join(source, "dist", "runner-worker.js"), "export {};");
    await writeFile(
      path.join(source, "node_modules", "fixture-runtime", "package.json"),
      JSON.stringify({ exports: "./index.js", name: "fixture-runtime", type: "module" }),
    );
    await writeFile(
      path.join(source, "node_modules", "fixture-runtime", "index.js"),
      'import "missing-runtime-package";',
    );
    const archive = path.join(root, "app.asar");
    await createFixtureArchive(source, archive);

    expect(() => verifyPackagedRuntimeImports(archive)).toThrow(/missing-runtime-package/u);
  });

  it("keeps Windows directory inspection builds independent of release signing hooks", async () => {
    const originalRelease = process.env.OPENSTEER_DESKTOP_RELEASE;
    delete process.env.OPENSTEER_DESKTOP_RELEASE;
    try {
      await expect(verifySignedDesktop({ electronPlatformName: "win32" })).resolves.toBeUndefined();
      await expect(
        verifyWindowsInstaller({
          artifactPaths: [],
          platformToTargets: new Map([[{ name: "windows" }, new Set(["dir"])]]),
        }),
      ).resolves.toEqual([]);
    } finally {
      if (originalRelease === undefined) delete process.env.OPENSTEER_DESKTOP_RELEASE;
      else process.env.OPENSTEER_DESKTOP_RELEASE = originalRelease;
    }
  });

  it("keeps the signed Windows installer mandatory for a release", async () => {
    const originalRelease = process.env.OPENSTEER_DESKTOP_RELEASE;
    process.env.OPENSTEER_DESKTOP_RELEASE = "1";
    try {
      await expect(
        verifyWindowsInstaller({
          artifactPaths: [],
          platformToTargets: new Map([[{ name: "windows" }, new Set(["nsis"])]]),
        }),
      ).rejects.toThrow(/exactly one signed NSIS installer/u);
    } finally {
      if (originalRelease === undefined) delete process.env.OPENSTEER_DESKTOP_RELEASE;
      else process.env.OPENSTEER_DESKTOP_RELEASE = originalRelease;
    }
  });

  it("requires both native slices in the packaged Computer use helper", () => {
    expect(verifySignedDesktop.computerUseArchitecturesAreUniversal("arm64 x86_64")).toBe(true);
    expect(verifySignedDesktop.computerUseArchitecturesAreUniversal("x86_64 arm64")).toBe(true);
    expect(verifySignedDesktop.computerUseArchitecturesAreUniversal("arm64")).toBe(false);
    expect(verifySignedDesktop.computerUseArchitecturesAreUniversal("x86_64")).toBe(false);
  });
});

async function archivedPolicy(overrides: Record<string, unknown>) {
  const base = {
    accountUrl: "https://accounts.opensteer.test",
    portalUrl: "https://app.opensteer.test",
    application: { id: "com.opensteer.opensteer", name: "Opensteer" },
    oauth: {
      accountCallback: "com.opensteer.opensteer:/oauth/account-callback",
      clientId: "opensteer-desktop",
      hostCallback: "com.opensteer.opensteer:/oauth/host-callback",
    },
    schemaVersion: 7,
  };
  return archivedManifest({ ...base, ...overrides });
}

async function archivedManifest(policy: unknown) {
  const root = await mkdtemp(path.join(tmpdir(), "opensteer-desktop-policy-"));
  temporaryDirectories.push(root);
  const source = path.join(root, "source");
  await mkdir(path.join(source, "dist"), { recursive: true });
  await writeFile(path.join(source, "dist", "desktop-release.json"), JSON.stringify(policy));
  const archive = path.join(root, "app.asar");
  await createFixtureArchive(source, archive);
  return { archive, root };
}

async function createFixtureArchive(source: string, archive: string): Promise<void> {
  // `createPackage` resolves after calling Writable.end(), not after the archive
  // file has flushed. Reading it immediately can therefore observe zero-filled
  // payload bytes even though its header is already complete.
  await finished(await createPackage(source, archive));
}

it("stages updates only for Mac arm64", () => {
  const release = readEmbeddedDesktopRelease(
    path.join(import.meta.dirname, "desktop-release.json"),
  );
  const staged = stageDesktopUpdatePolicy(release, "darwin", "arm64", "updates.localhost:8443");
  expect(staged.updates).toMatchObject({
    owner: "steerlabs",
    repo: "opensteer",
    host: "updates.localhost:8443",
  });
  for (const [os, arch] of [
    ["darwin", "amd64"],
    ["linux", "arm64"],
    ["win32", "arm64"],
  ])
    expect(stageDesktopUpdatePolicy(release, os!, arch!, undefined).updates).toBeUndefined();
});
it("validates app-update.yml against the staged policy", async () => {
  const release = readEmbeddedDesktopRelease(
    path.join(import.meta.dirname, "desktop-release.json"),
  );
  const updates = stageDesktopUpdatePolicy(
    release,
    "darwin",
    "arm64",
    "mirror.localhost:8443",
  ).updates!;
  const root = await mkdtemp(path.join(tmpdir(), "opensteer-update-yaml-"));
  temporaryDirectories.push(root);
  expect(desktopUpdateFeed(updates)).toBe(`https://mirror.localhost:8443/steerlabs/opensteer`);
  expect(desktopUpdateFeed({ ...updates, host: undefined })).toBe(
    `https://github.com/steerlabs/opensteer`,
  );
  const yaml = desktopAppUpdateYaml(updates);
  const { parse } = await import("yaml");
  expect(parse(yaml)).toEqual({
    provider: "github",
    owner: "steerlabs",
    repo: "opensteer",
    host: "mirror.localhost:8443",
    updaterCacheDirName: "opensteer-updater",
  });
  await writeFile(path.join(root, "app-update.yml"), yaml);
  expect(() => verifyAppUpdateConfig(root, { ...release, updates })).not.toThrow();
  await writeFile(
    path.join(root, "app-update.yml"),
    yaml.replace("mirror.localhost", "wrong.localhost"),
  );
  expect(() => verifyAppUpdateConfig(root, { ...release, updates })).toThrow(
    /update configuration/u,
  );
});
