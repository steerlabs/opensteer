import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { openSync, closeSync, fstatSync, readFileSync, constants } from "node:fs";
import { isBareOrigin, refused } from "@opensteer/core";
import {
  CloudComputerHostnameSchema,
  defaultBrowserPoolAdminPort,
} from "@opensteer/control-plane-protocol";
import { z } from "zod";

const envSchema = z.object({
  OPENSTEER_ACCOUNT_URL: z.url({ protocol: /^https$/u }).refine(isBareOrigin),
  OPENSTEER_HOME_CLOUDFLARE_ZONE_ID: z.string().regex(/^[a-f0-9]{32}$/u),
  // Account's OPENSTEER_CLOUD_COMPUTER_DOMAIN: the only names in the zone this provisioner touches.
  OPENSTEER_HOME_CLOUD_COMPUTER_DOMAIN: CloudComputerHostnameSchema.max(214),
  OPENSTEER_HOME_INTERVAL_MS: integer(1_000, 300_000).default(10_000),
  OPENSTEER_HOME_REQUEST_TIMEOUT_MS: integer(100, 60_000).default(15_000),
  OPENSTEER_HOME_ACTION_TIMEOUT_MS: integer(1_000, 600_000).default(90_000),
  OPENSTEER_HOME_READINESS_TIMEOUT_MS: integer(1_000, 3_600_000).default(600_000),
  OPENSTEER_HOME_PROVISIONER_REPLICAS: z.literal("1").default("1"),
  OPENSTEER_HOME_ORPHAN_GRACE_MS: integer(60_000, 86_400_000).default(300_000),
  OPENSTEER_HOME_CONCURRENCY: integer(1, 16).default(4),
});

const googleProject = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;
const googleName = z.string().regex(/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u);
const googleSchema = z.object({
  OPENSTEER_HOME_GCP_PROJECT: z.string().regex(googleProject),
  OPENSTEER_HOME_GCP_ZONE: z
    .string()
    .regex(/^[a-z]+(?:-[a-z]+)*[0-9]+-[a-z]$/u)
    .max(63),
  OPENSTEER_HOME_GCP_NETWORK: googleName,
  OPENSTEER_HOME_GCP_SUBNET: googleName,
  // 4 GiB: the Home's own VM, its browser being in the browser pool (deploy/home sizes from it).
  OPENSTEER_HOME_GCP_MACHINE_TYPE: googleName.default("e2-medium"),
  OPENSTEER_HOME_GCP_IMAGE: z
    .string()
    .regex(
      /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/global\/images\/(?:family\/)?[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u,
    )
    .default("projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64"),
  OPENSTEER_HOME_GCP_DISK_TYPE: z
    .enum(["pd-balanced", "pd-standard", "pd-ssd"])
    .default("pd-balanced"),
  OPENSTEER_HOME_GCP_DISK_SIZE_GB: integer(10, 65_536).default(30),
});

const ipv4Cidr = z.string().regex(/^(?:\d{1,3}\.){3}\d{1,3}\/(?:[0-9]|[12][0-9]|3[0-2])$/u);

const poolSchema = z.object({
  OPENSTEER_POOL_HOME_CIDR: ipv4Cidr,
  OPENSTEER_POOL_PROVISIONER_CIDR: ipv4Cidr,
  OPENSTEER_POOL_LOCAL_SSD_COUNT: integer(1, 24).default(1),
  OPENSTEER_POOL_BOOT_DISK_SIZE_GB: integer(20, 65_536).default(40),
  OPENSTEER_POOL_PROFILE_DISK_TYPE: z
    .enum(["pd-ssd", "pd-balanced", "pd-standard"])
    .default("pd-ssd"),
  OPENSTEER_POOL_ADMIN_PORT: integer(1, 65_535).default(defaultBrowserPoolAdminPort),
});

export interface PoolProvisionerConfig {
  readonly provisionerPrivateKey: KeyObject;
  readonly provisionerPublicKeySpki: string;
  readonly homeCidr: string;
  readonly provisionerCidr: string;
  readonly localSsdCount: number;
  readonly bootDiskSizeGb: number;
  readonly profileDiskType: "pd-ssd" | "pd-balanced" | "pd-standard";
  readonly adminPort: number;
}

function integer(min: number, max: number) {
  return z.string().regex(/^\d+$/u).transform(Number).pipe(z.number().int().min(min).max(max));
}

function readConfig<T>(schema: z.ZodType<T>, env: NodeJS.ProcessEnv) {
  const result = schema.safeParse(env);
  if (!result.success) {
    const names = result.error.issues.map((issue) => issue.path.join("."));
    throw refused("bad_request", `Missing or invalid configuration: ${names.join(", ")}`);
  }
  return result.data;
}

export function loadConfig(env: NodeJS.ProcessEnv) {
  const google = readConfig(envSchema.extend(googleSchema.shape), env);
  const pool = loadPoolConfig(env);
  return {
    ...sharedConfig(google, env),
    project: google.OPENSTEER_HOME_GCP_PROJECT,
    zone: google.OPENSTEER_HOME_GCP_ZONE,
    network: google.OPENSTEER_HOME_GCP_NETWORK,
    subnet: google.OPENSTEER_HOME_GCP_SUBNET,
    diskType: google.OPENSTEER_HOME_GCP_DISK_TYPE,
    diskSizeGb: google.OPENSTEER_HOME_GCP_DISK_SIZE_GB,
    region: google.OPENSTEER_HOME_GCP_ZONE,
    serverType: google.OPENSTEER_HOME_GCP_MACHINE_TYPE,
    image: google.OPENSTEER_HOME_GCP_IMAGE,
    pool,
  };
}

function sharedConfig(parsed: z.infer<typeof envSchema>, env: NodeJS.ProcessEnv) {
  return {
    accountOrigin: new URL(parsed.OPENSTEER_ACCOUNT_URL),
    cloudflareToken: readSecret(env, "OPENSTEER_HOME_CLOUDFLARE_TOKEN"),
    zoneId: parsed.OPENSTEER_HOME_CLOUDFLARE_ZONE_ID,
    domain: parsed.OPENSTEER_HOME_CLOUD_COMPUTER_DOMAIN,
    intervalMs: parsed.OPENSTEER_HOME_INTERVAL_MS,
    timeoutMs: parsed.OPENSTEER_HOME_REQUEST_TIMEOUT_MS,
    actionTimeoutMs: parsed.OPENSTEER_HOME_ACTION_TIMEOUT_MS,
    readinessTimeoutMs: parsed.OPENSTEER_HOME_READINESS_TIMEOUT_MS,
    concurrency: parsed.OPENSTEER_HOME_CONCURRENCY,
    orphanGraceMs: parsed.OPENSTEER_HOME_ORPHAN_GRACE_MS,
  };
}

function readSecret(env: NodeJS.ProcessEnv, name: string): string {
  const file = env[`${name}_FILE`];
  const value = env[name];
  if (file !== undefined && value !== undefined) {
    throw refused("bad_request", `Configure exactly one of ${name} or ${name}_FILE`);
  }
  let secret = value;
  if (file !== undefined) {
    try {
      const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > 4096) throw refused("bad_request", "Invalid secret file");
        secret = readFileSync(fd, "utf8");
      } finally {
        closeSync(fd);
      }
    } catch {
      throw refused("bad_request", `Could not read ${name}_FILE as a regular secret file`);
    }
  }
  if (!/^[A-Za-z0-9_-]{20,2048}$/u.test(secret?.trim() ?? "")) {
    throw refused("bad_request", `Missing or invalid ${name} or ${name}_FILE`);
  }
  return secret!.trim();
}

