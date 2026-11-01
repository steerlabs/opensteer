import { RuntimeModeSchema, type RuntimeMode } from "@opensteer/core";
import { validateRunnerTransport } from "@opensteer/runner-client";
import { requiredEnvironmentValue as required } from "@opensteer/shared/envParsing";
import { createPublicKey, type KeyObject } from "node:crypto";
import path from "node:path";
import { chromium } from "playwright-core";

export const browserRuntimeEnvironmentKeys = {
  bridgeToken: "OPENSTEER_BROWSER_BRIDGE_TOKEN",
  chromiumExecutable: "OPENSTEER_CHROMIUM_EXECUTABLE",
  chromiumSandbox: "OPENSTEER_CHROMIUM_SANDBOX",
  enrollmentToken: "OPENSTEER_RUNNER_ENROLLMENT_TOKEN",
  mode: "OPENSTEER_MODE",
  profileRoot: "OPENSTEER_BROWSER_PROFILE_ROOT",
  proxyUrl: "OPENSTEER_BROWSER_PROXY_URL",
  relayHostUrl: "OPENSTEER_BROWSER_RELAY_HOST_URL",
  runnerControlCaPath: "OPENSTEER_RUNNER_CONTROL_CA_PATH",
  runtimeDataDirectory: "OPENSTEER_BROWSER_RUNTIME_DATA_DIR",
  runtimeId: "OPENSTEER_BROWSER_RUNTIME_ID",
} as const;

export interface BrowserRuntimeConfig {
  /** Present when this process is itself a browser-only Runner. */
  relay:
    | {
        readonly bridgeToken: string;
        readonly controlCaPath: string | undefined;
        readonly dataDirectory: string;
        readonly enrollmentToken: string | undefined;
        readonly hostUrl: URL;
        readonly name: string;
        readonly mode: RuntimeMode;
      }
    | undefined;
  chromiumSandbox: boolean;
  deploymentMode: RuntimeMode;
  bridgeToken: string | undefined;
  executablePath: string;
  headless: boolean;
  host: string;
  maxProfileHosts: number;
  maxSessionsPerProfile: number;
  port: number;
  profileRoot: string;
  profileReadyTrustedHttpOrigin?: string;
  proxyUrl: string | undefined;
  publicKeys: ReadonlyMap<string, KeyObject>;
  runtimeId: string;
}

export function readBrowserRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): BrowserRuntimeConfig {
  const runtimeId = required(environment, browserRuntimeEnvironmentKeys.runtimeId);
  if (runtimeId.length > 255) throw new Error("OPENSTEER_BROWSER_RUNTIME_ID is too long.");
  const executablePath = absolutePath(
    optional(environment[browserRuntimeEnvironmentKeys.chromiumExecutable]) ??
      chromium.executablePath(),
    browserRuntimeEnvironmentKeys.chromiumExecutable,
  );
  const profileRoot = absolutePath(
    required(environment, browserRuntimeEnvironmentKeys.profileRoot),
    browserRuntimeEnvironmentKeys.profileRoot,
  );
  const bridgeToken = optional(environment[browserRuntimeEnvironmentKeys.bridgeToken]);
  if (bridgeToken && (bridgeToken.length < 32 || bridgeToken.length > 4_096)) {
    throw new Error("OPENSTEER_BROWSER_BRIDGE_TOKEN must contain 32 through 4096 characters.");
  }
  const publicKeys = parsePublicKeys(
    environment.OPENSTEER_BROWSER_ATTACH_PUBLIC_KEYS,
    Boolean(bridgeToken),
  );
  const deploymentMode = mode(environment[browserRuntimeEnvironmentKeys.mode]);
  // A browser runtime that enrolls is a Runner with one module: it reaches the
  // Host with a machine identity of its own and relays back into this same
  // process over the loopback bridge, so no Host ever needs a route to it.
  const relayHostUrl = optional(environment[browserRuntimeEnvironmentKeys.relayHostUrl]);
  const relay = relayHostUrl
    ? {
        bridgeToken:
          bridgeToken ??
          (() => {
            throw new Error(
              "OPENSTEER_BROWSER_RELAY_HOST_URL requires OPENSTEER_BROWSER_BRIDGE_TOKEN.",
            );
          })(),
        controlCaPath: optional(environment[browserRuntimeEnvironmentKeys.runnerControlCaPath]),
        dataDirectory: absolutePath(
          required(environment, browserRuntimeEnvironmentKeys.runtimeDataDirectory),
          browserRuntimeEnvironmentKeys.runtimeDataDirectory,
        ),
        enrollmentToken: optional(environment[browserRuntimeEnvironmentKeys.enrollmentToken]),
        hostUrl: relayOrigin(relayHostUrl),
        name: optional(environment.OPENSTEER_BROWSER_RUNTIME_NAME) ?? "Browser service",
        mode: deploymentMode,
      }
    : undefined;
  const chromiumSandbox = booleanValue(
    environment[browserRuntimeEnvironmentKeys.chromiumSandbox],
    false,
  );
  const proxyUrl = browserProxyUrl(environment[browserRuntimeEnvironmentKeys.proxyUrl]);
  const profileReadyTrustedHttpOrigin = trustedHttpOrigin(
    environment.OPENSTEER_BROWSER_PROFILE_READY_INTERNAL_URL,
  );
  const hosted = relay !== undefined;
  if (hosted && deploymentMode === "production" && !chromiumSandbox) {
    throw new Error("Production hosted Browser Runtime requires the Chromium sandbox.");
  }
  if (hosted && deploymentMode === "production" && !proxyUrl) {
    throw new Error("Production hosted Browser Runtime requires the public-network egress proxy.");
  }
  if (!hosted && bridgeToken && proxyUrl) {
    throw new Error("A bridge-only Browser Runtime cannot use the hosted egress proxy.");
  }
  if (relay) {
    validateRunnerTransport({
      ...(relay.controlCaPath ? { controlCaPath: relay.controlCaPath } : {}),
      hostOrigin: relay.hostUrl,
      mode: relay.mode,
    });
  }
  return {
    chromiumSandbox,
    deploymentMode,
    bridgeToken,
    relay,
    executablePath,
    headless: booleanValue(environment.OPENSTEER_BROWSER_HEADLESS, true),
    host: environment.OPENSTEER_BROWSER_HOST?.trim() || "127.0.0.1",
    maxProfileHosts: integerValue(
      environment.OPENSTEER_BROWSER_MAX_PROFILE_HOSTS,
      8,
      1,
      64,
      "OPENSTEER_BROWSER_MAX_PROFILE_HOSTS",
    ),
    maxSessionsPerProfile: integerValue(
      environment.OPENSTEER_BROWSER_MAX_SESSIONS_PER_PROFILE,
      32,
      1,
      128,
      "OPENSTEER_BROWSER_MAX_SESSIONS_PER_PROFILE",
    ),
    port: portValue(environment.OPENSTEER_BROWSER_PORT),
    profileRoot,
    ...(profileReadyTrustedHttpOrigin ? { profileReadyTrustedHttpOrigin } : {}),
    proxyUrl,
    publicKeys,
    runtimeId,
  };
}

