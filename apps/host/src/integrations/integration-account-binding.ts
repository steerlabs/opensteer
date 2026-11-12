import { ControlPlaneAccountIdSchema } from "@opensteer/control-plane-protocol";
import { OpensteerError, type UserId } from "@opensteer/core";
import { readIntegrationAccountBinding, type DatabaseSchema } from "@opensteer/database";
import type { Kysely } from "kysely";
import { z } from "zod";

export const IntegrationAccountBindingSchema = z.strictObject({
  issuer: z.url(),
  linkGeneration: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  subject: ControlPlaneAccountIdSchema,
});
export type IntegrationAccountBinding = z.infer<typeof IntegrationAccountBindingSchema>;

/** Invalid internal bindings are deployment faults, never invalid user input. */
export function validateIntegrationAccountBinding(
  value: unknown,
): IntegrationAccountBinding | null {
  if (value === null) return null;
  const parsed = IntegrationAccountBindingSchema.safeParse(value);
  if (!parsed.success) {
    throw new OpensteerError({
      code: "internal",
      message: "This deployment's Opensteer Account binding is invalid",
    });
  }
  return parsed.data;
}

/**
 * The return port to send the Account. It is a delivery hint, so an Account that
 * does not yet accept one gets none and Connect goes on through the app link.
 */
export function accountReturnPort(
  metadata: { readonly appReturnPort?: 1 | undefined } | null,
  finish: "app" | undefined,
  port: number | undefined,
): number | undefined {
  return finish === "app" && metadata?.appReturnPort === 1 ? port : undefined;
}

export async function resolveIntegrationAccountBinding(input: {
  readonly database: Kysely<DatabaseSchema>;
  readonly ownerUserId: UserId;
}): Promise<IntegrationAccountBinding | null> {
  return validateIntegrationAccountBinding(await readIntegrationAccountBinding(input));
}
