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
]);
export type Reference = z.infer<typeof ReferenceSchema>;
export type ReferenceKind = Reference["kind"];
export type ReferenceId = Reference["id"];
export const ReferenceIdSchema = z.union(ReferenceSchema.options.map((schema) => schema.shape.id));

function referenceOf(id: string): Reference | null {
  for (const schema of ReferenceSchema.options) {
    const parsed = schema.safeParse({ kind: schema.shape.kind.value, id });
    if (parsed.success) return parsed.data;
  }
  return null;
}

export function referenceHref(id: ReferenceId): string {
  return "opensteer:" + ReferenceIdSchema.parse(id);
}

export function parseReferenceHref(href: string): Reference | null {
  if (!/^opensteer:/iu.test(href)) return null;
  return referenceOf(href.slice("opensteer:".length));
}

export function formatReferenceLink(id: ReferenceId, label: string): string {
  const reference = referenceOf(id);
  if (!reference) throw new Error("Invalid reference ID");
  return markdownLink(label.trim() || reference.kind, referenceHref(reference.id));
}
