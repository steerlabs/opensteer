import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { arch, homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { opensteerNativeClients } from "@opensteer/core";
import { afterAll } from "vitest";
import { describe, expect, it } from "vitest";
import {
  desktopApplicationName,
  desktopDataDirectory,
  readDesktopConfiguration,
  readEmbeddedDesktopRelease,
  type DesktopMode,
} from "./config.js";

const appDataDirectory = "/tmp/opensteer-desktop-app-data";
const resourcesDirectory = packagedResources();
afterAll(() => rmSync(resourcesDirectory, { force: true, recursive: true }));

describe("desktop configuration", () => {
  it("ships only builds the Host and Account registries know", () => {
    // Every Host registers exactly `opensteerNativeClients`, so a manifest
    // that names any other identity is a build no Deployment would admit.
    for (const manifest of [
      "./releases/desktop-release.source.json",
      "./releases/desktop-release.beta.json",
    ]) {
      const release = readEmbeddedDesktopRelease(fileURLToPath(new URL(manifest, import.meta.url)));
      const registered = opensteerNativeClients.find(
        (client) => client.clientId === release.oauth.clientId,
      );
      expect(registered, manifest).toBeDefined();
      expect({
        accountCallback: release.oauth.accountCallback,
        applicationId: release.application.id,
        hostCallback: release.oauth.hostCallback,
        name: release.application.name,
      }).toEqual({
        accountCallback: registered!.accountCallback,
        applicationId: registered!.applicationId,
        hostCallback: registered!.hostCallback,
        name: registered!.name,
      });
    }
  });

  it("ships stable without an Account and rejects mismatched Connect policy", () => {
    const stablePath = fileURLToPath(
      new URL("./releases/desktop-release.source.json", import.meta.url),
    );
    const stable = readEmbeddedDesktopRelease(stablePath);
    expect(stable.capabilities.connect).toBe(false);
    expect(stable.accountUrl).toBeUndefined();
    expect(stable.portalUrl).toBeUndefined();
    const loaded = readDesktopConfiguration({
      appDataDirectory,
      defaultMode: "production",
      environment: baseEnvironment(),
      packaged: true,
      releaseManifestPath: stablePath,
      resourcesDirectory,
    });
    expect(loaded.config.accountUrl).toBeNull();
    expect(loaded.config.portalUrl).toBeNull();
    const directory = mkdtempSync(join(tmpdir(), "opensteer-connect-policy-"));
    try {
      const manifestPath = join(directory, "release.json");
      for (const invalid of [
        { ...stable, accountUrl: "https://accounts.example.test" },
        { ...stable, capabilities: { ...stable.capabilities, connect: true } },
      ]) {
        writeFileSync(manifestPath, JSON.stringify(invalid));
        expect(() => readEmbeddedDesktopRelease(manifestPath)).toThrow();
      }
      const beta = readEmbeddedDesktopRelease(
        fileURLToPath(new URL("./releases/desktop-release.beta.json", import.meta.url)),
      );
      expect(beta.capabilities.connect).toBe(true);
      expect(beta.accountUrl).toBe("https://accounts.beta.opensteer.com");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("binds every signed OAuth callback scheme to the build's own application id", () => {
    for (const manifest of [
      "./releases/desktop-release.source.json",
      "./releases/desktop-release.beta.json",
    ]) {
      const release = readEmbeddedDesktopRelease(fileURLToPath(new URL(manifest, import.meta.url)));
      expect(new URL(release.oauth.accountCallback).protocol).toBe(`${release.application.id}:`);
      expect(new URL(release.oauth.hostCallback).protocol).toBe(`${release.application.id}:`);
    }

    const squatted = mkdtempSync(join(tmpdir(), "opensteer-desktop-squatted-"));
    try {
      const manifestPath = join(squatted, "release.json");
      writeFileSync(
        manifestPath,
        JSON.stringify({
          accountUrl: "https://accounts.opensteer.com",
          application: { channel: "stable", id: "com.opensteer.opensteer", name: "Opensteer" },
          capabilities: {
            connect: true,
            localAgents: true,
            personal: true,
            portableFs: false,
          },
          oauth: {
            // A private-use scheme that is not this build's application id:
            // any other installed app could register it.
            accountCallback: "opensteer:/oauth/account-callback",
            clientId: "opensteer-desktop",
            hostCallback: "opensteer:/oauth/host-callback",
          },
          schemaVersion: 6,
        }),
      );
      expect(() => readEmbeddedDesktopRelease(manifestPath)).toThrow(/application id/u);
    } finally {
      rmSync(squatted, { force: true, recursive: true });
    }
  });

  it("uses separate mode directories and consumes the enrollment token once", () => {
    const durableProductName = `Open${"S"}teer`;
    expect(desktopApplicationName(true, "Opensteer")).toBe(durableProductName);
    expect(desktopApplicationName(false, "Opensteer")).toBe(`${durableProductName} Development`);
    expect(desktopDataDirectory(undefined, appDataDirectory, "production")).toBe(
      `${appDataDirectory}/${durableProductName}`,
    );
    expect(desktopDataDirectory(undefined, appDataDirectory, "development")).toBe(
      `${appDataDirectory}/${durableProductName} Development`,
    );
    expect(desktopDataDirectory(undefined, appDataDirectory, "test")).toBe(
      `${appDataDirectory}/${durableProductName} Test`,
    );
    const environment = baseEnvironment();
    const loaded = readDesktopConfiguration({
      appDataDirectory,
      defaultMode: "production",
      environment,
      packaged: true,
      releaseManifestPath: packagedDesktopManifest(resourcesDirectory),
      resourcesDirectory,
    });
    expect(loaded.config.browser).toBeNull();
    expect(loaded.config.hostUrl).toBeNull();
    expect(loaded.config.accountUrl?.href).toBe("https://accounts.example.test/");
    expect(loaded.config.dataDirectory).toBe(`${appDataDirectory}/${durableProductName}`);
    expect(loaded.config.personal.workspaceRoot).toBe(
      join(homedir(), durableProductName, "Workspaces"),
    );
    // Every packaged build can run agents on this computer; only shared
    // Workspace storage still depends on a packaged PortableFS.
    expect(loaded.config.localExecution.enabled).toBe(true);
    expect(loaded.config.localExecution.portableFsInstaller).toBeUndefined();
  });

  it("requires secure production origins and permits only loopback HTTP outside production", () => {
    expect(() => read("development", "http://opensteer.example.test")).toThrow(/HTTPS/);
    const sourceBuild = read("development", "http://127.0.0.1:4310");
    expect(sourceBuild.config.hostUrl?.href).toBe("http://127.0.0.1:4310/");
    expect(sourceBuild.config.accountUrl).toBeNull();
    expect(() =>
      readDesktopConfiguration({
        appDataDirectory,
        defaultMode: "development",
        environment: baseEnvironment({
          OPENSTEER_DESKTOP_ACCOUNT_URL: "http://accounts.internal:4142",
          OPENSTEER_DESKTOP_HOST_URL: "http://127.0.0.1:4310",
        }),
        packaged: false,
      }),
    ).toThrow(/HTTPS/u);
    expect(() => read("development", "https://user@opensteer.example.test")).toThrow(
      /uncredentialed origin/,
    );
    expect(() => read("development", "https://opensteer.example.test/path")).toThrow(
      /without a path/,
    );
  });

  it("pins a packaged app to its signed Account origin and refuses Host overrides", () => {
    expect(() =>
      readDesktopConfiguration({
        appDataDirectory,
        defaultMode: "production",
        environment: baseEnvironment({
          OPENSTEER_DESKTOP_HOST_URL: "https://attacker.example.test",
        }),
        packaged: true,
        releaseManifestPath: packagedDesktopManifest(resourcesDirectory),
        resourcesDirectory,
      }),
    ).toThrow(/cannot be overridden/);
    expect(() =>
      readDesktopConfiguration({
        appDataDirectory,
        defaultMode: "production",
        environment: baseEnvironment({
          OPENSTEER_DESKTOP_ACCOUNT_URL: "https://attacker.example.test",
        }),
        packaged: true,
        releaseManifestPath: packagedDesktopManifest(resourcesDirectory),
        resourcesDirectory,
      }),
    ).toThrow(/cannot be overridden/);
    const insecureResources = packagedResources("http://accounts.example.test");
    try {
      expect(() =>
        readDesktopConfiguration({
          appDataDirectory,
          defaultMode: "production",
          environment: baseEnvironment(),
          packaged: true,
          releaseManifestPath: packagedDesktopManifest(insecureResources),
          resourcesDirectory: insecureResources,
        }),
      ).toThrow(/HTTPS/);
    } finally {
      rmSync(insecureResources, { force: true, recursive: true });
    }
    const hostPinnedResources = packagedResources();
    try {
      chmodSync(join(hostPinnedResources, "desktop", "release.json"), 0o600);
      writeFileSync(
        join(hostPinnedResources, "desktop", "release.json"),
        JSON.stringify({
          accountUrl: "https://accounts.example.test",
          hostUrl: "https://legacy-host.example.test",
          schemaVersion: 2,
        }),
      );
      expect(() =>
        readDesktopConfiguration({
          appDataDirectory,
          defaultMode: "production",
          environment: baseEnvironment(),
          packaged: true,
          releaseManifestPath: packagedDesktopManifest(hostPinnedResources),
          resourcesDirectory: hostPinnedResources,
        }),
      ).toThrow();
    } finally {
      rmSync(hostPinnedResources, { force: true, recursive: true });
    }
  });

  it("requires PortableFS files exactly when the signed capability enables them", () => {
    const incompleteResources = packagedResources("https://accounts.example.test", true, false);
    try {
      expect(() =>
        readDesktopConfiguration({
          appDataDirectory,
          defaultMode: "production",
          environment: baseEnvironment(),
          packaged: true,
          releaseManifestPath: packagedDesktopManifest(incompleteResources),
          resourcesDirectory: incompleteResources,
        }),
      ).toThrow(/PortableFS release is incomplete/u);
    } finally {
      rmSync(incompleteResources, { force: true, recursive: true });
    }

    const portableResources = packagedResources("https://accounts.example.test", true, true);
    try {
      const loaded = readDesktopConfiguration({
        appDataDirectory,
        defaultMode: "production",
        environment: baseEnvironment(),
        packaged: true,
        releaseManifestPath: packagedDesktopManifest(portableResources),
        resourcesDirectory: portableResources,
      });
      expect(loaded.config.localExecution.enabled).toBe(true);
      expect(loaded.config.localExecution.portableFsInstaller?.version).toBe("1.2.3");
    } finally {
      rmSync(portableResources, { force: true, recursive: true });
    }
  });

  it("rejects non-production mode in a packaged app", () => {
    expect(() =>
      readDesktopConfiguration({
        appDataDirectory,
        defaultMode: "production",
        environment: baseEnvironment({ OPENSTEER_DESKTOP_MODE: "development" }),
        packaged: true,
        releaseManifestPath: packagedDesktopManifest(resourcesDirectory),
        resourcesDirectory,
      }),
    ).toThrow(/packaged desktop app/);
  });

  it("carries an apex portal only for a build that declares one", () => {
    const portalResources = packagedResources(
      "https://accounts.example.test",
      false,
      false,
      "https://beta.opensteer.com",
    );
    try {
      expect(
        readDesktopConfiguration({
          appDataDirectory,
          defaultMode: "production",
          environment: baseEnvironment(),
          packaged: true,
          releaseManifestPath: packagedDesktopManifest(portalResources),
          resourcesDirectory: portalResources,
        }).config.portalUrl?.href,
      ).toBe("https://beta.opensteer.com/");
      expect(() =>
        readDesktopConfiguration({
          appDataDirectory,
          defaultMode: "production",
          environment: baseEnvironment({
            OPENSTEER_DESKTOP_PORTAL_URL: "https://attacker.example.test",
          }),
          packaged: true,
          releaseManifestPath: packagedDesktopManifest(portalResources),
          resourcesDirectory: portalResources,
        }),
      ).toThrow(/cannot be overridden/u);
    } finally {
      rmSync(portalResources, { force: true, recursive: true });
    }

    expect(
      readDesktopConfiguration({
        appDataDirectory,
        defaultMode: "production",
        environment: baseEnvironment(),
        packaged: true,
        releaseManifestPath: packagedDesktopManifest(resourcesDirectory),
        resourcesDirectory,
      }).config.portalUrl,
    ).toBeNull();
    expect(
      readDesktopConfiguration({
        appDataDirectory,
        defaultMode: "development",
        environment: baseEnvironment({
          OPENSTEER_DESKTOP_PORTAL_URL: "https://beta.opensteer.com",
        }),
        packaged: false,
      }).config.portalUrl?.href,
    ).toBe("https://beta.opensteer.com/");
    expect(() =>
      readDesktopConfiguration({
        appDataDirectory,
        defaultMode: "development",
        environment: baseEnvironment({
          OPENSTEER_DESKTOP_PORTAL_URL: "https://beta.opensteer.com/portal",
        }),
        packaged: false,
      }),
    ).toThrow(/without a path/u);
  });

  it("configures the bundled Electron browser without persisting bridge secrets", () => {
    const environment = baseEnvironment({ OPENSTEER_DESKTOP_BROWSER_ENABLED: undefined });
    const loaded = readDesktopConfiguration({
      appDataDirectory,
      defaultMode: "production",
      environment,
      packaged: true,
      releaseManifestPath: packagedDesktopManifest(resourcesDirectory),
      resourcesDirectory,
    });
    expect(loaded.config.browser).toMatchObject({
      profileRoot: expect.stringContaining("browser-profiles"),
      runtimeId: "desktop-browser",
    });
    expect(environment.OPENSTEER_BROWSER_DEVICE_BRIDGE_TOKEN).toBeUndefined();
    expect(environment.OPENSTEER_DEVICE_BROWSER_RUNTIME_TOKEN).toBeUndefined();
  });
});

function read(mode: DesktopMode, hostUrl: string) {
  return readDesktopConfiguration({
    appDataDirectory,
    defaultMode: mode,
    environment: baseEnvironment({ OPENSTEER_DESKTOP_HOST_URL: hostUrl }),
    packaged: false,
  });
}

function packagedResources(
  accountUrl = "https://accounts.example.test",
  portableFs = false,
  includePortableFs = portableFs,
  portalUrl: string | undefined = undefined,
): string {
  const directory = mkdtempSync(join(tmpdir(), "opensteer-desktop-resources-"));
  const desktop = join(directory, "desktop");
  mkdirSync(desktop, { mode: 0o700 });
  writeFileSync(
    join(desktop, "release.json"),
    JSON.stringify({
      accountUrl,
      application: {
        channel: "stable",
        id: "com.opensteer.opensteer",
        name: "Opensteer",
      },
      capabilities: { connect: true, localAgents: true, personal: true, portableFs },
      oauth: {
        accountCallback: "com.opensteer.opensteer:/oauth/account-callback",
        clientId: "opensteer-desktop",
        hostCallback: "com.opensteer.opensteer:/oauth/host-callback",
      },
      ...(portalUrl ? { portalUrl } : {}),
      schemaVersion: 6,
    }),
    { mode: 0o444 },
  );
  if (includePortableFs) {
    const portableFs = join(directory, "portablefs");
    mkdirSync(portableFs, { mode: 0o700 });
    const installer = "#!/bin/sh\nexit 0\n";
    writeFileSync(join(portableFs, "install.sh"), installer, { mode: 0o555 });
    writeFileSync(
      join(portableFs, "release.json"),
      JSON.stringify({
        installerSha256: createHash("sha256").update(installer).digest("hex"),
        schemaVersion: 1,
        version: "1.2.3",
      }),
      { mode: 0o444 },
    );
  }
  const runner = join(directory, "runner");
  mkdirSync(runner, { mode: 0o700 });
  const helper = "test-native-filesystem-helper";
  writeFileSync(join(runner, "opensteer-native-fs"), helper, { mode: 0o555 });
  writeFileSync(
    join(runner, "release.json"),
    JSON.stringify({
      architecture: arch() === "x64" ? "amd64" : arch(),
      binarySha256: createHash("sha256").update(helper).digest("hex"),
      operatingSystem: platform(),
      schemaVersion: 1,
    }),
    { mode: 0o444 },
  );
  return directory;
}

function packagedDesktopManifest(resourcesDirectoryValue: string): string {
  return join(resourcesDirectoryValue, "desktop", "release.json");
}

function baseEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    OPENSTEER_DESKTOP_BROWSER_ENABLED: "false",
    ...overrides,
  };
}
