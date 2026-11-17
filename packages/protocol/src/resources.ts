import { utf8ByteLength } from "@opensteer/core";
import { z } from "zod";

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
