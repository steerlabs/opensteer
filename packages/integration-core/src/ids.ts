import { z } from "zod";

const prefixes = {
  connection: "con",
  grant: "igr",
  installation: "iin",
  mcpOauthAttempt: "imo",
  oauthAttempt: "ioa",
  providerApplication: "ipa",
  server: "isv",
  skill: "isk",
  tool: "itl",
} as const;

export type IntegrationIdKind = keyof typeof prefixes;
type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type IntegrationConnectionId = Brand<string, "IntegrationConnectionId">;
export type IntegrationGrantId = Brand<string, "IntegrationGrantId">;
export type IntegrationInstallationId = Brand<string, "IntegrationInstallationId">;
export type McpOAuthAttemptId = Brand<string, "McpOAuthAttemptId">;
export type IntegrationOAuthAttemptId = Brand<string, "IntegrationOAuthAttemptId">;
export type IntegrationProviderApplicationId = Brand<string, "IntegrationProviderApplicationId">;
export type IntegrationServerId = Brand<string, "IntegrationServerId">;
export type IntegrationSkillId = Brand<string, "IntegrationSkillId">;
export type IntegrationToolId = Brand<string, "IntegrationToolId">;

interface IdByKind {
  readonly connection: IntegrationConnectionId;
  readonly grant: IntegrationGrantId;
  readonly installation: IntegrationInstallationId;
  readonly mcpOauthAttempt: McpOAuthAttemptId;
  readonly oauthAttempt: IntegrationOAuthAttemptId;
  readonly providerApplication: IntegrationProviderApplicationId;
  readonly server: IntegrationServerId;
  readonly skill: IntegrationSkillId;
  readonly tool: IntegrationToolId;
}

const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

function schema<K extends IntegrationIdKind>(kind: K): z.ZodType<IdByKind[K]> {
  return z
    .string()
    .regex(new RegExp(`^${prefixes[kind]}_${uuidPattern}$`, "i"))
    .transform((value) => value as IdByKind[K]);
}

export function createIntegrationId<K extends IntegrationIdKind>(kind: K): IdByKind[K] {
  return `${prefixes[kind]}_${globalThis.crypto.randomUUID()}` as IdByKind[K];
}

export const IntegrationConnectionIdSchema = schema("connection");
export const IntegrationGrantIdSchema = schema("grant");
export const IntegrationInstallationIdSchema = schema("installation");
export const McpOAuthAttemptIdSchema = schema("mcpOauthAttempt");
export const IntegrationOAuthAttemptIdSchema = schema("oauthAttempt");
export const IntegrationProviderApplicationIdSchema = schema("providerApplication");
export const IntegrationServerIdSchema = schema("server");
export const IntegrationSkillIdSchema = schema("skill");
export const IntegrationToolIdSchema = schema("tool");
