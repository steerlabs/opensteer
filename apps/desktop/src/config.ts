import type { NativeOAuthIdentity } from "@opensteer/client/auth";
import { requiredStringValue } from "@opensteer/shared/envParsing";
import { nodeErrorCode } from "@opensteer/shared/nodeError";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { arch as hostArchitecture, platform as hostPlatform } from "node:os";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  isLoopbackHostname,
  opensteerDesktopAccountOAuthCallback,
  opensteerDesktopHostOAuthCallback,
  opensteerDesktopOAuthClientId,
} from "@opensteer/core";

export type DesktopMode = "development" | "production" | "test";

const DesktopUpdatesSchema = z.strictObject({
  owner: z.literal("steerlabs"),
  repo: z.literal("opensteer"),
  channel: z.enum(["latest", "insider"]),
  host: z
    .string()
    .regex(/^[a-zA-Z0-9.-]+(?::[0-9]+)?$/u)
    .optional(),
});
export type DesktopUpdates = z.infer<typeof DesktopUpdatesSchema>;

export interface DesktopBrowserRuntimeConfig {
  readonly profileRoot: string;
  readonly runtimeId: string;
}

export interface DesktopConfiguration {
  readonly accountUrl: URL | null;
  readonly browser: DesktopBrowserRuntimeConfig | null;
  readonly dataDirectory: string;
  /** Optional source-build bootstrap Host. Signed installs begin with an empty catalog. */
  readonly hostUrl: URL | null;
  readonly localExecution: DesktopLocalExecutionConfiguration;
  readonly mode: DesktopMode;
  readonly personal: DesktopPersonalDeploymentConfiguration;
  /** Apex portal this build opens in the system browser. Null means the build
   * belongs to no portal and the app offers no such destination. */
  readonly portalUrl: URL | null;
  readonly updates?: DesktopUpdates;
  readonly release: DesktopReleaseIdentity;
}

export interface DesktopReleaseIdentity {
  readonly channel: "beta" | "stable";
  readonly id: string;
  readonly name: string;
  readonly oauth: NativeOAuthIdentity;
}

export interface DesktopLocalExecutionConfiguration {
  readonly dataDirectory: string;
  /** Signed release capability. False means local PortableFS execution is unavailable. */
  readonly enabled: boolean;
  readonly nativeFsHelperBinary: string;
  readonly portableFsBinary: string | undefined;
  readonly portableFsInstaller: { readonly path: string; readonly version: string } | undefined;
  readonly runnerWorkerPath: string;
}

export interface DesktopPersonalDeploymentConfiguration {
  readonly releaseDirectory: string;
  readonly workspaceRoot: string;
}

export interface LoadedDesktopConfiguration {
  readonly config: DesktopConfiguration;
}

interface ReadDesktopConfigurationOptions {
  readonly appDataDirectory: string;
  readonly defaultMode: DesktopMode;
  readonly environment?: NodeJS.ProcessEnv;
  readonly packaged: boolean;
  /** Integrity-protected app code path containing the embedded release policy. */
  readonly releaseManifestPath?: string;
  readonly resourcesDirectory?: string;
}

const EnvironmentSchema = z.object({
  OPENSTEER_DESKTOP_ACCOUNT_URL: z.string().optional(),
  OPENSTEER_DESKTOP_BROWSER_ENABLED: z.string().optional(),
  OPENSTEER_DESKTOP_BROWSER_RUNTIME_ID: z.string().optional(),
  OPENSTEER_DESKTOP_DATA_DIR: z.string().optional(),
  OPENSTEER_DESKTOP_HOST_URL: z.string().optional(),
  OPENSTEER_DESKTOP_MODE: z.string().optional(),
  OPENSTEER_DESKTOP_NATIVE_FS_HELPER: z.string().optional(),
  OPENSTEER_DESKTOP_PORTABLEFS_BINARY: z.string().optional(),
  OPENSTEER_DESKTOP_PORTABLEFS_INSTALLER: z.string().optional(),
  OPENSTEER_DESKTOP_PORTABLEFS_VERSION: z.string().optional(),
  OPENSTEER_DESKTOP_PORTAL_URL: z.string().optional(),
  OPENSTEER_DESKTOP_RUNNER_WORKER: z.string().optional(),
  OPENSTEER_DESKTOP_PERSONAL_RELEASE_DIR: z.string().optional(),
  OPENSTEER_DESKTOP_PERSONAL_WORKSPACE_ROOT: z.string().optional(),
});

