import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createId } from "@opensteer/core";
import { afterAll, describe, expect, it } from "vitest";
import {
  desktopApplicationName,
  desktopNativeHelperPlatform,
  readDesktopConfiguration,
} from "./config.js";
import { registerDesktopOAuthProtocolClient } from "./account/oauth-protocol-client.js";
import { hostSpec } from "./supervisor/personal-deployment-supervisor.js";

/*
 * A trial (`OPENSTEER_DESKTOP_TRIAL_ROOT`) is a development launch that keeps to one folder of its
 * own, beside an installed Opensteer on the same Mac. Whatever the installed app owns — its data
 * folder, its Agent home, its callback scheme, its helpers and their macOS grants — the trial
 * neither uses nor changes.
 */

const scratch = mkdtempSync(path.join(tmpdir(), "opensteer-trial-test-"));
afterAll(() => rmSync(scratch, { force: true, recursive: true }));
const home = path.join(scratch, "home");
const appData = path.join(home, "Library", "Application Support");
mkdirSync(appData, { recursive: true });

function trial(root: string, environment: NodeJS.ProcessEnv = {}, packaged = false) {
  return readDesktopConfiguration({
    appDataDirectory: appData,
    defaultMode: packaged ? "production" : "development",
    environment: {
      OPENSTEER_DESKTOP_BROWSER_ENABLED: "false",
      OPENSTEER_DESKTOP_TRIAL_ROOT: root,
      ...environment,
    },
    homeDirectory: home,
    packaged,
    ...(packaged
      ? {
          releaseManifestPath: fileURLToPath(
            new URL("./releases/desktop-release.json", import.meta.url),
          ),
          resourcesDirectory: packagedRunnerResources(),
        }
      : {}),
  });
}

/** The one packaged resource a released configuration checks before it reads anything else. */
function packagedRunnerResources(): string {
  const directory = mkdtempSync(path.join(scratch, "resources-"));
  const runner = path.join(directory, "runner");
  mkdirSync(runner);
  const helper = "test-native-filesystem-helper";
  writeFileSync(path.join(runner, "opensteer-native-fs"), helper, { mode: 0o555 });
  writeFileSync(
    path.join(runner, "release.json"),
    JSON.stringify({
      architecture: arch() === "x64" ? "amd64" : arch(),
      binarySha256: createHash("sha256").update(helper).digest("hex"),
      operatingSystem: platform(),
      schemaVersion: 1,
    }),
  );
  return directory;
}

