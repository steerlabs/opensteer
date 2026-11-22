import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import {
  BrowserPoolHostReleaseSchema,
  CloudComputerBootReleaseSchema,
  CloudComputerHostnameSchema,
  CloudComputerLocationSchema,
  CloudComputerPlanSchema,
  CloudComputerRegionSchema,
  CloudComputerReleaseSchema,
  CloudComputerReleaseManifestUrlSchema,
  defaultBrowserPoolAdminPort,
  defaultBrowserPoolAgentPort,
  defaultBrowserPoolRelayPort,
} from "@opensteer/control-plane-protocol";
import { z } from "zod";

/** Reserve 10% of the durable ext4 profile disk for root blocks, journal, and inode tables. */
export const browserPoolProfileDiskOverheadRatio = 0.1;

const prefix = "OPENSTEER_CLOUD_COMPUTER_";

/** Resolve settings staged by the Account deployment's optional runtime secret mount. */
export function withManagedHomeConfigFiles(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const directory = env.OPENSTEER_MANAGED_HOME_CONFIG_DIRECTORY;
  if (directory === undefined) return env;
  const result = { ...env };
  for (const file of readdirSync(directory, { withFileTypes: true })) {
    if (
      !file.isFile() ||
      !/^OPENSTEER_(?:CLOUD_COMPUTER|ORGANIZATION)_[A-Z0-9_]+$/u.test(file.name) ||
      file.name.endsWith("_FILE")
    )
      continue;
    const variable = `${file.name}_FILE`;
    if (env[file.name] === undefined && env[variable] === undefined)
      result[variable] = join(directory, file.name);
  }
  return result;
}