function trustedHttpOrigin(value: string | undefined): string | undefined {
  const text = optional(value);
  if (!text) return undefined;
  const url = new URL(text);
  if (
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "OPENSTEER_BROWSER_PROFILE_READY_INTERNAL_URL must be an uncredentialed HTTP origin.",
    );
  }
  return url.origin;
}

function mode(value: string | undefined): BrowserRuntimeConfig["deploymentMode"] {
  return RuntimeModeSchema.parse(value?.trim() || "development");
}

function browserProxyUrl(value: string | undefined): string | undefined {
  const text = optional(value);
  if (!text) return undefined;
  const url = new URL(text);
  if (
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("OPENSTEER_BROWSER_PROXY_URL must be an uncredentialed HTTP origin.");
  }
  return url.origin;
}

function optional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

/** A relayed Runner reaches the Host at an origin, never at a path. */
function relayOrigin(value: string): URL {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search ||
    url.hash
  ) {
    throw new Error("OPENSTEER_BROWSER_RELAY_HOST_URL must be an HTTP origin without credentials.");
  }
  return url;
}

function absolutePath(value: string, name: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
  return path.resolve(value);
}

function booleanValue(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === "") return defaultValue;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("Boolean browser runtime configuration must be true or false.");
}

function portValue(value: string | undefined): number {
  if (value === undefined || value === "") return 4_312;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error("OPENSTEER_BROWSER_PORT must be an integer from 0 through 65535.");
  }
  return parsed;
}

function integerValue(
  value: string | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined || value === "") return defaultValue;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return parsed;
}

function parsePublicKeys(
  value: string | undefined,
  allowEmpty: boolean,
): ReadonlyMap<string, KeyObject> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value?.trim() || "{}");
  } catch (error) {
    throw new Error("OPENSTEER_BROWSER_ATTACH_PUBLIC_KEYS must be valid JSON.", { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OPENSTEER_BROWSER_ATTACH_PUBLIC_KEYS must be a JSON object.");
  }
  const entries = Object.entries(parsed);
  if ((!allowEmpty && entries.length < 1) || entries.length > 32) {
    throw new Error(
      "OPENSTEER_BROWSER_ATTACH_PUBLIC_KEYS must contain 1 through 32 keys unless a bridge is configured.",
    );
  }
  const keys = new Map<string, KeyObject>();
  for (const [keyId, publicKey] of entries) {
    if (!/^[A-Za-z0-9._:-]{1,255}$/.test(keyId) || typeof publicKey !== "string") {
      throw new Error("OPENSTEER_BROWSER_ATTACH_PUBLIC_KEYS contains an invalid key entry.");
    }
    if (Buffer.byteLength(publicKey, "utf8") > 16_384) {
      throw new Error("OPENSTEER_BROWSER_ATTACH_PUBLIC_KEYS contains an oversized key.");
    }
    let key: KeyObject;
    try {
      key = createPublicKey(publicKey);
    } catch (error) {
      throw new Error("OPENSTEER_BROWSER_ATTACH_PUBLIC_KEYS contains an invalid public key.", {
        cause: error,
      });
    }
    if (key.asymmetricKeyType !== "ed25519") {
      throw new Error("OPENSTEER_BROWSER_ATTACH_PUBLIC_KEYS must contain Ed25519 public keys.");
    }
    keys.set(keyId, key);
  }
  return keys;
}
