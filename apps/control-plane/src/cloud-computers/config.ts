import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import {
  CloudComputerBootReleaseSchema,
  CloudComputerHostnameSchema,
  CloudComputerLocationSchema,
  CloudComputerPlanSchema,
  CloudComputerRegionSchema,
  CloudComputerReleaseSchema,
  CloudComputerReleaseManifestUrlSchema,
} from "@opensteer/control-plane-protocol";
import { z } from "zod";

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
      .pipe(CloudComputerBootReleaseSchema.merge(CloudComputerReleaseSchema)),
  );
  return {
    provisionerEmail: read(
      "PROVISIONER_EMAIL",
      z.email().refine((value) => value.endsWith(".iam.gserviceaccount.com")),
    ),
    domain: read("DOMAIN", CloudComputerHostnameSchema.max(214)),
    region: read("REGION", CloudComputerLocationSchema),
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

export function cloudComputerRegion(
  id: string,
  config: Pick<CloudComputerConfig, "region" | "regionLabel">,
) {
  const label =
    (id === config.region ? config.regionLabel : undefined) ?? hetznerLocationLabels.get(id);
  return label ? { id, label } : undefined;
}
