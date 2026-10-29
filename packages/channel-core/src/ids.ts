import { z } from "zod";
import type { IntegrationConnectionId } from "@opensteer/integration-core/ids";

export {
  IntegrationConnectionIdSchema,
  type IntegrationConnectionId,
} from "@opensteer/integration-core/ids";

const channelIdPrefixes = {
  account: "cha",
  binding: "chb",
  connection: "con",
  conversation: "chv",
  delivery: "chd",
  identity: "chi",
  ingress: "chg",
  oauthState: "cho",
  principal: "pri",
  runtime: "chr",
} as const;

export type ChannelIdKind = keyof typeof channelIdPrefixes;
type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type ChannelAccountId = Brand<string, "ChannelAccountId">;
export type ChannelBindingId = Brand<string, "ChannelBindingId">;
export type ChannelConversationId = Brand<string, "ChannelConversationId">;
export type ChannelDeliveryId = Brand<string, "ChannelDeliveryId">;
export type ChannelIdentityId = Brand<string, "ChannelIdentityId">;
export type ChannelIngressId = Brand<string, "ChannelIngressId">;
export type ChannelOAuthStateId = Brand<string, "ChannelOAuthStateId">;
export type PrincipalId = Brand<string, "PrincipalId">;
export type ChannelRuntimeId = Brand<string, "ChannelRuntimeId">;

interface ChannelIdByKind {
  readonly account: ChannelAccountId;
  readonly binding: ChannelBindingId;
  readonly connection: IntegrationConnectionId;
  readonly conversation: ChannelConversationId;
  readonly delivery: ChannelDeliveryId;
  readonly identity: ChannelIdentityId;
  readonly ingress: ChannelIngressId;
  readonly oauthState: ChannelOAuthStateId;
  readonly principal: PrincipalId;
  readonly runtime: ChannelRuntimeId;
}

const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

function channelIdSchema<K extends ChannelIdKind>(kind: K): z.ZodType<ChannelIdByKind[K]> {
  return z
    .string()
    .regex(new RegExp(`^${channelIdPrefixes[kind]}_${uuidPattern}$`, "i"))
    .transform((value) => value as ChannelIdByKind[K]);
}

export function createChannelId<K extends ChannelIdKind>(kind: K): ChannelIdByKind[K] {
  return `${channelIdPrefixes[kind]}_${globalThis.crypto.randomUUID()}` as ChannelIdByKind[K];
}

export const ChannelAccountIdSchema = channelIdSchema("account");
export const ChannelBindingIdSchema = channelIdSchema("binding");
export const ChannelConversationIdSchema = channelIdSchema("conversation");
export const ChannelDeliveryIdSchema = channelIdSchema("delivery");
export const ChannelIngressIdSchema = channelIdSchema("ingress");
export const PrincipalIdSchema = channelIdSchema("principal");
export const ChannelRuntimeIdSchema = channelIdSchema("runtime");
