import { isLoopbackHostname, RuntimeModeSchema, type RuntimeMode } from "@opensteer/core";
import { browserMemoryBudgetBytes } from "@opensteer/browser-runtime-core";
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
  poolControllerKey: "OPENSTEER_BROWSER_POOL_CONTROLLER_KEY",
  poolFloor: "OPENSTEER_BROWSER_POOL_FLOOR",
  poolProxy: "OPENSTEER_BROWSER_POOL_PROXY",
  poolSlot: "OPENSTEER_BROWSER_POOL_SLOT",
  poolTicketKey: "OPENSTEER_BROWSER_POOL_TICKET_KEY",
  profileRoot: "OPENSTEER_BROWSER_PROFILE_ROOT",
  proxyUrl: "OPENSTEER_BROWSER_PROXY_URL",
  relayHostUrl: "OPENSTEER_BROWSER_RELAY_HOST_URL",
  runnerControlCaPath: "OPENSTEER_RUNNER_CONTROL_CA_PATH",
  runtimeDataDirectory: "OPENSTEER_BROWSER_RUNTIME_DATA_DIR",
  runtimeId: "OPENSTEER_BROWSER_RUNTIME_ID",
} as const;

/**
 * A runtime in a pool guest (pool-runtime-in-guest.md, decisions 2 and 7): its identity comes
 * from the guest's boot, outside the guest, and never from its first caller.
 */
export interface BrowserRuntimePoolConfig {
  readonly slot: string;
  /** The slot's control key: every pool control must be signed by it. */
  readonly controllerKey: KeyObject;
  /** No control at or below this (term, sequence) applies. */
  readonly floor: { readonly term: number; readonly sequence: number };
  /** The one key whose attach tickets this runtime accepts: its Home's. */
  readonly ticketKey: { readonly keyId: string; readonly key: KeyObject };
}

export interface BrowserRuntimeConfig {
  memoryBudgetBytes?: number | undefined;
  /** Present only in a pool guest. */
  pool?: BrowserRuntimePoolConfig | undefined;
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
  port: number;
  profileRoot: string;
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
    // A pooled runtime's one ticket key comes from its boot; its own checks follow.
    Boolean(bridgeToken) || poolKeys.some((key) => optional(environment[key]) !== undefined),
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
  const hosted = relay !== undefined;
  if (hosted && deploymentMode === "production" && !chromiumSandbox) {
    throw new Error("Production hosted Browser Runtime requires the Chromium sandbox.");
  }
  if (hosted && deploymentMode === "production" && !proxyUrl) {
    throw new Error("Production hosted Browser Runtime requires the public-network egress proxy.");
  }
  if (!hosted && bridgeToken) {
    if (deploymentMode === "production" && !chromiumSandbox) {
      throw new Error("Production bridge-only Browser Runtime requires the Chromium sandbox.");
    }
  }
  const pool = poolConfig(environment);
  if (pool) {
    // A pool guest is a bridge-only runtime of one slot, sandboxed, behind its slot's proxy.
    if (relay)
      throw new Error("A pooled Browser Runtime is reached by its relay, never itself one.");
    if (!bridgeToken) throw new Error("A pooled Browser Runtime requires its bridge token.");
    if (!chromiumSandbox)
      throw new Error("A pooled Browser Runtime requires the Chromium sandbox.");
    if (optional(environment.OPENSTEER_BROWSER_ATTACH_PUBLIC_KEYS))
      throw new Error("A pooled Browser Runtime trusts only its boot's ticket key.");
    const slotProxy = poolProxy(environment[browserRuntimeEnvironmentKeys.poolProxy]);
    if (proxyUrl !== slotProxy)
      throw new Error("A pooled Browser Runtime accepts only its slot's egress proxy.");
  } else if (optional(environment[browserRuntimeEnvironmentKeys.poolProxy])) {
    throw new Error("OPENSTEER_BROWSER_POOL_PROXY is only for a pooled Browser Runtime.");
  }
  if (!pool && !hosted && bridgeToken) {
    if (proxyUrl && !isLoopbackHostname(new URL(proxyUrl).hostname)) {
      throw new Error("A bridge-only Browser Runtime requires a loopback egress proxy origin.");
    }
  }
  if (relay) {
    validateRunnerTransport({
      ...(relay.controlCaPath ? { controlCaPath: relay.controlCaPath } : {}),
      hostOrigin: relay.hostUrl,
      mode: relay.mode,
    });
  }
  return {
    memoryBudgetBytes: browserMemoryBudgetBytes(environment.OPENSTEER_BROWSER_MEMORY_BUDGET_MB),
    ...(pool ? { pool } : {}),
    chromiumSandbox,
    deploymentMode,
    bridgeToken,
    relay,
    executablePath,
    headless: booleanValue(environment.OPENSTEER_BROWSER_HEADLESS, true),
    host: environment.OPENSTEER_BROWSER_HOST?.trim() || "127.0.0.1",
    port: portValue(environment.OPENSTEER_BROWSER_PORT),
    profileRoot,
    proxyUrl,
    publicKeys: pool ? new Map([[pool.ticketKey.keyId, pool.ticketKey.key]]) : publicKeys,
    runtimeId,
  };
}