export function readDesktopConfiguration(
  options: ReadDesktopConfigurationOptions,
): LoadedDesktopConfiguration {
  const environment = options.environment ?? process.env;
  const resourcesDirectory = absolutePath(
    options.resourcesDirectory ?? path.dirname(fileURLToPath(import.meta.url)),
    "Desktop resources directory",
  );
  const parsed = EnvironmentSchema.parse(environment);
  const mode = desktopMode(parsed.OPENSTEER_DESKTOP_MODE, options.defaultMode);
  if (options.packaged && mode !== "production") {
    throw new Error("A packaged desktop app must run in production mode.");
  }
  if (
    options.packaged &&
    (optional(parsed.OPENSTEER_DESKTOP_HOST_URL) ||
      optional(parsed.OPENSTEER_DESKTOP_ACCOUNT_URL) ||
      optional(parsed.OPENSTEER_DESKTOP_PORTAL_URL))
  ) {
    throw new Error(
      "A packaged desktop app's signed service origins and capabilities cannot be overridden.",
    );
  }
  const packagedDesktop = options.packaged
    ? readPackagedDesktopRelease(
        absolutePath(
          options.releaseManifestPath ??
            fileURLToPath(new URL("./desktop-release.json", import.meta.url)),
          "Packaged Desktop release policy",
        ),
      )
    : undefined;
  const release = packagedDesktop?.release ?? defaultDesktopReleaseIdentity;
  const dataDirectory = desktopDataDirectory(
    parsed.OPENSTEER_DESKTOP_DATA_DIR,
    options.appDataDirectory,
    mode,
    release.name,
  );
  const configuredHostUrl = optional(parsed.OPENSTEER_DESKTOP_HOST_URL);
  const hostUrl = configuredHostUrl ? hostPageUrl(configuredHostUrl, mode) : null;
  const accountUrlValue = packagedDesktop
    ? packagedDesktop.accountUrl
    : optional(parsed.OPENSTEER_DESKTOP_ACCOUNT_URL);
  const accountUrl = accountUrlValue
    ? serviceOrigin(accountUrlValue, mode, "Opensteer Account URL")
    : null;
  const portalUrlValue =
    packagedDesktop?.portalUrl ?? optional(parsed.OPENSTEER_DESKTOP_PORTAL_URL);
  const portalUrl = portalUrlValue
    ? serviceOrigin(portalUrlValue, mode, "Opensteer portal URL")
    : null;

  const browserEnabled = booleanValue(
    parsed.OPENSTEER_DESKTOP_BROWSER_ENABLED,
    true,
    "OPENSTEER_DESKTOP_BROWSER_ENABLED",
  );
  let browser: DesktopBrowserRuntimeConfig | null = null;
  if (browserEnabled) {
    const runtimeId = optional(parsed.OPENSTEER_DESKTOP_BROWSER_RUNTIME_ID) ?? "desktop-browser";
    if (runtimeId.length > 255) {
      throw new Error("OPENSTEER_DESKTOP_BROWSER_RUNTIME_ID is too long.");
    }
    browser = {
      profileRoot: path.join(dataDirectory, "browser-profiles"),
      runtimeId,
    };
  }

  const portableFsInstallerPath = optional(parsed.OPENSTEER_DESKTOP_PORTABLEFS_INSTALLER);
  const portableFsVersion = optional(parsed.OPENSTEER_DESKTOP_PORTABLEFS_VERSION);
  if (options.packaged && (portableFsInstallerPath || portableFsVersion)) {
    throw new Error("Packaged PortableFS release identity cannot be overridden at runtime.");
  }
  if (portableFsInstallerPath && !portableFsVersion) {
    throw new Error(
      "OPENSTEER_DESKTOP_PORTABLEFS_INSTALLER and OPENSTEER_DESKTOP_PORTABLEFS_VERSION must be configured together.",
    );
  }
  if (
    portableFsVersion &&
    !/^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(portableFsVersion)
  ) {
    throw new Error("OPENSTEER_DESKTOP_PORTABLEFS_VERSION must be stable SemVer.");
  }
  const packagedPortableFsRunner =
    packagedDesktop === undefined
      ? portableFsVersion !== undefined ||
        optional(parsed.OPENSTEER_DESKTOP_PORTABLEFS_BINARY) !== undefined
      : packagedDesktop.portableFs;
  const packagedPortableFs = options.packaged
    ? readPackagedPortableFsRelease(resourcesDirectory, packagedPortableFsRunner)
    : undefined;
  // Running agents on this computer no longer needs PortableFS: a machine can
  // hold its own Workspace directories. PortableFS is the separate capability
  // that also lets it mount this Deployment's shared storage.
  const localAgentsEnabled = packagedDesktop?.localAgents ?? true;
  const packagedNativeFsHelper = options.packaged
    ? readPackagedNativeFsHelper(resourcesDirectory)
    : undefined;
  const localExecution: DesktopLocalExecutionConfiguration = {
    dataDirectory: path.join(dataDirectory, "runner"),
    enabled: localAgentsEnabled,
    nativeFsHelperBinary: absolutePath(
      optional(parsed.OPENSTEER_DESKTOP_NATIVE_FS_HELPER) ??
        packagedNativeFsHelper ??
        path.join(resourcesDirectory, "runner", "opensteer-native-fs"),
      "OPENSTEER_DESKTOP_NATIVE_FS_HELPER",
    ),
    portableFsBinary: optional(parsed.OPENSTEER_DESKTOP_PORTABLEFS_BINARY)
      ? absolutePath(
          requiredStringValue(parsed.OPENSTEER_DESKTOP_PORTABLEFS_BINARY, "PortableFS binary"),
          "OPENSTEER_DESKTOP_PORTABLEFS_BINARY",
        )
      : undefined,
    portableFsInstaller:
      packagedPortableFs ??
      (portableFsVersion
        ? {
            path: absolutePath(
              portableFsInstallerPath ?? path.join(resourcesDirectory, "portablefs", "install.sh"),
              "OPENSTEER_DESKTOP_PORTABLEFS_INSTALLER",
            ),
            version: portableFsVersion.replace(/^v/u, ""),
          }
        : undefined),
    runnerWorkerPath: absolutePath(
      optional(parsed.OPENSTEER_DESKTOP_RUNNER_WORKER) ??
        fileURLToPath(new URL("./runner-worker.js", import.meta.url)),
      "OPENSTEER_DESKTOP_RUNNER_WORKER",
    ),
  };
  if (hostPlatform() === "win32" && !options.packaged) {
    const helperOverride = optional(parsed.OPENSTEER_DESKTOP_NATIVE_FS_HELPER);
    if (!helperOverride) {
      throw new Error(
        "OPENSTEER_DESKTOP_NATIVE_FS_HELPER is required for an unpackaged Windows Desktop build.",
      );
    }
  }
  if (
    options.packaged &&
    (optional(parsed.OPENSTEER_DESKTOP_PERSONAL_RELEASE_DIR) ||
      optional(parsed.OPENSTEER_DESKTOP_PERSONAL_WORKSPACE_ROOT))
  ) {
    throw new Error("Packaged Personal runtime paths cannot be overridden.");
  }
  const personal: DesktopPersonalDeploymentConfiguration = {
    releaseDirectory: absolutePath(
      optional(parsed.OPENSTEER_DESKTOP_PERSONAL_RELEASE_DIR) ??
        path.join(resourcesDirectory, "personal-runtime"),
      "OPENSTEER_DESKTOP_PERSONAL_RELEASE_DIR",
    ),
    workspaceRoot: absolutePath(
      optional(parsed.OPENSTEER_DESKTOP_PERSONAL_WORKSPACE_ROOT) ??
        path.join(homedir(), durableDesktopPathName("Opensteer"), "Workspaces"),
      "OPENSTEER_DESKTOP_PERSONAL_WORKSPACE_ROOT",
    ),
  };

  return {
    config: {
      accountUrl,
      browser,
      dataDirectory,
      hostUrl,
      localExecution,
      mode,
      personal,
      portalUrl,
      release,
      ...(packagedDesktop?.updates ? { updates: packagedDesktop.updates } : {}),
    },
  };
}

