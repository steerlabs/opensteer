import { z } from "zod";
import {
  BrowserProfileIdSchema,
  BrowserSessionIdSchema,
  BrowserSurfaceIdSchema,
  BrowserTabGroupIdSchema,
  BrowserTabWriteInputSchema,
  EnvironmentIdSchema,
} from "@opensteer/core";
import { BrowserTabWriteResultSchema } from "./browser.js";

/**
 * What an agent's Browser Harness asks the Host about tabs, through the Run's
 * browser relay. Agents address tabs; the Host resolves the browser session
 * behind each one, so no session ID reaches the model.
 *
 * The relay serves `<relay base>/agent/<path>` from the Host's
 * `/internal/v1/browser-agent/<path>` with the Run's tool token.
 */
export const browserAgentRoutePaths = {
  tabs: "tabs",
  open: "tabs/open",
  use: "tabs/use",
  close: "tabs/close",
  organize: "tabs/organize",
} as const;
export const browserAgentHostRoutePrefix = "/internal/v1/browser-agent";
export const browserAgentRequestMaxBytes = 64 * 1_024;
export const browserAgentResponseMaxBytes = 1_024 * 1_024;
export const browserAgentTabListDefaultLimit = 50;
export const browserAgentTabListMaxLimit = 200;

const OperationKeySchema = z.string().min(1).max(255);

export const BrowserAgentTabStateSchema = z.enum(["open", "asleep", "opening"]);

/** GET `tabs`: every tab the task can reach, in the person's own list order. */
export const BrowserAgentTabListQuerySchema = z.strictObject({
  /** Matches title, address, group or profile name. */
  query: z.string().trim().min(1).max(200).optional(),
  state: z.enum(["open", "asleep"]).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(browserAgentTabListMaxLimit)
    .default(browserAgentTabListDefaultLimit),
  cursor: z.string().min(1).max(512).optional(),
});
export type BrowserAgentTabListQuery = z.infer<typeof BrowserAgentTabListQuerySchema>;

export const BrowserAgentTabSchema = z.strictObject({
  tabId: BrowserSurfaceIdSchema,
  title: z.string().max(256),
  url: z.string().max(16_384),
  /** Null is Guest. */
  profile: z.strictObject({ id: BrowserProfileIdSchema, name: z.string().max(200) }).nullable(),
  /** The computer whose browser holds the tab. */
  computer: z.string().max(200).nullable(),
  state: BrowserAgentTabStateSchema,
  usedByThisTask: z.boolean(),
  usedByOtherTask: z.boolean(),
  groupId: BrowserTabGroupIdSchema.nullable(),
});
export type BrowserAgentTab = z.infer<typeof BrowserAgentTabSchema>;

export const BrowserAgentTabListResultSchema = z.strictObject({
  tabs: z.array(BrowserAgentTabSchema).max(browserAgentTabListMaxLimit),
  /** Matching tabs in all. */
  total: z.number().int().nonnegative(),
  nextCursor: z.string().min(1).max(512).nullable(),
});
export type BrowserAgentTabListResult = z.infer<typeof BrowserAgentTabListResultSchema>;

/** The browser behind a tab the Run may now drive. Internal: never shown to the model. */
const BrowserAgentBindingFields = {
  tabId: BrowserSurfaceIdSchema,
  sessionId: BrowserSessionIdSchema,
  backend: z.enum(["cdp", "actions"]),
};

/** POST `tabs/use`: attach the Run to this exact tab, waking or restoring it. */
export const BrowserAgentTabUseInputSchema = z.strictObject({ tabId: BrowserSurfaceIdSchema });
export const BrowserAgentTabUseResultSchema = z.strictObject({
  ...BrowserAgentBindingFields,
  /** The tab reloaded to wake or restore: earlier page handles are invalid. */
  reloaded: z.boolean(),
});
export type BrowserAgentTabUseResult = z.infer<typeof BrowserAgentTabUseResultSchema>;

/**
 * POST `tabs/open`: a new tab as an identity. A profile joins its running
 * browser or starts it; Guest uses this task's Guest browser or starts one.
 * Replaying the same `operationKey` returns the same tab.
 */
export const BrowserAgentTabOpenInputSchema = z.strictObject({
  url: z
    .string()
    .max(8_192)
    .refine(
      (value) => value === "about:blank" || /^https?:\/\//iu.test(value),
      "Only HTTP, HTTPS and about:blank addresses open.",
    )
    .optional(),
  identity: z.discriminatedUnion("kind", [
    /** A profile ID, or a profile name that names exactly one profile. */
    z.strictObject({ kind: z.literal("profile"), profile: z.string().trim().min(1).max(200) }),
    z.strictObject({ kind: z.literal("guest"), computer: EnvironmentIdSchema.optional() }),
  ]),
  operationKey: OperationKeySchema,
});
export type BrowserAgentTabOpenInput = z.infer<typeof BrowserAgentTabOpenInputSchema>;
export const BrowserAgentTabOpenResultSchema = z.strictObject(BrowserAgentBindingFields);
export type BrowserAgentTabOpenResult = z.infer<typeof BrowserAgentTabOpenResultSchema>;

/** POST `tabs/close`: open or asleep tabs, in any browser. */
export const BrowserAgentTabCloseInputSchema = z.strictObject({
  tabIds: z.array(BrowserSurfaceIdSchema).min(1).max(64),
  operationKey: OperationKeySchema,
});
export const BrowserAgentTabCloseResultSchema = z.strictObject({
  closed: z.array(BrowserSurfaceIdSchema),
  failed: z.array(
    z.strictObject({ tabId: BrowserSurfaceIdSchema, message: z.string().max(1_000) }),
  ),
});
export type BrowserAgentTabCloseResult = z.infer<typeof BrowserAgentTabCloseResultSchema>;

/** POST `tabs/organize`: the person's groups and order. */
export const BrowserAgentTabOrganizeInputSchema = BrowserTabWriteInputSchema.extend({
  action: z.enum(["group", "ungroup", "update_group", "move"]),
  operationKey: OperationKeySchema,
});
export type BrowserAgentTabOrganizeInput = z.infer<typeof BrowserAgentTabOrganizeInputSchema>;
export const BrowserAgentTabOrganizeResultSchema = BrowserTabWriteResultSchema;