const poolKeys = [
  browserRuntimeEnvironmentKeys.poolSlot,
  browserRuntimeEnvironmentKeys.poolControllerKey,
  browserRuntimeEnvironmentKeys.poolFloor,
  browserRuntimeEnvironmentKeys.poolTicketKey,
] as const;

/** All four boot values, or none: a partial pool identity is refused. */
function poolConfig(environment: NodeJS.ProcessEnv): BrowserRuntimePoolConfig | undefined {
  const values = poolKeys.map((key) => optional(environment[key]));
  if (values.every((value) => value === undefined)) return undefined;
  const missing = poolKeys.filter((_, index) => values[index] === undefined);
  if (missing.length) throw new Error(`A pooled Browser Runtime requires ${missing.join(", ")}.`);
  const [slot, controllerKey, floor, ticketKey] = values as [string, string, string, string];
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(slot))
    throw new Error("OPENSTEER_BROWSER_POOL_SLOT is invalid.");
  const floorMatch = /^([1-9][0-9]{0,15})\.(0|[1-9][0-9]{0,15})$/u.exec(floor);
  if (!floorMatch) throw new Error("OPENSTEER_BROWSER_POOL_FLOOR must be <term>.<sequence>.");
  const ticket = /^([A-Za-z0-9._:-]{1,255}):([A-Za-z0-9+/=]{1,512})$/u.exec(ticketKey);
  if (!ticket) throw new Error("OPENSTEER_BROWSER_POOL_TICKET_KEY must be <keyId>:<SPKI base64>.");
  return {
    slot,
    controllerKey: spkiKey(controllerKey, browserRuntimeEnvironmentKeys.poolControllerKey),
    floor: { term: Number(floorMatch[1]), sequence: Number(floorMatch[2]) },
    ticketKey: {
      keyId: ticket[1]!,
      key: spkiKey(ticket[2]!, browserRuntimeEnvironmentKeys.poolTicketKey),
    },
  };
}

function spkiKey(value: string, name: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey({ key: Buffer.from(value, "base64"), format: "der", type: "spki" });
  } catch (error) {
    throw new Error(`${name} is not a public key.`, { cause: error });
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`${name} must be an Ed25519 key.`);
  return key;
}

/** The slot's proxy, as the agent booted the guest with it: an address and a port. */
function poolProxy(value: string | undefined): string {
  const text = optional(value);
  const match = text && /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/u.exec(text);
  if (!match) throw new Error("A pooled Browser Runtime requires OPENSTEER_BROWSER_POOL_PROXY.");
  return new URL(`http://${match[1]}:${match[2]}`).origin;
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