const PackagedPortableFsReleaseSchema = z.strictObject({
  installerSha256: z.string().regex(/^[a-f0-9]{64}$/),
  schemaVersion: z.literal(1),
  version: z.string().regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/),
});

const NativeOAuthCallbackSchema = z.string().superRefine((value, context) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    context.addIssue({ code: "custom", message: "Expected an absolute native callback URI" });
    return;
  }
  if (
    url.protocol === "http:" ||
    url.protocol === "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    nativeCallbackIdentity(url) !== value
  ) {
    context.addIssue({
      code: "custom",
      message: "Expected a canonical private-use native callback URI",
    });
  }
});

const DesktopOAuthIdentitySchema = z
  .strictObject({
    accountCallback: NativeOAuthCallbackSchema,
    clientId: z.string().regex(/^[A-Za-z0-9._~-]{1,255}$/u),
    hostCallback: NativeOAuthCallbackSchema,
  })
  .refine((value) => value.accountCallback !== value.hostCallback, {
    message: "Account and Host OAuth callbacks must be different",
  })
  .refine(
    (value) => new URL(value.accountCallback).protocol === new URL(value.hostCallback).protocol,
    { message: "Account and Host OAuth callbacks must use the same application scheme" },
  );

const PackagedDesktopReleaseBaseSchema = z.strictObject({
  application: z.strictObject({
    channel: z.enum(["beta", "stable"]),
    id: z.string().regex(/^[a-z][a-z0-9]*(?:\.[a-z0-9][a-z0-9-]*)+$/u),
    name: z.string().trim().min(1).max(80),
    stage: z.literal("alpha").optional(),
  }),
  capabilities: z.strictObject({
    connect: z.boolean(),
    personal: z.literal(true),
    localAgents: z.boolean(),
    portableFs: z.boolean(),
  }),
  oauth: DesktopOAuthIdentitySchema,
  /** Present only for a build that belongs to a managed portal. */
  portalUrl: z.url().optional(),
  updates: DesktopUpdatesSchema.optional(),
  schemaVersion: z.literal(6),
});

