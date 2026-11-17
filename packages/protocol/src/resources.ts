import { utf8ByteLength } from "@opensteer/core";
import { z } from "zod";
import { HostBootstrapSchema } from "./bootstrap.js";

export const personalResourceKinds = [
  "settings",
  "identity",
  "owner-profile",
  "environment",
  "machine",
  "harness",
  "harness-catalog",
  "harness-auth",
  "agent-home-settings",
  "tab",
  "tab-layout",
  "browser-profile",
  "browser-placement",
  "browser-home",
  "browser-availability",
] as const;

export const PersonalRevisionSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/u)
  .refine((value) => value.length < 19 || value <= "9223372036854775807");
export const PersonalResourceKindSchema = z.enum(personalResourceKinds);
export const PersonalResourceRevisionsSchema = z.record(
  PersonalResourceKindSchema,
  PersonalRevisionSchema,
);
export const InstalledResourceRevisionsSchema = z.partialRecord(
  PersonalResourceKindSchema,
  PersonalRevisionSchema,
);
export const PersonalResourceInterestsSchema = z
  .array(PersonalResourceKindSchema)
  .max(personalResourceKinds.length)
  .refine((kinds) => new Set(kinds).size === kinds.length);

export const PersonalResourceSummarySchema = z.strictObject({
  id: z.string().min(1).max(255),
  label: z.string().max(256).optional(),
  status: z.string().max(80).optional(),
  capabilities: z.array(z.string().min(1).max(80)).max(16).optional(),
  detailId: z.string().min(1).max(255).optional(),
  observedAt: z.iso.datetime().optional(),
});
export const PersonalResourceViewSchema = z
  .strictObject({
    entries: z.array(PersonalResourceSummarySchema).max(32),
    complete: z.boolean(),
    hasMore: z.boolean(),
    selectedId: z.string().min(1).max(255).nullable().optional(),
  })
  .refine(
    (value) =>
      value.complete !== value.hasMore && utf8ByteLength(JSON.stringify(value)) <= 32 * 1024,
  );

export type PersonalResourceKind = z.infer<typeof PersonalResourceKindSchema>;
export type PersonalResourceRevisions = z.infer<typeof PersonalResourceRevisionsSchema>;
export type PersonalResourceView = z.infer<typeof PersonalResourceViewSchema>;

const bootstrap = HostBootstrapSchema.shape;
export const PersonalResourceDataSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("settings"),
    settings: bootstrap.personalSettings,
    quietTaskDays: bootstrap.quietTaskDays,
    executionPreferences: bootstrap.executionPreferences,
  }),
  z.strictObject({ kind: z.literal("identity"), identity: bootstrap.identityConfig }),
  z.strictObject({
    kind: z.literal("owner-profile"),
    ownerProfile: bootstrap.ownerProfile.unwrap().nullable(),
  }),
  z.strictObject({ kind: z.literal("environment"), environments: bootstrap.environments }),
  z.strictObject({ kind: z.literal("machine"), machines: bootstrap.machines }),
  z.strictObject({ kind: z.literal("harness"), harnesses: bootstrap.harnesses }),
  z.strictObject({ kind: z.literal("harness-catalog"), environments: bootstrap.environments }),
  z.strictObject({ kind: z.literal("harness-auth"), environments: bootstrap.environments }),
  z.strictObject({ kind: z.literal("agent-home-settings"), settings: bootstrap.personalSettings }),
  z.strictObject({ kind: z.enum(["tab", "tab-layout"]), tabs: bootstrap.tabs }),
  z.strictObject({
    kind: z.literal("browser-profile"),
    profiles: bootstrap.browser.shape.profiles,
    deletions: bootstrap.browser.shape.profileDeletions,
  }),
  z.strictObject({
    kind: z.literal("browser-placement"),
    placements: bootstrap.browser.shape.placements,
  }),
  z.strictObject({ kind: z.literal("browser-home"), homes: bootstrap.browser.shape.profileHomes }),
  z.strictObject({ kind: z.literal("browser-availability"), available: z.boolean() }),
]);

export const PersonalResourceDetailSchema = z
  .strictObject({
    revision: PersonalRevisionSchema,
    data: PersonalResourceDataSchema,
    next: z.string().max(4096).nullable(),
  })
  .refine((value) => utf8ByteLength(JSON.stringify(value)) <= 64 * 1024);
