import { ensurePrivateDirectorySync } from "@opensteer/shared/privateFiles";
import path from "node:path";
import { DeploymentIdSchema, type DeploymentId } from "@opensteer/core";
import type { App } from "electron";
import type { DesktopPrivateFilesystem } from "../secrets/desktop-private-files.js";

type DesktopApplicationPaths = Pick<App, "setAppLogsPath" | "setPath">;
type DesktopApplicationLock = Pick<App, "requestSingleInstanceLock">;

/**
 * Bind Electron to the verified profile before the startup sequence crosses
 * its first asynchronous boundary. Chromium may launch service processes while
 * an awaited native operation is pending, so delaying these calls can split a
 * single app instance across two user-data roots.
 */
export function configureDesktopApplicationPaths(
  application: DesktopApplicationPaths,
  dataDirectory: string,
): void {
  const rootDirectory = path.resolve(dataDirectory);
  const sessionDirectory = path.join(rootDirectory, "session");
  const logsDirectory = path.join(rootDirectory, "logs");
  const crashDirectory = path.join(rootDirectory, "crash-dumps");
  application.setPath("userData", rootDirectory);
  application.setPath("sessionData", sessionDirectory);
  application.setPath("crashDumps", crashDirectory);
  application.setAppLogsPath(logsDirectory);
}

/** Derive the instance lock only after Electron has been bound to its profile. */
export function acquireDesktopApplicationLock(application: DesktopApplicationLock): boolean {
  return application.requestSingleInstanceLock();
}

/**
 * Re-verify the Electron-owned mutable roots through the native handle-relative
 * authority before Electron starts writing profiles, logs, or crash reports.
 */
export function prepareDesktopApplicationDirectories(privateFiles: DesktopPrivateFilesystem): void {
  for (const directory of [
    privateFiles.root,
    path.join(privateFiles.root, "session"),
    path.join(privateFiles.root, "logs"),
    path.join(privateFiles.root, "crash-dumps"),
  ]) {
    privateFiles.ensureDirectorySync(directory);
  }
}

export interface DesktopDeploymentPaths {
  /** Durable native profiles; enrollment-slot removal must never remove this tree. */
  readonly browserProfilesDirectory: string;
  readonly hostDataDirectory: string;
  readonly logsDirectory: string;
  readonly manifestPath: string;
  readonly postgresDataDirectory: string;
  readonly rootDirectory: string;
  readonly runnerDataDirectory: string;
  readonly runtimeDirectory: string;
  readonly temporaryDirectory: string;
}

/**
 * Resolve every mutable path owned by one Deployment beneath its stable ID.
 * The branded ID schema prevents a catalog value from becoming a path segment
 * until it has passed the same validation as the durable product identity.
 */
export function desktopDeploymentPaths(
  dataDirectory: string,
  deploymentId: DeploymentId | string,
): DesktopDeploymentPaths {
  const id = DeploymentIdSchema.parse(deploymentId);
  const rootDirectory = path.join(path.resolve(dataDirectory), "deployments", id);
  return {
    browserProfilesDirectory: path.join(rootDirectory, "browser-profiles"),
    hostDataDirectory: path.join(rootDirectory, "host"),
    logsDirectory: path.join(rootDirectory, "logs"),
    manifestPath: path.join(rootDirectory, "deployment.v1.json"),
    postgresDataDirectory: path.join(rootDirectory, "postgres"),
    rootDirectory,
    runnerDataDirectory: path.join(rootDirectory, "runner"),
    runtimeDirectory: path.join(rootDirectory, "runtime"),
    temporaryDirectory: path.join(rootDirectory, "tmp"),
  };
}

export function desktopDeploymentCatalogPath(dataDirectory: string): string {
  return path.join(path.resolve(dataDirectory), "deployment-connections.v1.json");
}

/** Ciphertext only. The encryption key remains in the operating-system credential store. */
export function desktopNativeAuthSecretsPath(dataDirectory: string): string {
  return path.join(path.resolve(dataDirectory), "native-auth-secrets.v1.json");
}

/** Connector credentials stay separate from Account and Host OAuth tokens. */
export function desktopConnectSecretsPath(
  dataDirectory: string,
  deploymentId: DeploymentId | string,
): string {
  return path.join(
    desktopDeploymentPaths(dataDirectory, deploymentId).rootDirectory,
    "connect.v1.json",
  );
}

/** Account-link challenges and Host credentials are independent from the
 * disposable Cloudflare connector credential lifecycle. */
export function desktopPersonalAccountLinkSecretsPath(
  dataDirectory: string,
  deploymentId: DeploymentId | string,
): string {
  return path.join(
    desktopDeploymentPaths(dataDirectory, deploymentId).rootDirectory,
    "personal-account-link.v1.json",
  );
}

/**
 * Create only app-owned directories and reject symlinked replacements. Service
 * supervisors may then pass these exact paths to their children without a
 * Deployment sharing mutable state with another Deployment.
 */
export function prepareDesktopDeploymentDirectories(
  dataDirectory: string,
  deploymentId: DeploymentId | string,
): DesktopDeploymentPaths {
  const paths = desktopDeploymentPaths(dataDirectory, deploymentId);
  for (const directory of [
    path.resolve(dataDirectory),
    path.join(path.resolve(dataDirectory), "deployments"),
    paths.rootDirectory,
    paths.browserProfilesDirectory,
    paths.hostDataDirectory,
    paths.logsDirectory,
    paths.postgresDataDirectory,
    paths.runnerDataDirectory,
    paths.runtimeDirectory,
    paths.temporaryDirectory,
  ]) {
    ensurePrivateDirectorySync(
      directory,
      `Desktop data path is not a real directory: ${directory}`,
    );
  }
  return paths;
}

export async function preparePrivateDesktopDeploymentDirectories(
  privateFiles: DesktopPrivateFilesystem,
  dataDirectory: string,
  deploymentId: DeploymentId | string,
): Promise<DesktopDeploymentPaths> {
  const paths = desktopDeploymentPaths(dataDirectory, deploymentId);
  for (const directory of [
    path.resolve(dataDirectory),
    path.join(path.resolve(dataDirectory), "deployments"),
    paths.rootDirectory,
    paths.browserProfilesDirectory,
    paths.hostDataDirectory,
    paths.logsDirectory,
    paths.postgresDataDirectory,
    paths.runnerDataDirectory,
    paths.runtimeDirectory,
    paths.temporaryDirectory,
  ]) {
    await privateFiles.ensureDirectory(directory);
  }
  return paths;
}