const PackagedDesktopReleaseSchema = z
  .union([
    PackagedDesktopReleaseBaseSchema.extend({
      accountUrl: z.url(),
      capabilities: PackagedDesktopReleaseBaseSchema.shape.capabilities.extend({
        connect: z.literal(true),
      }),
    }),
    PackagedDesktopReleaseBaseSchema.extend({
      accountUrl: z.never().optional(),
      capabilities: PackagedDesktopReleaseBaseSchema.shape.capabilities.extend({
        connect: z.literal(false),
      }),
    }),
  ])
  // RFC 8252: a native client's redirect scheme must be a name it actually owns
  // with the operating system. Asserting it *is* the application id — rather
  // than merely that it is private-use — is what makes a squattable generic
  // scheme unrepresentable rather than merely discouraged.
  .refine((value) => new URL(value.oauth.accountCallback).protocol === `${value.application.id}:`, {
    message: "OAuth callbacks must use the build's own application id as their scheme",
    path: ["oauth"],
  });

const defaultDesktopReleaseIdentity: DesktopReleaseIdentity = {
  channel: "stable",
  id: "com.opensteer.opensteer",
  name: "Opensteer",
  oauth: {
    accountCallback: opensteerDesktopAccountOAuthCallback,
    application: "desktop",
    clientId: opensteerDesktopOAuthClientId,
    hostCallback: opensteerDesktopHostOAuthCallback,
  },
};

