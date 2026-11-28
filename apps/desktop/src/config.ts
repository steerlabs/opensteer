import { PasskeysEnvironmentSchema } from "@opensteer/config/passkeys";
import type { NativeOAuthIdentity } from "@opensteer/client/auth";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { arch as hostArchitecture, homedir, platform as hostPlatform } from "node:os";
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
  /**
   * In a development launch only: the one public key (base64 SHA-256 of its SubjectPublicKeyInfo)
   * the session that talks to the account service accepts for the account host, for a stand-in
   * account service such as the first-run journey's (`electron-service-network.ts`). Null in a
   * released app, whatever its environment says.
   */
  readonly accountCertificateKey: string | null;
  readonly accountUrl: URL | null;
  readonly browser: DesktopBrowserRuntimeConfig | null;
  readonly dataDirectory: string;
  /**
   * Certificate authorities added for Node (`NODE_EXTRA_CA_CERTS`), handed to this Mac's Home and
   * to nothing else, in a development launch only (the first-run journey's account service is
   * one). A released app takes none from its environment. Null unless someone set it on purpose.
   */
  readonly extraCertificateAuthorities: string | null;
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
  /** A development launch kept to one folder of its own; null for every other launch. */
  readonly trial: DesktopTrial | null;
}

/**
 * `OPENSTEER_DESKTOP_TRIAL_ROOT`: a source build tried by hand beside an installed Opensteer on
 * the same Mac. Everything it keeps is under `root`; it uses nothing the installed app owns: not
 * its data folder or Agent home, not its callback scheme (`oauth-protocol-client.ts`), not the
 * helpers every Opensteer on a Mac shares with their macOS grants (`desktopNativeHelperPlatform`),
 * and not the Opensteer account. A released app never reads it.
 */
export interface DesktopTrial {
  readonly agentHome: string;
  readonly downloads: string;
  readonly root: string;
}

export interface DesktopReleaseIdentity {
  readonly id: string;
  readonly name: string;
  readonly oauth: NativeOAuthIdentity;
}

export interface DesktopLocalExecutionConfiguration {
  readonly dataDirectory: string;
  readonly nativeFsHelperBinary: string;
  readonly runnerWorkerPath: string;
}

export interface DesktopPersonalDeploymentConfiguration {
  readonly passkeys?: boolean;
  readonly releaseDirectory: string;
}

export interface LoadedDesktopConfiguration {
  readonly config: DesktopConfiguration;
  /** Values in the environment that the app does not use, each said once in its log. */
  readonly ignored: readonly { readonly name: string; readonly reason: string }[];
}