describe("a trial", () => {
  it("keeps its data, Agent home and downloads under its one root", () => {
    const root = path.join(home, "Opensteer Trial");
    const { config } = trial(root);
    expect(config.trial).toEqual({
      agentHome: path.join(root, "Agent home"),
      downloads: path.join(root, "Downloads"),
      root,
    });
    expect(config.dataDirectory).toBe(path.join(root, "Data"));
    expect(config.localExecution.dataDirectory).toBe(path.join(root, "Data", "runner"));
    expect(config.accountUrl).toBeNull();
    expect(config.portalUrl).toBeNull();
  });

  it("names itself apart from both the installed app and an ordinary source run", () => {
    expect(desktopApplicationName(false, "Opensteer", "development", true)).toBe("Opensteer Trial");
    expect(desktopApplicationName(false, "Opensteer", "development", false)).toBe(
      "Opensteer Development",
    );
    // A released app has no trial: its name is its own whatever is asked.
    expect(desktopApplicationName(true, "Opensteer", "production", true)).toBe("Opensteer");
  });

  it("is never read by a released app", () => {
    const { config } = trial(path.join(home, "Opensteer Trial"), {}, true);
    expect(config.trial).toBeNull();
    expect(config.dataDirectory).toBe(path.join(appData, "Opensteer"));
  });

  it("refuses a root inside, equal to or around an installed Opensteer's folders", () => {
    for (const root of [
      path.join(appData, "Opensteer"),
      path.join(appData, "Opensteer", "Trial"),
      path.join(appData, "Opensteer Beta", "Trial"),
      path.join(home, "Opensteer"),
      path.join(home, "Opensteer", "Trial"),
      appData,
      home,
    ]) {
      expect(() => trial(root), root).toThrow(/installed Opensteer/u);
    }
  });

  it("refuses a root that reaches an installed Opensteer's folder through a link", () => {
    mkdirSync(path.join(appData, "Opensteer"), { recursive: true });
    const linked = path.join(scratch, "linked-trial");
    symlinkSync(path.join(appData, "Opensteer"), linked);
    expect(() => trial(linked)).toThrow(/installed Opensteer/u);
  });

  it("keeps the Opensteer account off and takes no second data folder", () => {
    const root = path.join(home, "Opensteer Trial");
    for (const name of [
      "OPENSTEER_DESKTOP_ACCOUNT_URL",
      "OPENSTEER_DESKTOP_PORTAL_URL",
      "OPENSTEER_DESKTOP_HOST_URL",
    ]) {
      expect(() => trial(root, { [name]: "https://accounts.opensteer.com" }), name).toThrow(
        /trial/u,
      );
    }
    expect(() => trial(root, { OPENSTEER_DESKTOP_DATA_DIR: path.join(root, "Data") })).toThrow(
      /trial/u,
    );
  });

  it("runs only as a development launch, from an absolute root", () => {
    expect(() => trial("Opensteer Trial")).toThrow(/absolute/u);
    expect(() =>
      trial(path.join(home, "Opensteer Trial"), { OPENSTEER_DESKTOP_MODE: "test" }),
    ).toThrow(/development/u);
  });

  it("runs none of the helpers an installed Opensteer shares", () => {
    const { config } = trial(path.join(home, "Opensteer Trial"));
    expect(desktopNativeHelperPlatform(config, "darwin")).not.toBe("darwin");
    expect(desktopNativeHelperPlatform({ trial: null }, "darwin")).toBe("darwin");
  });

  it("leaves the installed app's callback scheme where it is", () => {
    const registered: string[] = [];
    const application = {
      setAsDefaultProtocolClient: (scheme: string) => {
        registered.push(scheme);
        return true;
      },
    };
    const common = {
      application,
      defaultApp: true,
      entryArgument: "dist/main.js",
      executablePath: "/electron",
      scheme: "com.opensteer.opensteer",
    };
    registerDesktopOAuthProtocolClient({ ...common, trial: true });
    expect(registered).toEqual([]);
    registerDesktopOAuthProtocolClient({ ...common, trial: false });
    expect(registered).toEqual(["com.opensteer.opensteer"]);
  });

  it("hands the Home its own Agent home, and a Home without a trial none", () => {
    const withTrial = hostEnvironment(path.join(home, "Opensteer Trial", "Agent home"));
    expect(withTrial["OPENSTEER_AGENT_HOME"]).toBe(
      path.join(home, "Opensteer Trial", "Agent home"),
    );
    expect(hostEnvironment(null)).not.toHaveProperty("OPENSTEER_AGENT_HOME");
  });
});

function hostEnvironment(agentHome: string | null): Readonly<Record<string, string>> {
  return hostSpec(
    {
      assets: {
        webDistribution: {
          directory: "/runtime/web",
          hostVersion: "0.1.219",
          manifestPath: "/runtime/web/manifest.json",
        },
      },
      entrypoints: { host: "/runtime/host" },
    } as never,
    {
      deploymentId: createId("deployment"),
      environmentId: createId("environment"),
      hostInstanceId: createId("hostInstance"),
      hostKeyFingerprint: `sha256:${"A".repeat(43)}`,
      hostPort: 45_211,
      name: "Studio Mac",
      postgresPort: 45_212,
    } as never,
    {
      credentialKeyPath: "/data/credential.key",
      hostDataDirectory: "/data/host",
      hostPrivateKeyPath: "/data/host.key",
      hostPublicKeyPath: "/data/host.pub",
    } as never,
    {
      databasePassword: "database",
      hostAuthSecret: "auth-secret",
      messagingEnrollmentToken: "messaging-enrollment",
    } as never,
    "owner-claim",
    null,
    null,
    false,
    null,
    null,
    null,
    agentHome,
  ).environment;
}
