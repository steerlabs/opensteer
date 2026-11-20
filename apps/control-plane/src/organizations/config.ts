import { readFileSync } from "node:fs";
import { z } from "zod";

export function loadOrganizationOffer(env: NodeJS.ProcessEnv) {
  if (
    !Object.keys(env).some(
      (key) => key.startsWith("OPENSTEER_ORGANIZATION_") && env[key] !== undefined,
    )
  )
    return;
  function read<T>(key: string, schema: z.ZodType<T>): T {
    const name = `OPENSTEER_ORGANIZATION_${key}`;
    const file = env[`${name}_FILE`];
    let value = env[name];
    if (file !== undefined && value !== undefined)
      throw new Error(`Configure one of ${name} and ${name}_FILE`);
    try {
      if (file !== undefined) value = readFileSync(file, "utf8").trim();
    } catch {
      throw new Error(`Could not read ${name}_FILE`);
    }
    const result = schema.safeParse(value);
    if (!result.success) throw new Error(`Missing or invalid ${name}`);
    return result.data;
  }
  return {
    portalConfigurationId: read(
      "STRIPE_PORTAL_CONFIGURATION_ID",
      z.string().regex(/^bpc_[A-Za-z0-9_]{1,128}$/u),
    ),
    priceId: read("STRIPE_PRICE_ID", z.string().regex(/^price_[A-Za-z0-9]{1,128}$/u)),
    name: "Opensteer work seat",
    currency: read("CURRENCY", z.string().regex(/^[a-z]{3}$/u)),
    amountMinor: read(
      "PRICE_MINOR",
      z.string().regex(/^\d+$/u).transform(Number).pipe(z.number().int().positive()),
    ),
    interval: read("PRICE_INTERVAL", z.enum(["day", "week", "month", "year"]).default("month")),
  };
}

export type OrganizationOffer = NonNullable<ReturnType<typeof loadOrganizationOffer>>;
