import { openSync, closeSync, fstatSync, readFileSync, constants } from "node:fs";
import { isBareOrigin, refused } from "@opensteer/core";
import { CloudComputerLocationSchema } from "@opensteer/control-plane-protocol";
import { z } from "zod";

const envSchema = z.object({
  OPENSTEER_ACCOUNT_URL: z.url({ protocol: /^https$/u }).refine(isBareOrigin),
  OPENSTEER_HOME_DEFAULT_REGION: CloudComputerLocationSchema,
  OPENSTEER_HOME_DEFAULT_SERVER_TYPE: CloudComputerLocationSchema,
  OPENSTEER_HOME_IMAGE: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,127}$/u),
  OPENSTEER_HOME_CLOUDFLARE_ZONE_ID: z.string().regex(/^[a-f0-9]{32}$/u),
  OPENSTEER_HOME_INTERVAL_MS: milliseconds(1_000, 300_000).default(10_000),
  OPENSTEER_HOME_REQUEST_TIMEOUT_MS: milliseconds(100, 60_000).default(15_000),
  OPENSTEER_HOME_ACTION_TIMEOUT_MS: milliseconds(1_000, 600_000).default(90_000),
  OPENSTEER_HOME_READINESS_TIMEOUT_MS: milliseconds(1_000, 3_600_000).default(600_000),
  OPENSTEER_HOME_PROVISIONER_REPLICAS: z.literal("1").default("1"),
  OPENSTEER_HOME_ORPHAN_GRACE_MS: milliseconds(60_000, 86_400_000).default(300_000),
  OPENSTEER_HOME_CONCURRENCY: milliseconds(1, 16).default(4),
});

function milliseconds(min: number, max: number) {
  return z.string().regex(/^\d+$/u).transform(Number).pipe(z.number().int().min(min).max(max));
}

export function loadConfig(env: NodeJS.ProcessEnv) {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const names = result.error.issues.map((issue) => issue.path.join("."));
    throw refused("bad_request", `Missing or invalid configuration: ${names.join(", ")}`);
  }
  const parsed = result.data;
  const imageId = z.coerce.number().int().positive().safeParse(parsed.OPENSTEER_HOME_IMAGE);
  return {
    accountOrigin: new URL(parsed.OPENSTEER_ACCOUNT_URL),
    hetznerToken: readSecret(env, "OPENSTEER_HOME_HETZNER_TOKEN"),
    cloudflareToken: readSecret(env, "OPENSTEER_HOME_CLOUDFLARE_TOKEN"),
    zoneId: parsed.OPENSTEER_HOME_CLOUDFLARE_ZONE_ID,
    region: parsed.OPENSTEER_HOME_DEFAULT_REGION,
    serverType: parsed.OPENSTEER_HOME_DEFAULT_SERVER_TYPE,
    image: imageId.success ? imageId.data : parsed.OPENSTEER_HOME_IMAGE,
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