export function loadCloudComputerConfig(env: NodeJS.ProcessEnv) {
  if (!Object.keys(env).some((key) => key.startsWith(prefix) && env[key] !== undefined)) return;
  function read<T>(key: string, schema: z.ZodType<T>): T {
    const name = prefix + key;
    const file = env[`${name}_FILE`];
    let value = env[name];
    if (file !== undefined && value !== undefined)
      throw new Error(`Configure one of ${name} and ${name}_FILE`);
    try {
      if (file !== undefined) value = readFileSync(file, "utf8").trimEnd();
    } catch {
      throw new Error(`Could not read ${name}_FILE`);
    }
    const result = schema.safeParse(value);
    if (!result.success) throw new Error(`Missing or invalid ${name}`);
    return result.data;
  }

  const release = read(
    "RELEASE_JSON",
    z
      .string()
      .transform((text, ctx) => {
        try {
          return JSON.parse(text) as unknown;
        } catch {
          ctx.addIssue({ code: "custom", message: "Invalid release JSON" });
          return z.NEVER;
        }
      })
      .pipe(CloudComputerReleaseSchema.merge(CloudComputerBootReleaseSchema)),
  );
  const has = (key: string) =>
    env[`${prefix}${key}`] !== undefined || env[`${prefix}${key}_FILE`] !== undefined;
  const integer = (min: number, max: number) =>
    z.string().regex(/^\d+$/u).transform(Number).pipe(z.number().int().min(min).max(max));
  const region = read("REGION", CloudComputerLocationSchema);
  const browserPool = has("POOL_SLOTS_PER_HOST")
    ? (() => {
        const slotsPerHost = read("POOL_SLOTS_PER_HOST", integer(1, 16_384));
        const profileMib = has("POOL_PROFILE_MIB")
          ? read("POOL_PROFILE_MIB", integer(64, 1_048_576))
          : 2048;
        const profileDiskSizeGb = has("POOL_PROFILE_DISK_SIZE_GB")
          ? read("POOL_PROFILE_DISK_SIZE_GB", integer(10, 65_536))
          : 500;
        const usableProfileDiskMib = Math.floor(
          profileDiskSizeGb * 1024 * (1 - browserPoolProfileDiskOverheadRatio),
        );
        if (slotsPerHost * profileMib > usableProfileDiskMib) {
          throw new Error(
            `Browser pool slots (${slotsPerHost} * ${profileMib} MiB) exceed usable profile disk ` +
              `capacity (${usableProfileDiskMib} MiB of ${profileDiskSizeGb} GiB with 10% filesystem overhead reserved)`,
          );
        }
        return {
          slotsPerHost,
          release: read(
            "POOL_RELEASE_JSON",
            z
              .string()
              .transform((text, ctx) => {
                try {
                  return JSON.parse(text) as unknown;
                } catch {
                  ctx.addIssue({ code: "custom", message: "Invalid pool release JSON" });
                  return z.NEVER;
                }
              })
              .pipe(BrowserPoolHostReleaseSchema),
          ),
          machineType: has("POOL_MACHINE_TYPE")
            ? read("POOL_MACHINE_TYPE", CloudComputerLocationSchema)
            : "n2-standard-8",
          region: has("POOL_REGION") ? read("POOL_REGION", CloudComputerLocationSchema) : region,
          guestVcpus: has("POOL_GUEST_VCPUS") ? read("POOL_GUEST_VCPUS", integer(1, 32)) : 2,
          guestMemoryMib: has("POOL_GUEST_MEMORY_MIB")
            ? read("POOL_GUEST_MEMORY_MIB", integer(256, 65_536))
            : 2048,
          profileMib,
          profileDiskSizeGb,
          agentPort: has("POOL_AGENT_PORT")
            ? read("POOL_AGENT_PORT", integer(1, 65_535))
            : defaultBrowserPoolAgentPort,
          adminPort: has("POOL_ADMIN_PORT")
            ? read("POOL_ADMIN_PORT", integer(1, 65_535))
            : defaultBrowserPoolAdminPort,
          relayPort: has("POOL_RELAY_PORT")
            ? read("POOL_RELAY_PORT", integer(1, 65_535))
            : defaultBrowserPoolRelayPort,
        };
      })()
    : undefined;
  return {
    provisionerEmail: read(
      "PROVISIONER_EMAIL",
      z.email().refine((value) => value.endsWith(".iam.gserviceaccount.com")),
    ),
    domain: read("DOMAIN", CloudComputerHostnameSchema.max(214)),
    region,
    ...(browserPool ? { browserPool } : {}),
    ...(env[`${prefix}REGION_LABEL`] !== undefined ||
    env[`${prefix}REGION_LABEL_FILE`] !== undefined
      ? { regionLabel: read("REGION_LABEL", CloudComputerRegionSchema.shape.label) }
      : {}),
    serverType: read("SERVER_TYPE", CloudComputerLocationSchema),
    release,
    ...(env[`${prefix}RELEASE_MANIFEST_URL`] !== undefined ||
    env[`${prefix}RELEASE_MANIFEST_URL_FILE`] !== undefined
      ? { releaseManifestUrl: read("RELEASE_MANIFEST_URL", CloudComputerReleaseManifestUrlSchema) }
      : {}),
    ...(env[`${prefix}BACKUP_KEY_PROJECT`] !== undefined ||
    env[`${prefix}BACKUP_KEY_PROJECT_FILE`] !== undefined
      ? {
          backupKeyProject: read(
            "BACKUP_KEY_PROJECT",
            z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u),
          ),
        }
      : {}),
    stripeKey: read(
      "STRIPE_SECRET_KEY",
      z.string().regex(/^(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{8,}$/u),
    ),
    stripeWebhookSecret: read(
      "STRIPE_WEBHOOK_SECRET",
      z.string().regex(/^whsec_[A-Za-z0-9]{8,}$/u),
    ),
    stripePortalConfigurationId: read(
      "STRIPE_PORTAL_CONFIGURATION_ID",
      z.string().regex(/^bpc_[A-Za-z0-9_]{1,128}$/u),
    ),
    stripePriceId: read("STRIPE_PRICE_ID", z.string().regex(/^price_[A-Za-z0-9]{1,128}$/u)),
    plan: {
      name: read("PLAN_NAME", CloudComputerPlanSchema.shape.name),
      currency: read("CURRENCY", CloudComputerPlanSchema.shape.currency),
      amountMinor: read(
        "PRICE_MINOR",
        z
          .string()
          .regex(/^\d+$/u)
          .transform(Number)
          .pipe(CloudComputerPlanSchema.shape.amountMinor),
      ),
    },
    ipv6Enabled:
      env[`${prefix}IPV6`] === undefined && env[`${prefix}IPV6_FILE`] === undefined
        ? false
        : read("IPV6", z.enum(["off", "on"])) === "on",
    interval:
      env[`${prefix}PRICE_INTERVAL`] === undefined &&
      env[`${prefix}PRICE_INTERVAL_FILE`] === undefined
        ? ("month" as const)
        : read("PRICE_INTERVAL", z.enum(["day", "week", "month", "year"])),
  };
}

export type CloudComputerConfig = NonNullable<ReturnType<typeof loadCloudComputerConfig>>;

const hetznerLocationLabels = new Map([
  ["ash", "Ashburn, VA"],
  ["hil", "Hillsboro, OR"],
  ["fsn1", "Falkenstein"],
  ["nbg1", "Nuremberg"],
  ["hel1", "Helsinki"],
  ["sin", "Singapore"],
]);

const googleRegionLabels = new Map([
  ["us-central1", "Council Bluffs, IA"],
  ["us-east1", "Moncks Corner, SC"],
  ["us-east4", "Ashburn, VA"],
  ["us-west1", "The Dalles, OR"],
  ["us-west2", "Los Angeles, CA"],
  ["northamerica-northeast1", "Montréal"],
  ["europe-west1", "St. Ghislain"],
  ["europe-west2", "London"],
  ["europe-west3", "Frankfurt"],
  ["europe-west4", "Eemshaven"],
  ["asia-east1", "Taiwan"],
  ["asia-northeast1", "Tokyo"],
  ["asia-southeast1", "Singapore"],
  ["australia-southeast1", "Sydney"],
]);

export function cloudComputerRegion(
  id: string,
  config: Pick<CloudComputerConfig, "region" | "regionLabel">,
) {
  const label =
    (id === config.region ? config.regionLabel : undefined) ??
    hetznerLocationLabels.get(id) ??
    googleRegionLabels.get(id.replace(/-[a-z]$/u, ""));
  return label ? { id, label } : undefined;
}
