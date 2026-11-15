import { TabIdSchema, type TabId } from "./ids.js";
import { z } from "zod";
import { markdownLink } from "@opensteer/shared/markdownLinks";
import {
  ThreadIdSchema,
  RunIdSchema,
  RequestIdSchema,
  MessageIdSchema,
  TriggerIdSchema,
  RunnerIdSchema,
  AttachmentIdSchema,
} from "./ids.js";

const canonical = <T extends string>(schema: z.ZodType<T>) =>
  z
    .preprocess((value) => (typeof value === "string" ? value.toLowerCase() : value), schema)
    .refine((value) => !/\s/u.test(value));

export const ReferenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("task"), id: canonical(ThreadIdSchema) }),
  z.strictObject({ kind: z.literal("run"), id: canonical(RunIdSchema) }),
  z.strictObject({ kind: z.literal("request"), id: canonical(RequestIdSchema) }),
  z.strictObject({ kind: z.literal("message"), id: canonical(MessageIdSchema) }),
  z.strictObject({ kind: z.literal("automation"), id: canonical(TriggerIdSchema) }),
  z.strictObject({ kind: z.literal("computer"), id: canonical(RunnerIdSchema) }),
  z.strictObject({ kind: z.literal("attachment"), id: canonical(AttachmentIdSchema) }),
  z.strictObject({ kind: z.literal("tab"), id: TabIdSchema }),
]);
export const TabReferenceSchema = z.strictObject({ kind: z.literal("tab"), id: TabIdSchema });

export type Reference = z.infer<typeof ReferenceSchema>;
export type ReferenceKind = Reference["kind"];
export type ReferenceId = z.infer<typeof ReferenceIdSchema>;
export const ReferenceIdSchema = z.union([
  ...ReferenceSchema.options
    .filter((schema) => schema.shape.kind.value !== "tab")
    .map((schema) => schema.shape.id),
  TabIdSchema.refine((value) => /^(tab_|surface_)/u.test(value)),
]);

function referenceOf(id: string): z.infer<typeof ReferenceSchema> | null {
  for (const schema of ReferenceSchema.options) {
    if (schema.shape.kind.value === "tab") continue;
    const parsed = schema.safeParse({ kind: schema.shape.kind.value, id });
    if (parsed.success) return parsed.data;
  }
  return null;
}

export function referenceHref(id: ReferenceId): string {
  const parsed = ReferenceIdSchema.parse(id);
  return referenceOf(parsed) ? "opensteer:" + parsed : tabReferenceHref(TabIdSchema.parse(parsed));
}

export function parseReferenceHref(href: string): Reference | null {
  if (!/^opensteer:/iu.test(href)) return null;
  const value = href.slice("opensteer:".length);
  if (value.startsWith("tab/")) {
    try {
      const encoded = value.slice(4);
      const id = decodeURIComponent(encoded);
      if (encodeURIComponent(id) !== encoded) return null;
      const result = TabReferenceSchema.safeParse({ kind: "tab", id });
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }
  return referenceOf(value);
}

export function formatReferenceLink(id: ReferenceId, label: string): string {
  const reference = referenceOf(id);
  if (!reference) throw new Error("Invalid reference ID");
  return markdownLink(label.trim() || reference.kind, referenceHref(reference.id));
}

export function tabReferenceHref(tabId: TabId): string {
  return "opensteer:tab/" + encodeURIComponent(TabIdSchema.parse(tabId));
}
export function formatTabReferenceLink(tabId: TabId, label: string): string {
  return markdownLink(label.trim() || "tab", tabReferenceHref(tabId));
}