const PackagedRunnerReleaseSchema = z.strictObject({
  architecture: z.enum(["amd64", "arm64"]),
  binarySha256: z.string().regex(/^[a-f0-9]{64}$/),
  operatingSystem: z.enum(["darwin", "linux", "win32"]),
  schemaVersion: z.literal(1),
});

function readPackagedPortableFsRelease(
  resourcesDirectory: string,
  requiredByRelease = true,
): NonNullable<DesktopLocalExecutionConfiguration["portableFsInstaller"]> | undefined {
  const directory = path.join(resourcesDirectory, "portablefs");
  const manifestPath = path.join(directory, "release.json");
  const installerPath = path.join(directory, "install.sh");
  const manifestExists = pathExists(manifestPath);
  const installerExists = pathExists(installerPath);
  if (!manifestExists && !installerExists && !requiredByRelease) return undefined;
  if (manifestExists !== installerExists || (!manifestExists && requiredByRelease)) {
    throw new Error("Packaged PortableFS release is incomplete.");
  }
  for (const candidate of [manifestPath, installerPath]) {
    const metadata = lstatSync(candidate);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Packaged PortableFS release files must be real regular files.");
    }
  }
  const manifest = PackagedPortableFsReleaseSchema.parse(
    JSON.parse(readFileSync(manifestPath, "utf8")),
  );
  const digest = createHash("sha256").update(readFileSync(installerPath)).digest("hex");
  if (digest !== manifest.installerSha256) {
    throw new Error("Packaged PortableFS installer does not match its signed release manifest.");
  }
  return { path: installerPath, version: manifest.version };
}

function readPackagedDesktopRelease(manifestPath: string): {
  readonly updates?: DesktopUpdates;
  readonly accountUrl: string | null;
  readonly localAgents: boolean;
  readonly portableFs: boolean;
  readonly portalUrl: string | undefined;
  readonly release: DesktopReleaseIdentity;
} {
  const manifest = readEmbeddedDesktopRelease(manifestPath);
  const accountUrl = manifest.accountUrl
    ? serviceOrigin(manifest.accountUrl, "production", "Opensteer Account URL")
    : null;
  return {
    ...(manifest.updates ? { updates: manifest.updates } : {}),
    accountUrl: accountUrl?.origin ?? null,
    localAgents: manifest.capabilities.localAgents,
    portableFs: manifest.capabilities.portableFs,
    portalUrl: manifest.portalUrl
      ? serviceOrigin(manifest.portalUrl, "production", "Opensteer portal URL").origin
      : undefined,
    release: {
      channel: manifest.application.channel,
      id: manifest.application.id,
      name: manifest.application.name,
      // The build states which application it is rather than deriving it from
      // a callback scheme: it is what every Host and Account surface fenced by
      // client reads, and a manifest field would be one more thing a repacked
      // build could disagree with its own registration about.
      oauth: { ...manifest.oauth, application: "desktop" },
    },
  };
}

export function readEmbeddedDesktopRelease(
  manifestPath: string,
): z.infer<typeof PackagedDesktopReleaseSchema> {
  const metadata = lstatSync(manifestPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Packaged Desktop release manifest must be a real regular file.");
  }
  return PackagedDesktopReleaseSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
}