interface ReadDesktopConfigurationOptions {
  readonly appDataDirectory: string;
  readonly defaultMode: DesktopMode;
  readonly environment?: NodeJS.ProcessEnv;
  /** Where an installed Opensteer keeps its Agent home; the person's home folder by default. */
  readonly homeDirectory?: string;
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
  OPENSTEER_DESKTOP_PORTAL_URL: z.string().optional(),
  OPENSTEER_DESKTOP_RUNNER_WORKER: z.string().optional(),
  OPENSTEER_DESKTOP_TRIAL_ROOT: z.string().optional(),
  OPENSTEER_DESKTOP_PERSONAL_RELEASE_DIR: z.string().optional(),
  NODE_EXTRA_CA_CERTS: z.string().optional(),
  OPENSTEER_DESKTOP_ACCOUNT_CERTIFICATE_KEY: z.string().optional(),
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
  const trial = options.packaged
    ? null
    : desktopTrial(parsed, mode, {
        appDataDirectory: options.appDataDirectory,
        homeDirectory: options.homeDirectory ?? homedir(),
      });
  const dataDirectory = trial
    ? path.join(trial.root, "Data")
    : desktopDataDirectory(
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

  const packagedNativeFsHelper = options.packaged
    ? readPackagedNativeFsHelper(resourcesDirectory)
    : undefined;
  const localExecution: DesktopLocalExecutionConfiguration = {
    dataDirectory: path.join(dataDirectory, "runner"),
    nativeFsHelperBinary: absolutePath(
      optional(parsed.OPENSTEER_DESKTOP_NATIVE_FS_HELPER) ??
        packagedNativeFsHelper ??
        path.join(resourcesDirectory, "runner", "opensteer-native-fs"),
      "OPENSTEER_DESKTOP_NATIVE_FS_HELPER",
    ),
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
  if (options.packaged && optional(parsed.OPENSTEER_DESKTOP_PERSONAL_RELEASE_DIR)) {
    throw new Error("Packaged Personal runtime paths cannot be overridden.");
  }
  const personal: DesktopPersonalDeploymentConfiguration = {
    passkeys: PasskeysEnvironmentSchema.parse(environment).OPENSTEER_PASSKEYS,
    releaseDirectory: absolutePath(
      optional(parsed.OPENSTEER_DESKTOP_PERSONAL_RELEASE_DIR) ??
        path.join(resourcesDirectory, "personal-runtime"),
      "OPENSTEER_DESKTOP_PERSONAL_RELEASE_DIR",
    ),
  };

  // Node's own variable: one the app will not pass on is ignored, never a reason not to open. A
  // released app takes none: any process of the same person can set it (`launchctl setenv`), and
  // the Home would then trust that authority for every outbound call. As the launch policy refuses
  // SSLKEYLOGFILE, so this is not a trust input of a released app.
  const extraAuthoritiesValue = optional(parsed.NODE_EXTRA_CA_CERTS);
  const extraAuthoritiesIgnored = !extraAuthoritiesValue
    ? null
    : options.packaged
      ? "a released app takes no certificate authority from its environment"
      : path.isAbsolute(extraAuthoritiesValue)
        ? null
        : "not an absolute path, so not passed to this Mac's Home";
  const extraAuthorities =
    extraAuthoritiesValue && extraAuthoritiesIgnored === null ? extraAuthoritiesValue : null;
  const accountKeyValue = optional(parsed.OPENSTEER_DESKTOP_ACCOUNT_CERTIFICATE_KEY);
  if (accountKeyValue && !options.packaged && !/^[A-Za-z0-9+/]{43}=$/u.test(accountKeyValue))
    throw new Error(
      "OPENSTEER_DESKTOP_ACCOUNT_CERTIFICATE_KEY must be the base64 SHA-256 of a certificate's public key.",
    );
  const accountCertificateKey = accountKeyValue && !options.packaged ? accountKeyValue : null;
  const ignored = [
    ...(extraAuthoritiesIgnored === null
      ? []
      : [{ name: "NODE_EXTRA_CA_CERTS", reason: extraAuthoritiesIgnored }]),
    ...(accountKeyValue && options.packaged
      ? [
          {
            name: "OPENSTEER_DESKTOP_ACCOUNT_CERTIFICATE_KEY",
            reason: "a released app takes no certificate trust from its environment",
          },
        ]
      : []),
  ];
  return {
    ignored,
    config: {
      accountCertificateKey,
      accountUrl,
      browser,
      dataDirectory,
      extraCertificateAuthorities: extraAuthorities,
      hostUrl,
      localExecution,
      mode,
      personal,
      portalUrl,
      release,
      trial,
      ...(packagedDesktop?.updates ? { updates: packagedDesktop.updates } : {}),
    },
  };
}

function desktopTrial(
  parsed: z.infer<typeof EnvironmentSchema>,
  mode: DesktopMode,
  installed: { readonly appDataDirectory: string; readonly homeDirectory: string },
): DesktopTrial | null {
  const value = optional(parsed.OPENSTEER_DESKTOP_TRIAL_ROOT);
  if (!value) return null;
  const root = absolutePath(value, "OPENSTEER_DESKTOP_TRIAL_ROOT");
  if (mode !== "development") {
    throw new Error("OPENSTEER_DESKTOP_TRIAL_ROOT is for a development launch only.");
  }
  for (const name of [
    "OPENSTEER_DESKTOP_ACCOUNT_URL",
    "OPENSTEER_DESKTOP_ACCOUNT_CERTIFICATE_KEY",
    "OPENSTEER_DESKTOP_DATA_DIR",
    "OPENSTEER_DESKTOP_HOST_URL",
    "OPENSTEER_DESKTOP_PORTAL_URL",
  ] as const) {
    if (optional(parsed[name])) {
      throw new Error(
        `A trial keeps its data under OPENSTEER_DESKTOP_TRIAL_ROOT and the Opensteer account off, so it takes no ${name}.`,
      );
    }
  }
  const trial: DesktopTrial = {
    agentHome: path.join(root, "Agent home"),
    downloads: path.join(root, "Downloads"),
    root,
  };
  // Every folder an installed Opensteer keeps: its data (Beta's name too), its helpers' shared
  // install roots inside it, and its Agent home.
  const installedFolders = [
    path.join(installed.appDataDirectory, "Opensteer"),
    path.join(installed.appDataDirectory, "Opensteer Beta"),
    path.join(installed.homeDirectory, "Opensteer"),
  ].map(resolvedPath);
  for (const folder of [root, path.join(root, "Data"), trial.agentHome, trial.downloads]) {
    const resolved = resolvedPath(folder);
    const shared = installedFolders.find(
      (installedFolder) => within(resolved, installedFolder) || within(installedFolder, resolved),
    );
    if (shared) {
      throw new Error(
        `OPENSTEER_DESKTOP_TRIAL_ROOT must not be in, or hold, an installed Opensteer's folder (${folder} meets ${shared}).`,
      );
    }
  }
  return trial;
}

/**
 * The real path, through every link of the part that exists. On a Mac the volume ignores case, so
 * `~/opensteer` is `~/Opensteer`: paths compare in one case there.
 */
function resolvedPath(value: string): string {
  let existing = path.resolve(value);
  const rest: string[] = [];
  while (!existsSync(existing) && path.dirname(existing) !== existing) {
    rest.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  const resolved = path.join(realpathSync.native(existing), ...rest);
  return hostPlatform() === "darwin" ? resolved.toLowerCase() : resolved;
}

function within(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * The platform the native helpers are told they run on. A trial runs none of them: the computer
 * use helper, Opensteer Passwords and Opensteer Dictation each install, listen and keep their
 * macOS grants inside the installed Opensteer's folder, at paths their Swift code fixes
 * (`helper-paths.ts`), so a trial must meet them as a computer without them does.
 */
export function desktopNativeHelperPlatform(
  config: Pick<DesktopConfiguration, "trial">,
  platform: NodeJS.Platform = process.platform,
): NodeJS.Platform {
  return config.trial ? "linux" : platform;
}

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

const PackagedDesktopReleaseSchema = z
  .strictObject({
    accountUrl: z.url().optional(),
    application: z.strictObject({
      id: z.literal("com.opensteer.opensteer"),
      name: z.literal("Opensteer"),
    }),
    oauth: DesktopOAuthIdentitySchema,
    portalUrl: z.url().optional(),
    updates: DesktopUpdatesSchema.optional(),
    schemaVersion: z.literal(7),
  })
  // RFC 8252: a native client's redirect scheme must be a name it actually owns
  // with the operating system. Asserting it *is* the application id — rather
  // than merely that it is private-use — is what makes a squattable generic
  // scheme unrepresentable rather than merely discouraged.
  .refine((value) => new URL(value.oauth.accountCallback).protocol === `${value.application.id}:`, {
    message: "OAuth callbacks must use the build's own application id as their scheme",
    path: ["oauth"],
  });

const defaultDesktopReleaseIdentity: DesktopReleaseIdentity = {
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

function readPackagedDesktopRelease(manifestPath: string): {
  readonly updates?: DesktopUpdates;
  readonly accountUrl: string | null;
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
    portalUrl: manifest.portalUrl
      ? serviceOrigin(manifest.portalUrl, "production", "Opensteer portal URL").origin
      : undefined,
    release: {
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
      ? releaseName
      : mode === "development"
        ? desktopApplicationName(false, releaseName)
        : "Opensteer Test";
  return path.join(appData, name);
}

/**
 * Source builds must never share Chromium or Keychain identity with a distributable app, and a
 * trial not with an ordinary source run either, so what it keeps can be removed on its own.
 */
export function desktopApplicationName(
  packaged: boolean,
  releaseName: string,
  mode: DesktopMode = "development",
  trial = false,
): string {
  if (packaged) return releaseName;
  if (trial) return "Opensteer Trial";
  return mode === "test" ? "Opensteer Test" : "Opensteer Development";
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