/** Every Cloud Computer's browser runs in the browser pool: this provisioner always serves it. */
function loadPoolConfig(env: NodeJS.ProcessEnv): PoolProvisionerConfig {
  const keyName = "OPENSTEER_POOL_PROVISIONER_KEY";
  if (env[keyName] === undefined && env[`${keyName}_FILE`] === undefined)
    throw refused(
      "bad_request",
      `Cloud Computers need the browser pool: set ${keyName} (or ${keyName}_FILE)`,
    );
  const parsed = readConfig(poolSchema, env);
  const rawKey = readKeySecret(env, keyName);
  const provisionerPrivateKey = parseEd25519PrivateKey(rawKey);
  const provisionerPublicKeySpki = createPublicKey(provisionerPrivateKey)
    .export({ format: "der", type: "spki" })
    .toString("base64");
  return {
    provisionerPrivateKey,
    provisionerPublicKeySpki,
    homeCidr: parsed.OPENSTEER_POOL_HOME_CIDR,
    provisionerCidr: parsed.OPENSTEER_POOL_PROVISIONER_CIDR,
    localSsdCount: parsed.OPENSTEER_POOL_LOCAL_SSD_COUNT,
    bootDiskSizeGb: parsed.OPENSTEER_POOL_BOOT_DISK_SIZE_GB,
    profileDiskType: parsed.OPENSTEER_POOL_PROFILE_DISK_TYPE,
    adminPort: parsed.OPENSTEER_POOL_ADMIN_PORT,
  };
}

function readKeySecret(env: NodeJS.ProcessEnv, name: string): string {
  const file = env[`${name}_FILE`];
  const value = env[name];
  if (file !== undefined && value !== undefined) {
    throw refused("bad_request", `Configure exactly one of ${name} or ${name}_FILE`);
  }
  let secret = value;
  if (file !== undefined) {
    try {
      const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > 4096) throw refused("bad_request", "Invalid secret file");
        secret = readFileSync(fd, "utf8");
      } finally {
        closeSync(fd);
      }
    } catch {
      throw refused("bad_request", `Could not read ${name}_FILE as a regular secret file`);
    }
  }
  const trimmed = secret?.trim() ?? "";
  if (!trimmed) throw refused("bad_request", `Missing or invalid ${name} or ${name}_FILE`);
  return trimmed;
}

function parseEd25519PrivateKey(raw: string): KeyObject {
  try {
    const key = raw.includes("-----BEGIN")
      ? createPrivateKey({ key: raw, format: "pem" })
      : createPrivateKey({ key: Buffer.from(raw, "base64"), format: "der", type: "pkcs8" });
    if (key.asymmetricKeyType !== "ed25519") {
      throw new Error("Expected Ed25519 private key");
    }
    return key;
  } catch {
    throw refused("bad_request", "Invalid OPENSTEER_POOL_PROVISIONER_KEY Ed25519 private key");
  }
}
