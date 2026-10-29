import { z } from "zod";
import { BrowserSurfaceIdSchema, BrowserTabGroupIdSchema } from "./ids.js";

export const BrowserTabGroupColorSchema = z.enum([
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
]);
export type BrowserTabGroupColor = z.infer<typeof BrowserTabGroupColorSchema>;
export const browserTabGroupTitleMaxLength = 80;
export const browserTabGroupMaxTabs = 500;
export const browserTabGroupsMaxPerOwner = 200;
export const BrowserTabGroupTitleSchema = z.string().trim().max(browserTabGroupTitleMaxLength);
export const BrowserTabGroupTabIdsSchema = z
  .array(BrowserSurfaceIdSchema)
  .min(1)
  .max(browserTabGroupMaxTabs);
/** The most saved tabs a person's order keeps; past it, organizing asks them to close some. */
export const browserTabOrderMaxTabs = 10_000;
/**
 * Where moved tabs or a group land: in a group (`groupId`) or outside any
 * (`null`), before a tab or group there or at the end (`before: null`). The
 * anchor must still be in that place when the move lands; a move never
 * guesses another destination.
 */
export const BrowserTabMoveSchema = z.strictObject({
  item: z.union([
    z.strictObject({ tabIds: BrowserTabGroupTabIdsSchema }),
    z.strictObject({ groupId: BrowserTabGroupIdSchema }),
  ]),
  to: z.strictObject({
    groupId: BrowserTabGroupIdSchema.nullable(),
    before: z
      .union([
        z.strictObject({ tabId: BrowserSurfaceIdSchema }),
        z.strictObject({ groupId: BrowserTabGroupIdSchema }),
      ])
      .nullable(),
  }),
});
export type BrowserTabMove = z.infer<typeof BrowserTabMoveSchema>;
export const BrowserTabReadInputSchema = z.strictObject({
  cursor: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe("nextCursor from the previous page; omit for the first page."),
});
export type BrowserTabReadInput = z.infer<typeof BrowserTabReadInputSchema>;
export const BrowserTabWriteInputSchema = z.strictObject({
  action: z.enum(["group", "ungroup", "update_group", "close", "restore", "move"]),
  tabIds: BrowserTabGroupTabIdsSchema.optional(),
  groupId: BrowserTabGroupIdSchema.optional(),
  /** For `move`: the group the tabs land in; omitted, they land outside any group. */
  toGroupId: BrowserTabGroupIdSchema.optional(),
  /** For `move`: the tab ID or group ID they land before; omitted, at the end. */
  before: z.string().min(1).max(512).optional(),
  title: BrowserTabGroupTitleSchema.optional(),
  color: BrowserTabGroupColorSchema.optional(),
  collapsed: z.boolean().optional(),
});
export type BrowserTabWriteInput = z.infer<typeof BrowserTabWriteInputSchema>;
