import { z } from "zod";

export const browserReplLimits = {
  handles: 16,
  pending: 32,
  totalPending: 128,
  bindingPending: 64,
  requests: 1_024,
  requestBytes: 4 * 1024 * 1024,
  depth: 32,
  jsonEntries: 16_384,
  timers: 128,
  events: 500,
  eventBytes: 512 * 1024,
} as const;

const tabId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/u);
const id = z.string().min(1).max(256);
const mimeType = z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export const browserImageSchema = z.object({
  data: z
    .string()
    .refine(
      (value) => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/u.test(value),
      "Invalid base64 image.",
    ),
  mimeType,
});
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

export function browserJsonShapeFits(
  json: string,
  maxDepth: number = browserReplLimits.depth,
): boolean {
  let depth = 0;
  let entries = 0;
  let quoted = false;
  for (let i = 0; i < json.length; i++) {
    const character = json.charCodeAt(i);
    if (quoted) {
      if (character === 92) i++;
      else if (character === 34) quoted = false;
    } else if (character === 34) quoted = true;
    else if (character === 91 || character === 123) {
      if (++depth > maxDepth || ++entries > browserReplLimits.jsonEntries) return false;
    } else if (character === 93 || character === 125) {
      if (--depth < 0) return false;
    } else if (character === 44 && ++entries > browserReplLimits.jsonEntries) return false;
  }
  return depth === 0 && !quoted;
}

export function decodedBase64Bytes(data: string): number {
  return Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
}
