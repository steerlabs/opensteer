import { z } from "zod";
import {
  AppIdSchema,
  BrowserSessionIdSchema,
  BrowserSurfaceIdSchema,
  TabViewSchema,
  TabGroupSchema,
  TabGroupViewSchema,
  TabGroupIdSchema,
  TabGroupColorSchema,
  TabIdSchema,
  TabKindSchema,
  TabLayoutViewSchema,
  TabTargetSchema,
  ToolErrorViewSchema,
  tabsMaxPerMutation,
} from "@opensteer/core";
import { ComputerViewSchema } from "./computer-view.js";
import { keyedStreamViewSchema } from "./keyed-stream.js";
export const TabIdsSchema = z
  .array(TabIdSchema)
  .min(1)
  .max(tabsMaxPerMutation)
  .refine((ids) => new Set(ids).size === ids.length, "Tab IDs must be unique.")
  .describe("Tab ID(s) from tab_list, tab_open, or a bound computer_use handle.");
const tabId = TabIdSchema.describe(
  "Tab ID(s) from tab_list, tab_open, or a bound computer_use handle.",
);
const groupId = TabGroupIdSchema.describe("Group ID from tab_list.groups.");
export const TabListInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(200).optional(),
  kind: TabKindSchema.optional(),
  cursor: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe("nextCursor from tab_list; omit for the first page and keep the same filters."),
});
export type TabListInput = z.infer<typeof TabListInputSchema>;
export const TabListResultSchema = z.object({
  tabs: z.array(TabViewSchema).max(50),
  groups: z.array(TabGroupViewSchema).max(200),
  nextCursor: z.string().min(1).max(512).nullable(),
});
export type TabListResult = z.infer<typeof TabListResultSchema>;
export const TabOpenInputSchema = z.strictObject({ target: TabTargetSchema });
export const TabOpenResultSchema = z.object({ tab: TabViewSchema });
export const TabCloseInputSchema = z.strictObject({ tabIds: TabIdsSchema });
export const TabCloseResultSchema = z.object({
  closed: z.array(TabIdSchema).max(500),
  failed: z.array(z.object({ tabId: TabIdSchema, error: ToolErrorViewSchema })).max(500),
});
export type TabCloseResult = z.infer<typeof TabCloseResultSchema>;
export const TabOrganizeInputSchema = z.strictObject({
  tabIds: TabIdsSchema,
  group: z.union([
    z.strictObject({ groupId }),
    z.strictObject({ name: TabGroupSchema.shape.name, color: TabGroupColorSchema }),
    z.null(),
  ]),
  beforeTabId: TabIdSchema.optional().describe(
    "Tab ID from tab_list. Inside a group, inserts before that member. At root, a group’s first member anchors its top-level boundary. Whole-group moves use an outside anchor; omit it to append the block. Empty groups cannot be anchors.",
  ),
});
export type TabOrganizeInput = z.infer<typeof TabOrganizeInputSchema>;
export const TabOrganizeResultSchema = z.object({
  tabs: z.array(TabViewSchema).max(500),
  groups: z.array(TabGroupViewSchema).max(200),
});
export type TabOrganizeResult = z.infer<typeof TabOrganizeResultSchema>;
export const TabGroupUpdateInputSchema = z
  .strictObject({
    groupId,
    name: TabGroupSchema.shape.name.optional(),
    color: TabGroupColorSchema.optional(),
    collapsed: z.boolean().optional(),
  })
  .refine(
    (input) =>
      input.name !== undefined || input.color !== undefined || input.collapsed !== undefined,
    "Supply at least one changed field.",
  );
export type TabGroupUpdateInput = z.infer<typeof TabGroupUpdateInputSchema>;
export const TabGroupUpdateResultSchema = z.object({ group: TabGroupViewSchema });
export const TabViewerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("page"),
    sessionId: BrowserSessionIdSchema,
    surfaceId: BrowserSurfaceIdSchema,
  }),
  z.object({ kind: z.literal("window"), view: ComputerViewSchema }),
  z.object({ kind: z.literal("phone"), view: ComputerViewSchema }),
  z.object({ kind: z.literal("app"), appId: AppIdSchema }),
]);
export type TabViewer = z.infer<typeof TabViewerSchema>;
export const TabBootstrapSchema = z.object({
  tabs: z.array(TabViewSchema).max(1000),
  layout: TabLayoutViewSchema,
  complete: z.boolean(),
});
export type TabBootstrap = z.infer<typeof TabBootstrapSchema>;
export const TabStreamSchema = keyedStreamViewSchema(
  TabViewSchema,
  z.object({ layout: TabLayoutViewSchema }),
  "tabId",
);
export type TabStream = z.infer<typeof TabStreamSchema>;
export const HostTabsSchema = z.object({ type: z.literal("host.tabs"), stream: TabStreamSchema });
const command = { idempotencyKey: z.string().min(1).max(255) };
export const TabCommandSchema = z.discriminatedUnion("type", [
  TabOpenInputSchema.extend({
    ...command,
    type: z.literal("tab.open"),
    /** The person typed this page's address; their browsing history ranks it for completion. */
    typed: z.literal(true).optional(),
  }),
  TabCloseInputSchema.extend({ ...command, type: z.literal("tab.close") }),
  z.strictObject({ ...command, type: z.literal("tab.reopen"), tabId: tabId.optional() }),
  z.strictObject({
    ...command,
    type: z.literal("tab.activate"),
    tabId,
  }),
  TabOrganizeInputSchema.extend({ ...command, type: z.literal("tab.organize") }),
  TabGroupUpdateInputSchema.safeExtend({ ...command, type: z.literal("tab.group.update") }),
  z.strictObject({ ...command, type: z.literal("tab.group.delete"), groupId }),
]);
export type TabCommand = z.infer<typeof TabCommandSchema>;
export const TabCommandResultSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tab.open"), tab: TabViewSchema, layout: TabLayoutViewSchema }),
  z.object({ type: z.literal("tab.reopen"), tab: TabViewSchema, layout: TabLayoutViewSchema }),
  TabCloseResultSchema.extend({ type: z.literal("tab.close"), layout: TabLayoutViewSchema }),
  z.object({
    type: z.literal("tab.organize"),
    tabs: z.array(TabViewSchema).max(500),
    layout: TabLayoutViewSchema,
  }),
  z.object({
    type: z.literal("tab.group.update"),
    group: TabGroupViewSchema,
    layout: TabLayoutViewSchema,
  }),
  z.object({ type: z.literal("tab.group.delete"), layout: TabLayoutViewSchema }),
  z.object({ type: z.literal("tab.activate"), tab: TabViewSchema, viewer: TabViewerSchema }),
]);
export type TabCommandResult = z.infer<typeof TabCommandResultSchema>;
export const TabGetInputSchema = z.strictObject({ tabId });
