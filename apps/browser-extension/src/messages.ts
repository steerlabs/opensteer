import { BrowserSiteSchema } from "@opensteer/browser-source-wire/site";
import { maximumBrowserSourceInvitationLength } from "@opensteer/browser-source-wire/frozen";
import { BrowserSourceNameSchema } from "@opensteer/browser-source-wire/frames";
import { z } from "zod";

const invitation = z.string().max(maximumBrowserSourceInvitationLength);
const sourceId = z.string().min(1).max(128);

export const UiRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ui.status") }),
  z.object({ type: z.literal("ui.quarantine.forget"), id: z.string() }),
  z.object({ invitation, type: z.literal("ui.invitation.check") }),
  z.object({ invitation, name: BrowserSourceNameSchema, type: z.literal("ui.connect") }),
  z.object({ site: BrowserSiteSchema, sourceId, type: z.literal("ui.site.stop") }),
  z.object({ site: BrowserSiteSchema, sourceId, type: z.literal("ui.site.share") }),
  z.object({ sourceId, type: z.literal("ui.budget.reset") }),
  z.object({ sourceId, type: z.literal("ui.retry") }),
  z.object({ sourceId, type: z.literal("ui.disconnect") }),
]);
export type UiRequest = z.infer<typeof UiRequestSchema>;

export const ConnectionStateSchema = z.enum([
  "connected",
  "connecting",
  "offline",
  "different-opensteer",
  /** This extension is older than the Opensteer it connects to. */
  "update-required",
  /** The Opensteer is older than this extension. */
  "host-outdated",
  "route-changed",
  "ended",
]);
export type ConnectionState = z.infer<typeof ConnectionStateSchema>;

export const ConnectionViewSchema = z.object({
  budget: z.object({
    limit: z.number().int(),
    /** When the oldest share in the window ages out; null while the budget has room. */
    nextAt: z.number().nullable(),
    used: z.number().int(),
  }),
  deploymentName: z.string(),
  name: z.string(),
  origin: z.string(),
  sites: z.array(
    z.object({
      lastSharedAt: z.number(),
      site: BrowserSiteSchema,
      stopped: z.boolean(),
    }),
  ),
  sourceId,
  state: ConnectionStateSchema,
});
export type ConnectionView = z.infer<typeof ConnectionViewSchema>;

export const StatusSchema = z.object({
  connections: z.array(ConnectionViewSchema),
  quarantined: z.array(z.string()).default([]),
});
export type Status = z.infer<typeof StatusSchema>;

export const ConnectProblemCodeSchema = z.enum([
  "missing",
  /** The page was not opened by one of the link's own Opensteer pages. */
  "not-from-opensteer",
  "invalid",
  "expired",
  "update",
  "unreachable",
  "mismatch",
  "rejected",
  "busy",
  "failed",
]);
export type ConnectProblemCode = z.infer<typeof ConnectProblemCodeSchema>;

export const InvitationCheckSchema = z.object({
  deploymentName: z.string(),
  /** `reconnect`: connecting replaces this Chrome profile's connection to that Deployment. */
  existing: z.enum(["none", "reconnect"]),
  /** The name this Chrome profile used before, when reconnecting. */
  name: z.string().nullable(),
  origin: z.string(),
});
export type InvitationCheck = z.infer<typeof InvitationCheckSchema>;

export const ConnectResultSchema = z.object({
  deploymentName: z.string(),
  ready: z.boolean(),
});
export type ConnectResult = z.infer<typeof ConnectResultSchema>;

const ProblemSchema = z.object({
  code: ConnectProblemCodeSchema,
  deploymentName: z.string().nullable(),
  ok: z.literal(false),
  origin: z.string().nullable(),
});
export type UiProblem = z.infer<typeof ProblemSchema>;
export type UiResponse<T> = { ok: true; value: T } | UiProblem;

/** Asks the service worker and validates its answer against the expected shape. */
export async function askWorker<T>(
  request: UiRequest,
  schema: z.ZodType<T>,
): Promise<UiResponse<T>> {
  let raw: unknown;
  try {
    raw = await chrome.runtime.sendMessage(request);
  } catch {
    return { code: "failed", deploymentName: null, ok: false, origin: null };
  }
  const problem = ProblemSchema.safeParse(raw);
  if (problem.success) return problem.data;
  const answer = z.object({ ok: z.literal(true), value: schema }).safeParse(raw);
  return answer.success
    ? { ok: true, value: answer.data.value }
    : { code: "failed", deploymentName: null, ok: false, origin: null };
}
