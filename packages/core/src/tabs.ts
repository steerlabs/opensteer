import type { RunnerId } from "./ids.js";
import { DeviceIdSchema } from "./devices.js";
import { z } from "zod";
import { AppIdSchema } from "./apps.js";
import {
  BrowserProfileIdSchema,
  BrowserSessionIdSchema,
  BrowserSurfaceIdSchema,
  BrowserSourceIdSchema,
  TabIdSchema,
  TabGroupIdSchema,
  ThreadIdSchema,
  WindowIdSchema,
} from "./ids.js";
import { IsoDateTimeSchema } from "./models.js";
export {
  TabIdSchema,
  TabGroupIdSchema,
  WindowIdSchema,
  type TabId,
  type TabGroupId,
  type WindowId,
} from "./ids.js";

export const tabsMaxPerOwner = 1000;
export const tabGroupsMaxPerOwner = 200;
export const tabsMaxPerMutation = 500;
export const tabLayoutMaxBytes = 128 * 1024;
export const TabGroupColorSchema = z.enum([
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
export type TabGroupColor = z.infer<typeof TabGroupColorSchema>;
export const TabKindSchema = z.enum(["page", "window", "phone", "app"]);
export type TabKind = z.infer<typeof TabKindSchema>;
export const TabStateSchema = z.enum(["open", "asleep", "unavailable"]);
export type TabState = z.infer<typeof TabStateSchema>;
export const TabOpenedBySchema = z.union([
  z.literal("person"),
  z.strictObject({ taskId: ThreadIdSchema }),
]);
export type TabOpenedBy = z.infer<typeof TabOpenedBySchema>;
/** The one test for an extension's address (see `@opensteer/shared/extensionUrl`). */
export { isExtensionUrl } from "@opensteer/shared/extensionUrl";

/**
 * Whether a page-open URL is allowed for a connected agent (`about:blank` or credential-free
 * HTTP(S)), judged strictly by the parsed WHATWG URL protocol.
 */
export function isAllowedConnectionPageUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value === "about:blank") return true;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

/** Canonical WHATWG serialization of a page-open URL, preserving `about:blank`. */
export function normalizePageOpenUrl(value: string): string {
  return value === "about:blank" ? value : new URL(value).href;
}

export const PageOpenUrlSchema = z
  .string()
  .min(1)
  .max(8192)
  .refine((value) => {
    if (value === "about:blank") return true;
    try {
      const url = new URL(value);
      // Extension pages (an options page, a popup) open as tabs, as in Chrome.
      return (
        ["http:", "https:", "chrome-extension:"].includes(url.protocol) &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }, "Use about:blank, an HTTP(S) URL without credentials, or an extension page.");
export const DeviceTabTargetSchema = z.union([
  z.strictObject({
    kind: z.literal("page"),
    url: PageOpenUrlSchema,
    viewport: z
      .strictObject({
        width: z.number().int().min(1).max(8192),
        height: z.number().int().min(1).max(8192),
      })
      .optional(),
    profileId: BrowserProfileIdSchema.describe(
      "Profile ID from browser_profile_list; the profile's home selects its computer.",
    ),
  }),
  z.strictObject({
    kind: z.literal("page"),
    url: PageOpenUrlSchema,
    viewport: z
      .strictObject({
        width: z.number().int().min(1).max(8192),
        height: z.number().int().min(1).max(8192),
      })
      .optional(),
    guest: z.literal(true),
    computerId: DeviceIdSchema.optional().describe(
      "Computer ID from computer_list; for Guest, omitted means the hosting computer.",
    ),
  }),
  z.strictObject({
    kind: z.literal("window"),
    computerId: DeviceIdSchema.describe("Computer ID from computer_list."),
    windowId: WindowIdSchema.describe(
      "Opaque exact-window handle from computer_use app.windows() or the Host window picker; valid on this computer only.",
    ),
  }),
  z.strictObject({
    kind: z.literal("window"),
    computerId: DeviceIdSchema.describe("Computer ID from computer_list."),
    bundleId: z
      .string()
      .min(1)
      .max(255)
      .describe(
        "Installed approved app bundle ID from computer_use apps(); binds one window after opening the app.",
      ),
  }),
  z.strictObject({
    kind: z.literal("phone"),
    computerId: DeviceIdSchema.describe("Computer ID from computer_list."),
  }),
  z.strictObject({
    kind: z.literal("app"),
    appId: AppIdSchema.describe("App ID from app_list or app_publish."),
  }),
]);
export type DeviceTabTarget = z.infer<typeof DeviceTabTargetSchema>;
export type TabTarget =
  | DeviceTabTarget
  | { readonly kind: "phone"; readonly computerId: RunnerId }
  | { readonly kind: "window"; readonly computerId: RunnerId; readonly bundleId: string };
export const TabTargetSchema: z.ZodType<TabTarget> = DeviceTabTargetSchema;
export const TabUnavailableCodeSchema = z.enum([
  "computer-offline",
  "computer-removed",
  "access-denied",
  "unsupported",
  "profile-unavailable",
  "window-closed",
  "window-identity-lost",
  "locked",
  "minimized",
  "paused",
  "protected",
  "runtime-failed",
  "app-stopped",
  "app-failed",
]);
export type TabUnavailableCode = z.infer<typeof TabUnavailableCodeSchema>;
export const TabSchema = z
  .strictObject({
    tabId: TabIdSchema,
    kind: TabKindSchema,
    title: z.string().max(1024),
    computer: z.strictObject({ computerId: DeviceIdSchema, name: z.string().max(200) }),
    sharedByPerson: z
      .object({ sourceId: BrowserSourceIdSchema, computerName: z.string().max(200) })
      .optional(),
    groupId: TabGroupIdSchema.nullable(),
    state: TabStateSchema,
    unavailableCode: TabUnavailableCodeSchema.optional(),
    unavailableReason: z.string().min(1).max(1000).optional(),
    openedBy: TabOpenedBySchema,
    /**
     * The tasks that hold the tab, each with when its work last took the tab up (`since`): a
     * script's bind of it, a Run's last action in it. Where several hold it, or a task holds
     * several tabs, the latest is where that work is now.
     */
    usedBy: z
      .array(z.strictObject({ taskId: ThreadIdSchema, since: IsoDateTimeSchema.optional() }))
      .max(128),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    url: z.string().max(16384).optional(),
    profile: z
      .strictObject({ profileId: BrowserProfileIdSchema, name: z.string().max(200) })
      .nullable()
      .optional(),
    appName: z.string().max(512).optional(),
    bundleId: z.string().max(255).optional(),
    appId: AppIdSchema.optional(),
    iconRef: z.string().max(128).nullable().optional(),
  })
  .superRefine((tab, ctx) => {
    const invalid = (message: string) => ctx.addIssue({ code: "custom", message });
    const fields = {
      page: ["url", "profile"],
      window: ["appName", "bundleId"],
      phone: [],
      app: ["appId"],
    } as const;
    for (const field of ["url", "profile", "appName", "bundleId", "appId"] as const) {
      const required: readonly string[] = fields[tab.kind];
      if (required.includes(field) !== (tab[field] !== undefined))
        invalid(`${tab.kind} tab has invalid ${field}.`);
    }
    if (
      (tab.state === "unavailable") !== (tab.unavailableCode !== undefined) ||
      (tab.state === "unavailable") !== (tab.unavailableReason !== undefined)
    )
      invalid("Only unavailable tabs require an unavailable code and reason.");
    if (
      tab.usedBy.some(
        (holder, index) => index > 0 && holder.taskId <= tab.usedBy[index - 1]!.taskId,
      )
    )
      invalid("usedBy must be unique and sorted by task ID.");
  });
export type Tab = z.infer<typeof TabSchema>;
export const TabViewSchema = z
  .object({
    ...TabSchema.shape,
    computer: z.object(TabSchema.shape.computer.shape),
    profile: z
      .object({ profileId: BrowserProfileIdSchema, name: z.string().max(200) })
      .nullable()
      .optional(),
    usedBy: z
      .array(z.object({ taskId: ThreadIdSchema, since: IsoDateTimeSchema.optional() }))
      .max(128),
    openedBy: z.union([z.literal("person"), z.object({ taskId: ThreadIdSchema })]),
  })
  .superRefine((tab, ctx) => {
    const result = TabSchema.safeParse(tab);
    if (!result.success) for (const issue of result.error.issues) ctx.addIssue({ ...issue });
  });
export const TabGroupSchema = z.strictObject({
  groupId: TabGroupIdSchema,
  name: z.string().trim().min(1).max(80),
  color: TabGroupColorSchema,
  collapsed: z.boolean(),
  tabIds: z.array(TabIdSchema).max(tabsMaxPerMutation),
});
export type TabGroup = z.infer<typeof TabGroupSchema>;
export const TabLayoutSchema = z
  .strictObject({
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    items: z
      .array(
        z.union([
          z.strictObject({ kind: z.literal("tab"), tabId: TabIdSchema }),
          z.strictObject({ kind: z.literal("group"), group: TabGroupSchema }),
        ]),
      )
      .max(1200),
  })
  .refine(
    (layout) => new TextEncoder().encode(JSON.stringify(layout)).byteLength <= tabLayoutMaxBytes,
    "Tab layout exceeds 128 KiB.",
  );
export type TabLayout = z.infer<typeof TabLayoutSchema>;
export const PageBindingSchema = z.strictObject({
  lineageId: BrowserSessionIdSchema,
  sessionId: BrowserSessionIdSchema,
  surfaceId: BrowserSurfaceIdSchema,
});
export type PageBinding = z.infer<typeof PageBindingSchema>;
export const ClosedPositionSchema = z.strictObject({
  groupId: TabGroupIdSchema.nullable(),
  beforeTabId: TabIdSchema.nullable(),
});
export type ClosedPosition = z.infer<typeof ClosedPositionSchema>;

export const TabGroupViewSchema = z.object(TabGroupSchema.shape);
export const TabLayoutViewSchema = z
  .object({
    ...TabLayoutSchema.shape,
    items: z
      .array(
        z.union([
          z.object({ kind: z.literal("tab"), tabId: TabIdSchema }),
          z.object({ kind: z.literal("group"), group: TabGroupViewSchema }),
        ]),
      )
      .max(1200),
  })
  .refine(
    (layout) => new TextEncoder().encode(JSON.stringify(layout)).byteLength <= tabLayoutMaxBytes,
    "Tab layout exceeds 128 KiB.",
  );
