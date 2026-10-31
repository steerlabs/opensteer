import { z } from "zod";
import { ComputerViewIdSchema } from "./computer-view.js";
import {
  BrowserSessionIdSchema,
  BrowserSurfaceIdSchema,
  MessageIdSchema,
  RunnerIdSchema,
  ThreadIdSchema,
} from "./ids.js";

const taskSource = z.strictObject({
  kind: z.literal("task-session"),
  sessionId: z.string().min(1).max(255),
});
const ownerSource = {
  kind: z.literal("owner-view"),
  viewId: ComputerViewIdSchema,
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
};

/** A presentation pins its source; naming an app alone cannot identify its picture. */
export const ScreenSurfaceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("browser"),
    sessionId: BrowserSessionIdSchema,
    tabId: BrowserSurfaceIdSchema,
  }),
  z.strictObject({
    kind: z.literal("app"),
    machineId: RunnerIdSchema,
    appKey: z.string().min(1).max(255),
    source: z.discriminatedUnion("kind", [
      taskSource,
      z.strictObject({ ...ownerSource, windowId: z.number().int().nonnegative() }),
    ]),
  }),
  z.strictObject({
    kind: z.literal("phone"),
    machineId: RunnerIdSchema,
    display: z.string().min(1).max(255),
    source: z.discriminatedUnion("kind", [taskSource, z.strictObject(ownerSource)]),
  }),
]);
export type ScreenSurface = z.infer<typeof ScreenSurfaceSchema>;

export const ScreenShowTargetSchema = z
  .strictObject({
    conversationId: ThreadIdSchema.optional(),
    surface: ScreenSurfaceSchema.optional(),
  })
  .refine((target) => target.conversationId !== undefined || target.surface !== undefined, {
    message: "Choose a conversation or surface to show.",
  });
export type ScreenShowTarget = z.infer<typeof ScreenShowTargetSchema>;

export const ScreenShowInputSchema = z.strictObject({
  messageId: MessageIdSchema,
  target: ScreenShowTargetSchema,
});
export type ScreenShowInput = z.infer<typeof ScreenShowInputSchema>;

export const ScreenPresentationOutcomeSchema = z.enum([
  "applied",
  "superseded",
  "unavailable",
  "unsupported",
  "unconfirmed",
]);
export type ScreenPresentationOutcome = z.infer<typeof ScreenPresentationOutcomeSchema>;

export const ScreenPresentationReceiptSchema = z.strictObject({
  outcome: ScreenPresentationOutcomeSchema,
  reason: z
    .enum(["busy", "interaction-ended", "already-requested", "expired", "closed", "forbidden"])
    .optional(),
});
export type ScreenPresentationReceipt = z.infer<typeof ScreenPresentationReceiptSchema>;

/** Descriptive input context never grants access to the named conversation. */
export const ScreenPresentationContextSchema = z.strictObject({
  currentThreadId: ThreadIdSchema.optional(),
});
export type ScreenPresentationContext = z.infer<typeof ScreenPresentationContextSchema>;
