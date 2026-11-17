import { z } from "zod";
import { PluginAccountConsentSchema } from "@opensteer/core";
import {
  IntegrationAuthorizationAttemptIdSchema,
  IntegrationAuthorizationReturnPortSchema,
  IntegrationAuthorizationReturnProofSchema,
} from "@opensteer/integration-core";

const id = z.string().min(1);
export const PluginOAuthTargetSchema = z.strictObject({
  plugin: id,
  requirement: id,
  scope: z.enum(["app", "user"]),
});
export const PluginOAuthClientChoiceSchema = z.union([
  z.strictObject({ id }),
  z.strictObject({ automatic: z.literal(true) }),
  z.strictObject({ clientId: id, clientSecret: id.optional(), save: z.boolean().optional() }),
]);
export const PluginOAuthBeginSchema = z.strictObject({
  connection: id,
  consent: PluginAccountConsentSchema,
  method: id,
  review: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  client: PluginOAuthClientChoiceSchema.optional(),
  surface: z.enum(["web", "desktop", "native"]),
  finish: z.literal("app").optional(),
  appReturnPort: IntegrationAuthorizationReturnPortSchema.optional(),
  returnPath: z
    .string()
    .min(1)
    .max(2048)
    .refine((v) => v.startsWith("/") && !v.startsWith("//")),
});
export const PluginOAuthStatusSchema = z.object({
  attemptId: IntegrationAuthorizationAttemptIdSchema,
  connection: id,
  account: id.nullable(),
  expiresAt: z.iso.datetime(),
  status: z.enum(["pending", "launched", "completed", "denied", "failed", "cancelled", "expired"]),
  failureCode: z.string().nullable(),
});
export const PluginOAuthMethodsSchema = z.object({
  connection: id,
  consent: z.object(PluginAccountConsentSchema.shape),
  redirectUri: z.url(),
  methods: z.array(
    z.object({
      method: id,
      oneClick: z.boolean(),
      review: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
      setup: z.record(z.string(), z.json()),
    }),
  ),
});
export const PluginOAuthStartSchema = z.object({
  attemptId: IntegrationAuthorizationAttemptIdSchema,
  connection: id,
  expiresAt: z.iso.datetime(),
  launchTicket: id,
});
export const PluginOAuthAppSaveSchema = z.strictObject({
  issuer: z.url(),
  clientId: id,
  clientSecret: id.optional(),
});
export const pluginOAuthCommands = (idempotencyKey: z.ZodString) =>
  [
    z.strictObject({
      type: z.literal("plugin.authorization.prepare"),
      idempotencyKey,
      input: PluginOAuthTargetSchema,
    }),
    z.strictObject({
      type: z.literal("plugin.authorization.begin"),
      idempotencyKey,
      input: PluginOAuthBeginSchema,
    }),
    z.strictObject({
      type: z.literal("plugin.authorization.return"),
      idempotencyKey,
      attemptId: IntegrationAuthorizationAttemptIdSchema,
      returnProof: IntegrationAuthorizationReturnProofSchema,
    }),
    z.strictObject({
      type: z.literal("plugin.authorization.cancel"),
      idempotencyKey,
      attemptId: IntegrationAuthorizationAttemptIdSchema,
    }),
    z.strictObject({
      type: z.literal("plugin.oauthApp.save"),
      idempotencyKey,
      input: PluginOAuthAppSaveSchema,
    }),
    z.strictObject({ type: z.literal("plugin.oauthApp.remove"), idempotencyKey, client: id }),
  ] as const;
export const pluginOAuthOutputs = [
  PluginOAuthMethodsSchema.extend({ type: z.literal("plugin.authorization.prepare") }),
  PluginOAuthStartSchema.extend({ type: z.literal("plugin.authorization.begin") }),
  PluginOAuthStatusSchema.extend({ type: z.literal("plugin.authorization.return") }),
  PluginOAuthStatusSchema.extend({ type: z.literal("plugin.authorization.cancel") }),
  z.object({ type: z.literal("plugin.oauthApp.save"), client: z.record(z.string(), z.json()) }),
  z.object({ type: z.literal("plugin.oauthApp.remove") }),
] as const;
