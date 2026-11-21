import { openSync, closeSync, fstatSync, readFileSync, constants } from "node:fs";
import { isBareOrigin, refused } from "@opensteer/core";
import { CloudComputerLocationSchema } from "@opensteer/control-plane-protocol";
import { z } from "zod";

const envSchema = z.object({
  OPENSTEER_ACCOUNT_URL: z.url({ protocol: /^https$/u }).refine(isBareOrigin),
  OPENSTEER_HOME_PROVIDER: z.enum(["hetzner", "google"]).default("hetzner"),
  OPENSTEER_HOME_CLOUDFLARE_ZONE_ID: z.string().regex(/^[a-f0-9]{32}$/u),
  OPENSTEER_HOME_INTERVAL_MS: integer(1_000, 300_000).default(10_000),
  OPENSTEER_HOME_REQUEST_TIMEOUT_MS: integer(100, 60_000).default(15_000),
  OPENSTEER_HOME_ACTION_TIMEOUT_MS: integer(1_000, 600_000).default(90_000),
  OPENSTEER_HOME_READINESS_TIMEOUT_MS: integer(1_000, 3_600_000).default(600_000),
  OPENSTEER_HOME_PROVISIONER_REPLICAS: z.literal("1").default("1"),
  OPENSTEER_HOME_ORPHAN_GRACE_MS: integer(60_000, 86_400_000).default(300_000),
  OPENSTEER_HOME_CONCURRENCY: integer(1, 16).default(4),
});

const hetznerSchema = z.object({
  OPENSTEER_HOME_DEFAULT_REGION: CloudComputerLocationSchema,
  OPENSTEER_HOME_DEFAULT_SERVER_TYPE: CloudComputerLocationSchema,
  OPENSTEER_HOME_IMAGE: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,127}$/u),
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
  if (env.OPENSTEER_HOME_PROVIDER === "google") {
    const google = readConfig(envSchema.extend(googleSchema.shape), env);
    return {
      ...sharedConfig(google, env),
      provider: "google" as const,
      project: google.OPENSTEER_HOME_GCP_PROJECT,
      zone: google.OPENSTEER_HOME_GCP_ZONE,
      network: google.OPENSTEER_HOME_GCP_NETWORK,
      subnet: google.OPENSTEER_HOME_GCP_SUBNET,
      diskType: google.OPENSTEER_HOME_GCP_DISK_TYPE,
      diskSizeGb: google.OPENSTEER_HOME_GCP_DISK_SIZE_GB,
      region: google.OPENSTEER_HOME_GCP_ZONE,
      serverType: google.OPENSTEER_HOME_GCP_MACHINE_TYPE,
      image: google.OPENSTEER_HOME_GCP_IMAGE,
    };
  }
  const hetzner = readConfig(envSchema.extend(hetznerSchema.shape), env);
  const imageId = z.coerce.number().int().positive().safeParse(hetzner.OPENSTEER_HOME_IMAGE);
  const hetznerToken = readSecret(env, "OPENSTEER_HOME_HETZNER_TOKEN");
  return {
    ...sharedConfig(hetzner, env),
    provider: "hetzner" as const,
    hetznerToken,
    region: hetzner.OPENSTEER_HOME_DEFAULT_REGION,
    serverType: hetzner.OPENSTEER_HOME_DEFAULT_SERVER_TYPE,
    image: imageId.success ? imageId.data : hetzner.OPENSTEER_HOME_IMAGE,
  };
}

function sharedConfig(parsed: z.infer<typeof envSchema>, env: NodeJS.ProcessEnv) {
  return {
    accountOrigin: new URL(parsed.OPENSTEER_ACCOUNT_URL),
    cloudflareToken: readSecret(env, "OPENSTEER_HOME_CLOUDFLARE_TOKEN"),
    zoneId: parsed.OPENSTEER_HOME_CLOUDFLARE_ZONE_ID,
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
