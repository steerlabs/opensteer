import { readFileSync } from "node:fs";
import {
  CloudComputerBootReleaseSchema,
  CloudComputerHostnameSchema,
  CloudComputerLocationSchema,
  CloudComputerPlanSchema,
  CloudComputerReleaseSchema,
} from "@opensteer/control-plane-protocol";
import { z } from "zod";

const prefix = "OPENSTEER_CLOUD_COMPUTER_";

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
    serverType: read("SERVER_TYPE", CloudComputerLocationSchema),
    release,
    stripeKey: read(
      "STRIPE_SECRET_KEY",
      z.string().regex(/^(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{8,}$/u),
    ),
    stripeWebhookSecret: read(
      "STRIPE_WEBHOOK_SECRET",
      z.string().regex(/^whsec_[A-Za-z0-9]{8,}$/u),
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
