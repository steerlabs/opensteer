import { lstat, mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createId } from "@opensteer/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireDesktopApplicationLock,
  configureDesktopApplicationPaths,
  desktopConnectSecretsPath,
  desktopDeploymentCatalogPath,
  desktopDeploymentPaths,
  prepareDesktopDeploymentDirectories,
} from "./application-paths.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("desktop application paths", () => {
  it("configures the isolated data paths before requesting the instance lock", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "opensteer-desktop-paths-"));
    temporaryDirectories.push(dataDirectory);
    const calls: string[] = [];
    const application = {
      requestSingleInstanceLock: vi.fn(() => {
        calls.push("lock");
        return true;
      }),
      setAppLogsPath: vi.fn((value: string) => calls.push(`logs:${value}`)),
      setPath: vi.fn((name: string, value: string) => calls.push(`${name}:${value}`)),
    };

    configureDesktopApplicationPaths(application, dataDirectory);
    expect(acquireDesktopApplicationLock(application)).toBe(true);
    expect(calls).toEqual([
      `userData:${dataDirectory}`,
      `sessionData:${path.join(dataDirectory, "session")}`,
      `crashDumps:${path.join(dataDirectory, "crash-dumps")}`,
      `logs:${path.join(dataDirectory, "logs")}`,
      "lock",
    ]);
  });

  it("does not use Node pathname creation as the startup authority", () => {
    const dataDirectory = path.join(tmpdir(), `opensteer-windows-paths-${Date.now()}`);
    const application = {
      requestSingleInstanceLock: vi.fn(() => true),
      setAppLogsPath: vi.fn(),
      setPath: vi.fn(),
    };
    configureDesktopApplicationPaths(application, dataDirectory);
    expect(acquireDesktopApplicationLock(application)).toBe(true);
    expect(existsSync(dataDirectory)).toBe(false);
  });

  it("derives and prepares isolated mutable paths from a validated Deployment ID", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "opensteer-deployment-paths-"));
    temporaryDirectories.push(dataDirectory);
    const deploymentId = createId("deployment");
    const expectedRoot = path.join(dataDirectory, "deployments", deploymentId);

    const paths = prepareDesktopDeploymentDirectories(dataDirectory, deploymentId);

    expect(paths).toEqual({
      browserProfilesDirectory: path.join(expectedRoot, "browser-profiles"),
      hostDataDirectory: path.join(expectedRoot, "host"),
      logsDirectory: path.join(expectedRoot, "logs"),
      manifestPath: path.join(expectedRoot, "deployment.v1.json"),
      postgresDataDirectory: path.join(expectedRoot, "postgres"),
      rootDirectory: expectedRoot,
      runnerDataDirectory: path.join(expectedRoot, "runner"),
      runtimeDirectory: path.join(expectedRoot, "runtime"),
      temporaryDirectory: path.join(expectedRoot, "tmp"),
    });
    for (const directory of Object.values(paths).filter((value) => value !== paths.manifestPath)) {
      expect((await lstat(directory)).isDirectory()).toBe(true);
    }
    expect(desktopDeploymentCatalogPath(dataDirectory)).toBe(
      path.join(dataDirectory, "deployment-connections.v1.json"),
    );
    expect(desktopConnectSecretsPath(dataDirectory, deploymentId)).toBe(
      path.join(expectedRoot, "connect.v1.json"),
    );
  });

  it("rejects invalid Deployment path segments before touching the filesystem", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "opensteer-invalid-paths-"));
    temporaryDirectories.push(dataDirectory);

    expect(() => desktopDeploymentPaths(dataDirectory, "../../outside")).toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "refuses a symlinked per-Deployment data root",
    async () => {
      const dataDirectory = await mkdtemp(path.join(tmpdir(), "opensteer-symlink-paths-"));
      const outsideDirectory = await mkdtemp(path.join(tmpdir(), "opensteer-symlink-target-"));
      temporaryDirectories.push(dataDirectory, outsideDirectory);
      const deploymentId = createId("deployment");
      const deploymentsDirectory = path.join(dataDirectory, "deployments");
      await mkdir(deploymentsDirectory, { mode: 0o700 });
      await symlink(outsideDirectory, path.join(deploymentsDirectory, deploymentId), "dir");

      expect(() => prepareDesktopDeploymentDirectories(dataDirectory, deploymentId)).toThrow(
        "not a real directory",
      );
    },
  );
});

it("keeps native browser data outside disposable enrollment slots", () => {
  const deploymentId = createId("deployment");
  const root = path.join(tmpdir(), "opensteer-test-paths");
  const paths = desktopDeploymentPaths(root, deploymentId);
  const slot = path.join(root, "runner", "deployments", deploymentId);
  expect(path.relative(slot, paths.browserProfilesDirectory).startsWith(".." + path.sep)).toBe(
    true,
  );
  expect(paths.browserProfilesDirectory).toBe(
    path.join(root, "deployments", deploymentId, "browser-profiles"),
  );
});