function readPackagedNativeFsHelper(resourcesDirectory: string): string {
  const directory = path.join(resourcesDirectory, "runner");
  const manifestPath = path.join(directory, "release.json");
  const helperPath = path.join(
    directory,
    hostPlatform() === "win32" ? "opensteer-native-fs.exe" : "opensteer-native-fs",
  );
  for (const candidate of [manifestPath, helperPath]) {
    const metadata = lstatSync(candidate);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Packaged Runner release files must be real regular files.");
    }
  }
  const manifest = PackagedRunnerReleaseSchema.parse(
    JSON.parse(readFileSync(manifestPath, "utf8")),
  );
  const expectedOperatingSystem = hostPlatform();
  const expectedArchitecture = hostArchitecture() === "x64" ? "amd64" : hostArchitecture();
  if (
    manifest.operatingSystem !== expectedOperatingSystem ||
    manifest.architecture !== expectedArchitecture
  ) {
    throw new Error("Packaged Native filesystem helper does not match this computer.");
  }
  const digest = createHash("sha256").update(readFileSync(helperPath)).digest("hex");
  if (digest !== manifest.binarySha256) {
    throw new Error("Packaged Native filesystem helper does not match its release manifest.");
  }
  return helperPath;
}

function pathExists(filePath: string): boolean {
  try {
    lstatSync(filePath);
    return true;
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}

export function desktopDataDirectory(
  configured: string | undefined,
  appDataDirectory: string,
  mode: DesktopMode,
  releaseName = defaultDesktopReleaseIdentity.name,
): string {
  const appData = absolutePath(appDataDirectory, "Electron app-data directory");
  const explicit = optional(configured);
  if (explicit) return absolutePath(explicit, "OPENSTEER_DESKTOP_DATA_DIR");
  const name =
    mode === "production"
      ? durableDesktopPathName(releaseName)
      : mode === "development"
        ? durableDesktopPathName(desktopApplicationName(false, releaseName))
        : durableDesktopPathName("Opensteer Test");
  return path.join(appData, name);
}

/**
 * Mutable roots predate the display-name capitalization change. Keep their
 * original bytes so an update opens the same profile on case-sensitive disks
 * and durable manifests continue to name the same managed Workspace root.
 */
function durableDesktopPathName(displayName: string): string {
  return displayName.replace(/^Opensteer/u, `Open${"S"}teer`);
}

/** Source builds must never share Chromium or Keychain identity with a distributable app. */
export function desktopApplicationName(packaged: boolean, releaseName: string): string {
  // Electron derives its Safe Storage keychain service from this runtime name.
  // Preserve the established spelling until credentials have been explicitly
  // migrated; the bundle and every user-visible product surface use the new
  // display name independently.
  return durableDesktopPathName(packaged ? releaseName : "Opensteer Development");
}

function nativeCallbackIdentity(url: URL): string {
  return `${url.protocol}${url.host ? `//${url.host}` : ""}${url.pathname}`;
}

function desktopMode(value: string | undefined, fallback: DesktopMode): DesktopMode {
  const normalized = optional(value) ?? fallback;
  if (normalized !== "development" && normalized !== "production" && normalized !== "test") {
    throw new Error("OPENSTEER_DESKTOP_MODE must be development, production, or test.");
  }
  return normalized;
}

function hostPageUrl(value: string, mode: DesktopMode): URL {
  return serviceOrigin(value, mode, "desktop Host URL");
}

function serviceOrigin(value: string, mode: DesktopMode, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`${label} must be a valid absolute URL.`, {
      cause: error,
    });
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(
      `${label} must be an uncredentialed origin without a path, query, or fragment.`,
    );
  }
  const loopback = isLoopbackHostname(url.hostname);
  if (
    url.protocol !== "https:" &&
    !(mode !== "production" && url.protocol === "http:" && loopback)
  ) {
    throw new Error(`${label} must use HTTPS except for loopback development and tests.`);
  }
  url.pathname = "/";
  return url;
}

function absolutePath(value: string, label: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be an absolute path.`);
  return path.resolve(value);
}

function optional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function booleanValue(value: string | undefined, fallback: boolean, name: string): boolean {
  const normalized = optional(value);
  if (normalized === undefined) return fallback;
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${name} must be true or false.`);
}
