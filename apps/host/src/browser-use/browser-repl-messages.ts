import { z } from "zod";

export const browserReplLimits = {
  handles: 16,
  pending: 32,
  timers: 128,
  events: 500,
  eventBytes: 512 * 1024,
} as const;

const tabId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/u);
const id = z.string().min(1).max(256);
const mimeType = z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export const browserImageSchema = z.object({ data: z.base64(), mimeType });
export const browserPageSchema = z.object({
  tabId,
  title: z.string(),
  url: z.string(),
  profile: z.string(),
});
export const browserTargetSchema = z.object({
  tabId,
  targetId: id,
  sessionId: id,
  dialog: z.object({ id, type: z.string(), message: z.string() }).nullish(),
});
const args = z.object({});
const noTarget = z.literal(null);
export const BrowserReplRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("browser.pages"), target: noTarget, args }),
  z.object({ operation: z.literal("browser.open"), target: noTarget, args: z.object({ tabId }) }),
  z.object({
    operation: z.literal("browser.new"),
    target: noTarget,
    args: z.object({ url: z.string(), profileId: id.optional() }),
  }),
  z.object({
    operation: z.literal("browser.command"),
    target: id,
    args: z.object({
      method: z.string().min(1).max(256),
      params: z.record(z.string(), z.json()).optional(),
      sessionId: id.optional(),
      screenshot: z.boolean().optional(),
    }),
  }),
  z.object({
    operation: z.literal("browser.url"),
    target: noTarget,
    args: z.object({ href: z.string() }),
  }),
  z.object({ operation: z.literal("browser.image"), target: noTarget, args: browserImageSchema }),
]);
export type BrowserReplRequest = z.infer<typeof BrowserReplRequestSchema>;
