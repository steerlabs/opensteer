import { browserBase } from "./browser-message-base.js";
import {
  PasskeyCeremonySchema,
  PasskeyCancelSchema,
  PasskeyRuntimeCancelSchema,
  PasskeyResultSchema,
  BrowserPasskeyRequestSchema,
  BrowserPasskeyOfferSchema,
  BrowserPasskeyWithdrawnSchema,
  BrowserPasskeyNoticeSchema,
  PasskeyClaimSchema,
  PasskeyRespondSchema,
  PasskeyModeSchema,
} from "./passkeys.js";
import {
  BrowserTabGroupColorSchema,
  browserTabGroupTitleMaxLength,
  browserTabGroupMaxTabs,
  browserTabGroupsMaxPerOwner,
  BrowserTabGroupTitleSchema,
  BrowserTabGroupTabIdsSchema,
  BrowserTabMoveSchema,
  browserTabOrderMaxTabs,
  BrowserTabWriteInputSchema,
} from "@opensteer/core";
export const BrowserRasterDensitySchema = z.union([
  z.literal(0.75),
  z.literal(1),
  z.literal(1.25),
  z.literal(1.5),
  z.literal(2),
]);
export type BrowserRasterDensity = z.infer<typeof BrowserRasterDensitySchema>;

export {
  BrowserTabGroupColorSchema,
  browserTabGroupTitleMaxLength,
  browserTabGroupMaxTabs,
  browserTabGroupsMaxPerOwner,
  BrowserTabGroupTitleSchema,
  BrowserTabGroupTabIdsSchema,
  BrowserTabMoveSchema,
  browserTabOrderMaxTabs,
  BrowserTabReadInputSchema,
  BrowserTabWriteInputSchema,
  type BrowserTabGroupColor,
  type BrowserTabMove,
  type BrowserTabReadInput,
  type BrowserTabWriteInput,
} from "@opensteer/core";
import {
  BrowserProfileIdSchema,
  BrowserProfileGrantIdSchema,
  BrowserSessionIdSchema,
  BrowserSiteSchema,
  BrowserSurfaceIdSchema,
  BrowserTabGroupIdSchema,
  type BrowserSessionId,
  RunnerIdSchema,
  RunIdSchema,
  ThreadIdSchema,
  EnvironmentIdSchema,
  IsoDateTimeSchema,
  WorkspaceIdSchema,
  UserIdSchema,
} from "@opensteer/core";
import {
  BrowserProfileAccessSchema,
  type BrowserProfileAccess,
} from "@opensteer/browser-profile/grant";
import {
  BrowserCookieSchema,
  BrowserProfileSnapshotSchema,
} from "@opensteer/browser-profile/snapshot";
import { maxBrowserSourceCookies } from "@opensteer/browser-profile/source-state";
import { browserFrameFits, browserFrameLimits } from "@opensteer/browser-core/frame-limits";
import { z } from "zod";
import { PlaceOccupantSchema } from "./places.js";
import {
  EditingClipboardItemsSchema,
  EditingClipboardOperationIdSchema,
  EditingClipboardOutcomeSchema,
  EditingClipboardPartSchema,
  EditingCommandSchema,
  EditingCompositionSchema,
  EditingContextSchema,
  EditingModifiersSchema,
  EditingTextEditSchema,
} from "./editing.js";
import { ProtocolErrorSchema } from "./common.js";
import {
  PasswordSignInAvailabilitySchema,
  PasswordSignInCancelReasonSchema,
  LoginAuthorizationOutcomeSchema,
  PasswordSignInRequesterSchema,
} from "./password-sign-in.js";

export {
  BrowserSessionIdSchema,
  BrowserSurfaceIdSchema,
  BrowserTabGroupIdSchema,
  type BrowserSessionId,
  type BrowserSurfaceId,
  type BrowserTabGroupId,
} from "@opensteer/core";

export function createBrowserSessionId(): BrowserSessionId {
  return BrowserSessionIdSchema.parse(`bsn_${globalThis.crypto.randomUUID()}`);
}

export { BrowserProfileAccessSchema, type BrowserProfileAccess };

export const BrowserProfileGrantSchema = z.object({
  access: BrowserProfileAccessSchema,
  createdAt: IsoDateTimeSchema,
  id: BrowserProfileGrantIdSchema,
  profileId: BrowserProfileIdSchema,
  workspaceId: WorkspaceIdSchema,
});
export type BrowserProfileGrant = z.infer<typeof BrowserProfileGrantSchema>;

export const BrowserAttachPublicKeySchema = z.strictObject({
  keyId: z.string().regex(/^[A-Za-z0-9._:-]{1,255}$/),
  publicKeyPem: z.string().min(64).max(2_048),
});
export type BrowserAttachPublicKey = z.infer<typeof BrowserAttachPublicKeySchema>;

export const BrowserAttachPublicKeysSchema = z.array(BrowserAttachPublicKeySchema).min(1).max(4);

/** Periodic checkpoints preserve, but never extend, final-save lease grace. */
export const browserProfileCheckpointHeader = "x-opensteer-profile-checkpoint";

/**
 * A Browser Session's identity, chosen when it opens and immutable for its
 * life. A fresh session carries no profile, so it has no state lease and no
 * profile-state endpoint at all.
 */
export const BrowserAttachTicketIdentitySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("profile"),
    profileId: BrowserProfileIdSchema,
    profileLeaseToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    profileStateUrl: z.url().max(8_192),
  }),
  z.strictObject({ kind: z.literal("fresh") }),
]);
export type BrowserAttachTicketIdentity = z.infer<typeof BrowserAttachTicketIdentitySchema>;

export const browserWorkspaceTabUrlMaxLength = 16_384;

export const BrowserWorkspaceTabDescriptorSchema = z.object({
  id: BrowserSurfaceIdSchema,
  title: z.string().max(256),
  url: z.string().max(browserWorkspaceTabUrlMaxLength),
  order: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  openerId: BrowserSurfaceIdSchema.nullable(),
});
export type BrowserWorkspaceTabDescriptor = z.infer<typeof BrowserWorkspaceTabDescriptorSchema>;

export const BrowserAttachTicketClaimsSchema = z
  .strictObject({
    access: BrowserProfileAccessSchema,
    audience: z.literal("opensteer-browser-runtime"),
    passkeys: z.literal(1).optional(),
    navigationVersion: z.literal(1).optional(),
    /**
     * The Host understands the editing contract (`editing.ts`): the runtime may
     * put `editingVersion` in its snapshot, accept editing commands and emit
     * editing kinds. Issued only to a runtime advertising `modules.browser.editing`.
     */
    editingVersion: z.union([z.literal(1), z.literal(2)]).optional(),
    /** V2 makes the isolated engine clipboard explicit; v1 implies true. */
    clipboard: z.boolean().optional(),
    workspaceTabRestoreVersion: z.literal(1).optional(),
    initialSurfaceId: BrowserSurfaceIdSchema.optional(),
    dormantSurfaceIds: z.array(BrowserSurfaceIdSchema).max(63).optional(),
    expiresAt: IsoDateTimeSchema,
    identity: BrowserAttachTicketIdentitySchema,
    issuedAt: IsoDateTimeSchema,
    nonce: z.string().min(16).max(255),
    runtimeId: z.string().min(1).max(255),
    sessionId: BrowserSessionIdSchema,
    subject: z.string().min(1).max(255),
    /**
     * The view a person starts the browser from. The session's first page opens
     * at this size instead of the browser's default, before anything loads.
     */
    viewport: z
      .strictObject({
        height: z.number().int().positive().max(browserFrameLimits.maxHeight),
        width: z.number().int().positive().max(browserFrameLimits.maxWidth),
      })
      .refine((viewport) => browserFrameFits(viewport.width, viewport.height), {
        message: "The browser viewport exceeds the browser frame resource limit.",
      })
      .optional(),
  })
  .refine(
    (claims) =>
      claims.editingVersion === 2 ? claims.clipboard !== undefined : claims.clipboard === undefined,
    {
      path: ["clipboard"],
      message: "Editing v2 requires an explicit clipboard capability; other versions omit it.",
    },
  );
export type BrowserAttachTicketClaims = z.infer<typeof BrowserAttachTicketClaimsSchema>;

/** The heaviest site icon a tab carries; a site with a heavier one goes without. */
export const browserFaviconMaxBytes = 16 * 1_024;

/**
 * A tab's site icon as the browser itself fetched it, as a raster data URL a
 * client draws without reaching the site. Absent while the page names none
 * that loads, and from an older Browser Runtime.
 */
export const BrowserFaviconSchema = z
  .string()
  .max(64 + Math.ceil(browserFaviconMaxBytes / 3) * 4)
  .regex(/^data:image\/(?:png|x-icon|gif|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/);

export const BrowserSurfaceSchema = z.strictObject({
  canGoBack: z.boolean().optional(),
  canGoForward: z.boolean().optional(),
  active: z.boolean(),
  favicon: BrowserFaviconSchema.optional(),
  id: BrowserSurfaceIdSchema,
  /**
   * An agent set this page's size, which it shows instead of the person's
   * until the agent clears it or the person fits the page. Absent from an
   * older Browser Runtime.
   */
  sizedByAgent: z.boolean().optional(),
  /**
   * The page's own document is loading: from its main frame starting a load
   * until it stops, as a browser's tab spinner shows. A frame inside the page
   * loading on its own is not the tab loading. Absent while it is not loading,
   * and from an older Browser Runtime.
   */
  loading: z.boolean().optional(),
  documentId: z.string().min(1).max(255).optional(),
  geometryRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  order: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  openerId: BrowserSurfaceIdSchema.nullable().optional(),
  title: z.string().max(1_000),
  url: z.string().max(16_384),
});
export type BrowserSurface = z.infer<typeof BrowserSurfaceSchema>;

export const BrowserSurfacesSchema = z
  .array(BrowserSurfaceSchema)
  .max(64)
  .superRefine((surfaces, context) => {
    const ids = new Set<string>();
    for (const [index, surface] of surfaces.entries()) {
      if (ids.has(surface.id)) {
        context.addIssue({
          code: "custom",
          message: "Browser surface IDs must be unique.",
          path: [index, "id"],
        });
      }
      ids.add(surface.id);
    }
    if (surfaces.length > 0 && surfaces.filter((surface) => surface.active).length !== 1) {
      context.addIssue({
        code: "custom",
        message: "A non-empty browser surface list must have exactly one active surface.",
      });
    }
  });

export const BrowserCdpMethodSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/)
  .max(160);
export const BrowserCdpSessionIdSchema = z.string().min(1).max(512);
export const BrowserCdpParametersSchema = z.record(z.string(), z.unknown());

export const BrowserCdpCommandSchema = z.strictObject({
  method: BrowserCdpMethodSchema,
  parameters: BrowserCdpParametersSchema.optional(),
  sessionId: BrowserCdpSessionIdSchema.optional(),
});

/**
 * CDP answers every command with an object. A result absent in memory
 * vanishes from the JSON, and every receiver then refuses the answer.
 */
export const BrowserCdpResultSchema = z.record(z.string(), z.unknown());

export const BrowserCdpEventSchema = z.strictObject({
  method: BrowserCdpMethodSchema,
  parameters: BrowserCdpParametersSchema,
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sessionId: BrowserCdpSessionIdSchema.optional(),
});

const browserRequestBase = {
  ...browserBase,
  requestId: z.uuid(),
} as const;
const BrowserViewportDimensionSchema = z.number().finite().positive().max(16_384);

/** The canonical DPR-1 resource boundary for a Browser Session viewport. */
export function browserViewportFits(width: number, height: number): boolean {
  return browserFrameFits(width, height, 1);
}

export const BrowserDialogSchema = z.strictObject({
  /** This dialog, which an answer names, so it never reaches another one. */
  id: z.uuid(),
  message: z.string().max(10_000),
  surfaceId: BrowserSurfaceIdSchema,
  type: z.enum(["alert", "beforeunload", "confirm", "prompt"]),
});
export type BrowserDialog = z.infer<typeof BrowserDialogSchema>;

/**
 * A Browser Runtime gives up on a `state.import` it has not written within
 * this long, and never writes it afterwards. The Host waits longer, so a
 * failure it reports is always one the runtime reported first.
 */
export const browserStateImportRuntimeTimeoutMs = 20_000;
export const browserStateImportHostTimeoutMs = 30_000;

/** The longest answer a page's prompt dialog takes; answer fields stop there. */
export const browserPromptTextMaxLength = 10_000;
/** The most text one paste carries to a page; typing fields stop there. */
export const browserPasteTextMaxLength = 1_000_000;

const BaselineBrowserClientMessageSchema = z
  .discriminatedUnion("type", [
    PasskeyResultSchema,
    z.strictObject({
      ...browserBase,
      type: z.literal("stream.demand"),
      surfaceId: BrowserSurfaceIdSchema,
      density: BrowserRasterDensitySchema,
    }),
    PasskeyClaimSchema,
    PasskeyRespondSchema,
    z.strictObject({
      ...browserBase,
      /**
       * `false` follows the target without pictures: its dialogs and changes
       * still arrive, and no screencast starts for this consumer.
       */
      frames: z.literal(false).optional(),
      frameWindow: z.literal(1).optional(),
      captureRegion: z.literal(true).optional(),
      surfaceId: BrowserSurfaceIdSchema.optional(),
      type: z.literal("stream.subscribe"),
    }),
    z.strictObject({
      ...browserBase,
      surfaceId: BrowserSurfaceIdSchema.optional(),
      type: z.literal("stream.unsubscribe"),
    }),
    /** Watch-only credit for the exact frame delivered on this subscription. */
    z.strictObject({
      ...browserBase,
      surfaceId: BrowserSurfaceIdSchema.optional(),
      type: z.literal("stream.ack"),
      token: z.uuid(),
    }),
    /**
     * The person fits one page (tab) to their view: it takes this size and
     * loses any size an agent set on it. Every other page keeps its size.
     */
    z.strictObject({
      ...browserBase,
      height: z.number().int().positive().max(browserFrameLimits.maxHeight),
      surfaceId: BrowserSurfaceIdSchema,
      type: z.literal("viewport.set"),
      width: z.number().int().positive().max(browserFrameLimits.maxWidth),
    }),
    /**
     * The person's view of one page is this size, as a window's is: the page
     * takes it unless an agent set its own size there, and returns to it when
     * the agent clears that. A viewer sends it for what the person does on
     * their own screen — opening the page, choosing it, resizing the view —
     * never because another screen changed something.
     */
    z.strictObject({
      ...browserBase,
      height: z.number().int().positive().max(browserFrameLimits.maxHeight),
      surfaceId: BrowserSurfaceIdSchema,
      type: z.literal("viewport.follow"),
      width: z.number().int().positive().max(browserFrameLimits.maxWidth),
    }),
    z.strictObject({
      ...browserBase,
      type: z.literal("surface.activate"),
      surfaceId: BrowserSurfaceIdSchema,
    }),
    z.strictObject({
      ...browserBase,
      type: z.literal("surface.close"),
      surfaceId: BrowserSurfaceIdSchema,
    }),
    /**
     * A page the person opens. It starts at the size of the place they will
     * read it (`viewport`); without one it starts at the size the person's
     * view last gave this session.
     */
    z.strictObject({
      ...browserBase,
      type: z.literal("surface.open"),
      url: z.url().optional(),
      viewport: z
        .strictObject({
          height: z.number().int().positive().max(browserFrameLimits.maxHeight),
          width: z.number().int().positive().max(browserFrameLimits.maxWidth),
        })
        .optional(),
    }),
    z.strictObject({
      ...browserBase,
      surfaceId: BrowserSurfaceIdSchema.optional(),
      type: z.literal("navigation.go"),
      url: z.url(),
    }),
    z.strictObject({
      ...browserBase,
      surfaceId: BrowserSurfaceIdSchema.optional(),
      type: z.literal("navigation.back"),
    }),
    z.strictObject({
      ...browserBase,
      surfaceId: BrowserSurfaceIdSchema.optional(),
      type: z.literal("navigation.forward"),
    }),
    z.strictObject({
      ...browserBase,
      surfaceId: BrowserSurfaceIdSchema.optional(),
      type: z.literal("navigation.reload"),
      ignoreCache: z.boolean().optional(),
    }),
    /** Stops the page loading, as a browser's Stop does; offered only while it reports `loading`. */
    z.strictObject({
      ...browserBase,
      surfaceId: BrowserSurfaceIdSchema.optional(),
      type: z.literal("navigation.stop"),
    }),
    z.strictObject({
      ...browserBase,
      type: z.literal("input.pointer"),
      geometryRevision: z.number().int().nonnegative().optional(),
      captureRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
      modifiers: z
        .array(z.enum(["alt", "control", "meta", "shift"]))
        .max(4)
        .optional(),
      buttons: z.number().int().min(0).max(7).optional(),
      targeted: z.boolean().optional(),
      /** Host-issued in editing sessions: names the controller a page write or menu this input causes belongs to. */
      consumerToken: z.uuid().optional(),
      action: z.enum(["down", "move", "up"]),
      button: z.enum(["none", "left", "middle", "right"]),
      clickCount: z.number().int().min(1).max(3).optional(),
      surfaceId: BrowserSurfaceIdSchema,
      viewportHeight: BrowserViewportDimensionSchema,
      viewportWidth: BrowserViewportDimensionSchema,
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
    }),
    z.strictObject({
      ...browserBase,
      type: z.literal("input.wheel"),
      /** Both axes are fractional remote CSS pixels. DOM lines use 16px; pages use the remote viewport per axis. */
      geometryRevision: z.number().int().nonnegative().optional(),
      captureRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
      modifiers: z
        .array(z.enum(["alt", "control", "meta", "shift"]))
        .max(4)
        .optional(),
      targeted: z.boolean().optional(),
      deltaX: z.number().finite().min(-100_000).max(100_000),
      deltaY: z.number().finite().min(-100_000).max(100_000),
      surfaceId: BrowserSurfaceIdSchema,
      viewportHeight: BrowserViewportDimensionSchema,
      viewportWidth: BrowserViewportDimensionSchema,
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
    }),
    z.strictObject({
      ...browserBase,
      type: z.literal("input.cancel"),
      surfaceId: BrowserSurfaceIdSchema.optional(),
    }),
    z.strictObject({
      ...browserBase,
      type: z.literal("input.key"),
      targeted: z.boolean().optional(),
      consumerToken: z.uuid().optional(),
      action: z.enum(["down", "up"]),
      code: z.string().max(100),
      key: z.string().max(100),
      /** `primary`, `location` and `repeat` exist only in editing sessions (`editingVersion`). */
      modifiers: EditingModifiersSchema,
      location: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
      repeat: z.boolean().optional(),
      surfaceId: BrowserSurfaceIdSchema,
      text: z.string().max(10_000).optional(),
    }),
    /** Editing sessions only: what a chord means; the runtime performs its own platform's chord for it. */
    z.strictObject({
      ...browserBase,
      type: z.literal("input.command"),
      targeted: z.boolean().optional(),
      consumerToken: z.uuid().optional(),
      surfaceId: BrowserSurfaceIdSchema,
      command: EditingCommandSchema,
    }),
    /** Editing sessions only: the composition in progress, shown live in the page. */
    z.strictObject({
      ...browserBase,
      type: z.literal("input.compose"),
      targeted: z.boolean().optional(),
      surfaceId: BrowserSurfaceIdSchema,
      composition: EditingCompositionSchema,
    }),
    /** Editing sessions only: a committed composition or a verified replacement. */
    z.strictObject({
      ...browserBase,
      type: z.literal("input.text"),
      targeted: z.boolean().optional(),
      surfaceId: BrowserSurfaceIdSchema,
      edit: EditingTextEditSchema,
    }),
    /**
     * Editing sessions only. The person's copy or cut: the runtime performs its
     * platform's chord with the native editing command inside an isolated
     * clipboard scope and answers `clipboard.result` to this controller.
     */
    z.strictObject({
      ...browserBase,
      type: z.enum(["clipboard.copy", "clipboard.cut"]),
      targeted: z.boolean().optional(),
      consumerToken: z.uuid().optional(),
      surfaceId: BrowserSurfaceIdSchema,
      operationId: EditingClipboardOperationIdSchema,
    }),
    /**
     * Editing sessions only. The person's paste: its bytes follow in
     * `clipboard.part` messages and it runs, in its place in the lane, once all
     * have arrived. Distinct from `clipboard.paste`, which baseline viewers use to type.
     */
    z.strictObject({
      ...browserBase,
      type: z.literal("clipboard.paste-data"),
      targeted: z.boolean().optional(),
      consumerToken: z.uuid().optional(),
      surfaceId: BrowserSurfaceIdSchema,
      operationId: EditingClipboardOperationIdSchema,
      items: EditingClipboardItemsSchema,
    }),
    z.strictObject({
      ...browserBase,
      type: z.literal("clipboard.part"),
      part: EditingClipboardPartSchema,
    }),
    z.strictObject({
      ...browserBase,
      type: z.literal("dialog.respond"),
      accept: z.boolean(),
      /** The dialog the person answers, as `browser.dialog.changed` named it. */
      surfaceId: BrowserSurfaceIdSchema.optional(),
      dialogId: z.uuid(),
      promptText: z.string().max(browserPromptTextMaxLength).optional(),
    }),
    z.strictObject({
      ...browserBase,
      type: z.literal("clipboard.paste"),
      targeted: z.boolean().optional(),
      surfaceId: BrowserSurfaceIdSchema,
      text: z.string().max(browserPasteTextMaxLength),
    }),
    z.strictObject({
      ...browserRequestBase,
      command: BrowserCdpCommandSchema,
      actorToken: z.uuid().optional(),
      type: z.literal("cdp.command"),
    }),
    /**
     * Requires `full-control` access. Returns the live context state through the
     * same exporter the durable profile checkpoint uses; failures arrive as
     * `browser.error`.
     */
    z.strictObject({ ...browserBase, type: z.literal("state.export") }),
    /**
     * Host-only; the Host never relays it from a viewer or an agent. Replaces
     * every cookie the site scope covers (`browserSiteCookieMatches`) with
     * `cookies` in the session's browser context. For a profile-backed session
     * that context is the profile's, so every session on it signs in. The
     * Host-generated `operationId` correlates the `state.import.result` reply.
     */
    z.strictObject({
      ...browserBase,
      cookies: z.array(BrowserCookieSchema).max(maxBrowserSourceCookies),
      operationId: z.uuid(),
      site: BrowserSiteSchema,
      type: z.literal("state.import"),
    }),
    /**
     * Host-only. Asks a Runtime that advertised `signIn` what Opensteer
     * Passwords on its Mac can do for this site,
     * without asking the person.
     */
    z.strictObject({
      ...browserBase,
      probeId: z.uuid(),
      site: BrowserSiteSchema,
      type: z.literal("signin.probe"),
    }),
    /** Host-only. Authorizes field fills without releasing a value to the Host. */
    z.strictObject({
      ...browserBase,
      expiresAt: z.iso.datetime({ offset: true }),
      operationId: z.uuid(),
      requester: PasswordSignInRequesterSchema,
      site: BrowserSiteSchema,
      type: z.literal("login.authorize"),
      workspaceId: WorkspaceIdSchema,
    }),
    z.strictObject({
      ...browserBase,
      operationId: z.uuid(),
      reason: PasswordSignInCancelReasonSchema,
      type: z.literal("login.cancel"),
    }),
  ])
  .superRefine((message, context) => {
    const viewport =
      message.type === "viewport.set" || message.type === "viewport.follow"
        ? message
        : message.type === "surface.open"
          ? message.viewport
          : undefined;
    if (viewport && !browserViewportFits(viewport.width, viewport.height)) {
      context.addIssue({
        code: "custom",
        message: "The browser viewport exceeds the browser frame resource limit.",
      });
    }
  });
export const BrowserClientMessageSchema = z.union([
  BaselineBrowserClientMessageSchema,
  PasskeyCancelSchema,
]);
export type BrowserClientMessage = z.infer<typeof BrowserClientMessageSchema>;

const BrowserSnapshotSchema = z
  .strictObject({
    access: BrowserProfileAccessSchema,
    dialog: BrowserDialogSchema.nullable(),
    ...browserBase,
    sessionId: BrowserSessionIdSchema,
    state: z.literal("ready"),
    passkeys: PasskeyModeSchema.optional(),
    passkeyConsumerToken: z.uuid().optional(),
    targetedStreamingVersion: z.literal(1).optional(),
    inputLanesVersion: z.literal(1).optional(),
    /** Present only when the attach ticket claimed it, and projected only to viewers that opted in. */
    editingVersion: z.union([z.literal(1), z.literal(2)]).optional(),
    /** Only v2 carries this flag; v1 implies an isolated engine clipboard. */
    clipboard: z.boolean().optional(),
    inventoryRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    surfaces: BrowserSurfacesSchema,
    type: z.literal("browser.snapshot"),
  })
  .superRefine((snapshot, context) => {
    if (
      snapshot.editingVersion === 2
        ? snapshot.clipboard === undefined
        : snapshot.clipboard !== undefined
    )
      context.addIssue({
        code: "custom",
        path: ["clipboard"],
        message: "Editing v2 requires an explicit clipboard capability; other versions omit it.",
      });
    const dialog = snapshot.dialog;
    if (dialog && !snapshot.surfaces.some(({ id }) => id === dialog.surfaceId)) {
      context.addIssue({
        code: "custom",
        message: "The browser dialog must reference a surface in the snapshot.",
        path: ["dialog", "surfaceId"],
      });
    }
  });

export const BrowserRuntimeActivitySchema = z.strictObject({
  type: z.literal("browser.activity"),
  actorToken: z.uuid(),
  surfaceId: BrowserSurfaceIdSchema,
  seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  geometryRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  pointer: z.strictObject({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).nullable(),
});
export type BrowserRuntimeActivity = z.infer<typeof BrowserRuntimeActivitySchema>;

const BaselineBrowserServerMessageSchema = z.discriminatedUnion("type", [
  BrowserPasskeyOfferSchema,
  BrowserPasskeyWithdrawnSchema,
  BrowserPasskeyNoticeSchema,
  BrowserRuntimeActivitySchema,
  BrowserSnapshotSchema,
  z.strictObject({
    type: z.literal("browser.workspace-tabs"),
    tabs: z.array(BrowserWorkspaceTabDescriptorSchema).max(64),
    closed: z.array(BrowserSurfaceIdSchema).max(64),
  }),
  z.strictObject({
    ...browserBase,
    surfaces: BrowserSurfacesSchema,
    inventoryRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    type: z.literal("browser.surfaces.changed"),
  }),
  z.strictObject({
    ...browserBase,
    dialog: BrowserDialogSchema.nullable(),
    type: z.literal("browser.dialog.changed"),
    surfaceId: BrowserSurfaceIdSchema.optional(),
  }),
  z.strictObject({
    ...browserBase,
    type: z.literal("browser.status"),
    state: z.enum(["closing", "closed"]),
  }),
  /**
   * The page selection captured when a copy or cut chord reaches the remote
   * browser, so streaming clients can land it on their local clipboard.
   */
  z.strictObject({
    ...browserBase,
    type: z.literal("clipboard.data"),
    consumerToken: z.uuid().optional(),
    surfaceId: BrowserSurfaceIdSchema.optional(),
    text: z.string().min(1).max(1_000_000),
  }),
  /**
   * The editing kinds below exist only in editing sessions and reach only
   * viewers that negotiated a compatible editing version.
   */
  z.strictObject({
    ...browserBase,
    type: z.literal("browser.editing"),
    surfaceId: BrowserSurfaceIdSchema,
    geometryRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    context: EditingContextSchema,
  }),
  /** The outcome of this controller's copy, cut or paste; copied data follows in parts. */
  z.strictObject({
    ...browserBase,
    type: z.literal("clipboard.result"),
    consumerToken: z.uuid().optional(),
    surfaceId: BrowserSurfaceIdSchema,
    operationId: EditingClipboardOperationIdSchema,
    outcome: EditingClipboardOutcomeSchema,
    items: EditingClipboardItemsSchema.optional(),
  }),
  /** What the page wrote to the clipboard because of this controller's input; data follows in parts. */
  z.strictObject({
    ...browserBase,
    type: z.literal("clipboard.written"),
    consumerToken: z.uuid().optional(),
    surfaceId: BrowserSurfaceIdSchema,
    operationId: EditingClipboardOperationIdSchema,
    items: EditingClipboardItemsSchema,
  }),
  z.strictObject({
    ...browserBase,
    type: z.literal("clipboard.part"),
    consumerToken: z.uuid().optional(),
    part: EditingClipboardPartSchema,
  }),
  /** A right-click the page did not handle, for the controller who made it. */
  z.strictObject({
    ...browserBase,
    type: z.literal("browser.contextmenu"),
    consumerToken: z.uuid().optional(),
    surfaceId: BrowserSurfaceIdSchema,
    geometryRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    editable: z.boolean(),
    selection: z.boolean(),
    linkUrl: z.string().max(browserWorkspaceTabUrlMaxLength).optional(),
  }),
  z.strictObject({
    ...browserBase,
    type: z.literal("browser.stream.state"),
    surfaceId: BrowserSurfaceIdSchema,
    state: z.enum(["admitted", "capacity"]),
  }),
  z.strictObject({
    ...browserBase,
    type: z.literal("browser.error"),
    error: ProtocolErrorSchema,
  }),
  z.strictObject({
    ...browserRequestBase,
    result: BrowserCdpResultSchema,
    type: z.literal("cdp.result"),
  }),
  z.strictObject({
    ...browserBase,
    event: BrowserCdpEventSchema,
    type: z.literal("cdp.event"),
  }),
  z.strictObject({
    ...browserRequestBase,
    error: ProtocolErrorSchema,
    type: z.literal("cdp.error"),
  }),
  z.strictObject({
    ...browserBase,
    snapshot: BrowserProfileSnapshotSchema,
    type: z.literal("state.exported"),
  }),
  z.strictObject({
    ...browserBase,
    error: ProtocolErrorSchema.nullable(),
    operationId: z.uuid(),
    type: z.literal("state.import.result"),
  }),
  z.strictObject({
    ...browserBase,
    passwords: PasswordSignInAvailabilitySchema,
    probeId: z.uuid(),
    type: z.literal("signin.probe.result"),
  }),
  z.strictObject({
    ...browserBase,
    need: z.literal("approval").nullable(),
    operationId: z.uuid(),
    type: z.literal("login.needs"),
  }),
  z.strictObject({
    ...browserBase,
    operationId: z.uuid(),
    outcome: LoginAuthorizationOutcomeSchema,
    type: z.literal("login.result"),
  }),
  z.strictObject({
    ...browserBase,
    operationId: z.uuid(),
    type: z.literal("login.ended"),
  }),
]);
export const BrowserServerMessageSchema = z.union([
  BaselineBrowserServerMessageSchema,
  PasskeyCeremonySchema,
  PasskeyRuntimeCancelSchema,
  BrowserPasskeyRequestSchema,
]);
export type BrowserServerMessage = z.infer<typeof BrowserServerMessageSchema>;

/** Top-left page-DIP region, independent of the full ledger layout. */
export const BrowserCaptureDescriptorSchema = z.strictObject({
  width: BrowserViewportDimensionSchema,
  height: BrowserViewportDimensionSchema,
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type BrowserCaptureDescriptor = z.infer<typeof BrowserCaptureDescriptorSchema>;

export const BrowserBinaryFrameHeaderSchema = z
  .strictObject({
    capture: BrowserCaptureDescriptorSchema.optional(),
    encoding: z.enum(["jpeg", "png", "webp"]),
    frameId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    geometryRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    rasterHeight: z.number().int().positive().max(browserFrameLimits.maxHeight),
    rasterWidth: z.number().int().positive().max(browserFrameLimits.maxWidth),
    surfaceId: BrowserSurfaceIdSchema,
    viewportHeight: BrowserViewportDimensionSchema,
    viewportWidth: BrowserViewportDimensionSchema,
    /**
     * Present only on Watch frames. The viewer echoes it in `stream.ack` once it
     * is done with the picture, shown or dropped; that is the credit for the next.
     */
    watchToken: z.uuid().optional(),
  })
  .refine(
    (header) =>
      !header.capture ||
      (header.capture.width <= header.viewportWidth &&
        header.capture.height <= header.viewportHeight &&
        header.geometryRevision !== undefined),
    "The browser capture region must fit its layout and name its geometry revision.",
  );
export type BrowserBinaryFrameHeader = z.infer<typeof BrowserBinaryFrameHeaderSchema>;
/**
 * How the Host ends a browser viewer socket. A viewer reconnects after any
 * close except the two final ones: a message the protocol does not allow, and
 * a person who can no longer see the session.
 */
export const browserViewerCloseCodes = {
  /** The login that opened the socket ended or expired; reconnect with the current one. */
  loginEnded: 1008,
  /** The viewer could not be served for now: it fell behind, or access could not be read. */
  tryAgain: 1013,
  protocolViolation: 4002,
  accessEnded: 4003,
} as const;

/** A profile is portable identity state. It is not owned by any execution location. */
export const BrowserProfileSchema = z.object({
  id: BrowserProfileIdSchema,
  name: z.string().min(1).max(120),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type BrowserProfile = z.infer<typeof BrowserProfileSchema>;

/**
 * Which computer runs a Browser Session. Every browser belongs to a Runner, so
 * there is one kind of placement and it names a machine, not a category of
 * machine.
 */
export const BrowserPlacementSelectorSchema = z.strictObject({
  kind: z.literal("runner"),
  runnerId: RunnerIdSchema,
});
const BrowserPlacementSelectorViewSchema = z.object(BrowserPlacementSelectorSchema.shape);
export type BrowserPlacementSelector = z.infer<typeof BrowserPlacementSelectorSchema>;

export const BrowserPlacementSchema = z.object({
  available: z.boolean(),
  /**
   * The work locations this computer also runs agents on. Default placement
   * follows it, which is now an enrolled fact rather than a claim the machine
   * made about itself.
   */
  environmentIds: z.array(EnvironmentIdSchema).max(100),
  kind: z.literal("runner"),
  label: z.string().min(1).max(120),
  runnerId: RunnerIdSchema,
  runtimeId: z.string().min(1).max(255).nullable(),
  unavailableReason: z.string().trim().min(1).max(500).optional(),
});
export type BrowserPlacement = z.infer<typeof BrowserPlacementSchema>;

export const HostedBrowserSessionStateSchema = z.enum([
  "starting",
  "ready",
  "closing",
  "closed",
  "failed",
]);
export type HostedBrowserSessionState = z.infer<typeof HostedBrowserSessionStateSchema>;

/** The most Runs one session reports as attached; the most recent are kept. */
export const browserSessionMaxAttachedRuns = 128;

/**
 * The most conversations the catalog names for one session; the most recently
 * active are kept.
 */
export const browserSessionMaxThreads = 16;

/**
 * Where a page is, as a person may see it at a glance: the origin of a web
 * page, `about:` pages whole, and only the scheme of anything else, so a local
 * file's path or a page's query never leaves the browser this way.
 */
export function browserPageSite(address: string): string {
  try {
    const url = new URL(address);
    if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
    if (url.protocol === "about:") return url.href.slice(0, 2048);
    return url.protocol;
  } catch {
    return "";
  }
}

/**
 * One durable use of a browser by a conversation: its membership (no Run, no
 * page), a page a person included (no Run), or a page a Run used. The title
 * and site are what the page showed at that use, so a link to a browser that
 * has since ended can still say which site it was.
 */
export const BrowserSessionUseSchema = z.object({
  threadId: ThreadIdSchema,
  runId: RunIdSchema.nullable(),
  tabId: BrowserSurfaceIdSchema.nullable().optional(),
  firstUsedAt: IsoDateTimeSchema,
  lastUsedAt: IsoDateTimeSchema,
  pageTitle: z.string().max(256).nullable().optional(),
  /** The page's origin (scheme, host and port), never its path or query. */
  pageSite: z.string().max(2048).nullable().optional(),
});
export type BrowserSessionUse = z.infer<typeof BrowserSessionUseSchema>;

export const browserUsageRunBatchSize = 16;
/**
 * The most distinct pages one Run, or the people in a conversation, report for
 * one session; the most recently used are kept.
 */
export const browserUsageTabsPerRun = 8;
export const BrowserSessionUsageProjectionSchema = BrowserSessionUseSchema.extend({
  sessionId: BrowserSessionIdSchema,
});
export type BrowserSessionUsageProjection = z.infer<typeof BrowserSessionUsageProjectionSchema>;
export const ThreadBrowserUsageSchema = z.object({
  threadId: ThreadIdSchema,
  // Per session in the bounded catalog the client already holds: one
  // membership, the latest pages people included, and the latest
  // `browserUsageTabsPerRun` pages each requested Run used.
  uses: z
    .array(BrowserSessionUsageProjectionSchema)
    .max(100 * ((browserUsageRunBatchSize + 1) * browserUsageTabsPerRun + 1)),
});

export const BrowserPagePresenceSchema = z.object({
  title: z.string().max(256),
  url: z.string().max(2048),
});
export type BrowserPagePresence = z.infer<typeof BrowserPagePresenceSchema>;

/**
 * The fast-changing facts about one browser a person can see: what page it
 * shows and whether an agent is acting in it. They travel on their own small
 * message so a navigation never makes a client reread its Workspace.
 */
export const BrowserPresenceSchema = z.object({
  acting: z.boolean(),
  page: BrowserPagePresenceSchema.nullable(),
  sessionId: BrowserSessionIdSchema,
});
export type BrowserPresence = z.infer<typeof BrowserPresenceSchema>;

export const BrowserContextEligibilitySchema = z.enum(["eligible", "blocked", "unknown"]);
export const BrowserTabIconRefSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const BrowserTabSummarySchema = z.strictObject({
  canGoBack: z.boolean().optional(),
  canGoForward: z.boolean().optional(),
  id: BrowserSurfaceIdSchema,
  title: z.string().max(256),
  site: z
    .string()
    .max(2048)
    .refine((site) => site === browserPageSite(site), "Only a page origin may enter the catalog."),
  iconRef: BrowserTabIconRefSchema.nullable(),
  order: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  openerId: BrowserSurfaceIdSchema.nullable(),
  availability: z.enum(["ready", "starting", "unavailable"]),
  /** The tab's page is loading (its surface's `loading`); absent while it is not. */
  loading: z.boolean().optional(),
  documentId: z.string().min(1).max(255).nullable().default(null),
  occupants: z
    .array(PlaceOccupantSchema)
    .max(browserSessionMaxThreads)
    .refine(
      (occupants) => new Set(occupants.map(({ threadId }) => threadId)).size === occupants.length,
      "Occupant threads must be unique.",
    ),
});
export type BrowserTabSummary = z.infer<typeof BrowserTabSummarySchema>;
// Includes the worst-case escaped strings and all 64 × 16 occupants.
export const browserTabCatalogMaxBytes = 2 * 1024 * 1024;
export const browserCaptureMaxTargets = 8;
export const BrowserTabCatalogSchema = z
  .strictObject({
    generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    inventoryRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    tabs: z.array(BrowserTabSummarySchema).max(64),
  })
  .superRefine((catalog, context) => {
    const ids = new Set(catalog.tabs.map(({ id }) => id));
    if (
      ids.size !== catalog.tabs.length ||
      new Set(catalog.tabs.map(({ order }) => order)).size !== catalog.tabs.length
    )
      context.addIssue({
        code: "custom",
        message: "Tab identities and insertion orders must be unique.",
      });
    for (const tab of catalog.tabs) {
      if (tab.openerId !== null && (!ids.has(tab.openerId) || tab.openerId === tab.id))
        context.addIssue({
          code: "custom",
          message: "An opener must be another tab in the session.",
        });
    }
    if (new TextEncoder().encode(JSON.stringify(catalog)).byteLength > browserTabCatalogMaxBytes)
      context.addIssue({ code: "custom", message: "Tab catalog exceeds its 2 MiB byte budget." });
  });
export type BrowserTabCatalog = z.infer<typeof BrowserTabCatalogSchema>;
export const BrowserTabSummaryViewSchema = z.object(BrowserTabSummarySchema.shape);
export const BrowserTabCatalogViewSchema = z
  .object({
    ...BrowserTabCatalogSchema.shape,
    tabs: z.array(BrowserTabSummaryViewSchema).max(64),
  })
  .superRefine((catalog, context) => {
    const parsed = BrowserTabCatalogSchema.safeParse(catalog);
    if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue({ ...issue });
  });
export const BrowserTabsChangedSchema = z.object({
  type: z.literal("host.browser-tabs-changed"),
  sessionId: BrowserSessionIdSchema,
  catalog: BrowserTabCatalogViewSchema,
});
export type BrowserTabsChanged = z.infer<typeof BrowserTabsChangedSchema>;
export const BrowserTabCatalogInputSchema = z.strictObject({ sessionId: BrowserSessionIdSchema });
export const BrowserTabIconInputSchema = z.strictObject({
  sessionId: BrowserSessionIdSchema,
  iconRef: BrowserTabIconRefSchema,
});
export const BrowserTabIconResultSchema = z.object({ favicon: BrowserFaviconSchema.nullable() });
export type BrowserTabIconInput = z.infer<typeof BrowserTabIconInputSchema>;
export type BrowserTabIconResult = z.infer<typeof BrowserTabIconResultSchema>;

export const browserHostMethods = {
  openTab: "Opensteer.openTab",
  closeTab: "Opensteer.closeTab",
  contextCandidate: "Opensteer.contextCandidate",
} as const;
export const browserBootstrapSessionsMaxBytes = 768 * 1024;
export const TargetedBrowserClientMessageSchema = BrowserClientMessageSchema.superRefine(
  (message, context) => {
    if (
      (message.type === "input.wheel" ||
        (message.type === "input.pointer" && message.action !== "up")) &&
      (message.geometryRevision === undefined || message.modifiers === undefined)
    )
      context.addIssue({
        code: "custom",
        message: "Targeted input requires the drawn geometry revision and modifiers (epoch 41).",
      });
    if (message.type === "surface.close")
      context.addIssue({
        code: "custom",
        message: "Close tabs through the authoritative browser.tab.close Host command.",
      });
    if (
      [
        "stream.subscribe",
        "stream.unsubscribe",
        "stream.ack",
        "navigation.go",
        "navigation.back",
        "navigation.forward",
        "navigation.reload",
        "navigation.stop",
        "dialog.respond",
      ].includes(message.type) &&
      (!("surfaceId" in message) || !message.surfaceId)
    )
      context.addIssue({ code: "custom", message: "A targeted page command requires surfaceId." });
  },
);
export type TargetedBrowserClientMessage = z.infer<typeof TargetedBrowserClientMessageSchema>;

export const BrowserSessionOpenerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("you") }),
  z.object({ kind: z.literal("task"), threadId: ThreadIdSchema }),
  z.object({ kind: z.literal("opensteer") }),
  z.object({ kind: z.literal("automation") }),
  z.object({ kind: z.literal("unknown") }),
]);
export type BrowserSessionOpener = z.infer<typeof BrowserSessionOpenerSchema>;
export const BrowserSessionOpenerRecordSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("person"), userId: UserIdSchema }),
  z.strictObject({ kind: z.literal("task"), threadId: ThreadIdSchema, runId: RunIdSchema }),
  z.strictObject({ kind: z.literal("opensteer"), threadId: ThreadIdSchema }),
  z.strictObject({ kind: z.literal("automation") }),
]);
export type BrowserSessionOpenerRecord = z.infer<typeof BrowserSessionOpenerRecordSchema>;
export function projectBrowserSessionOpener(
  opener: BrowserSessionOpenerRecord | null,
  reader: { readonly userId: string; readonly visibleThreadIds: ReadonlySet<string> },
): BrowserSessionOpener {
  if (!opener) return { kind: "unknown" };
  if (opener.kind === "person")
    return { kind: opener.userId === reader.userId ? "you" : "unknown" };
  if (opener.kind === "task")
    return reader.visibleThreadIds.has(opener.threadId)
      ? { kind: "task", threadId: opener.threadId }
      : { kind: "unknown" };
  if (opener.kind === "opensteer")
    return reader.visibleThreadIds.has(opener.threadId)
      ? { kind: "opensteer" }
      : { kind: "unknown" };
  return opener;
}
export const HostedBrowserSessionSchema = z.object({
  navigationVersion: z.literal(1).optional(),
  workspaceTabRestoreVersion: z.literal(1).optional(),
  opener: BrowserSessionOpenerSchema.optional(),
  access: BrowserProfileAccessSchema,
  createdAt: IsoDateTimeSchema,
  id: BrowserSessionIdSchema,
  origin: z.enum(["agent", "trigger", "workspace"]),
  placement: BrowserPlacementSelectorViewSchema,
  /** Null exactly for a fresh session: no identity, no durable state. */
  profileId: BrowserProfileIdSchema.nullable(),
  runtimeId: z.string().min(1).max(255),
  state: HostedBrowserSessionStateSchema,
  tabCatalog: BrowserTabCatalogViewSchema.optional(),
  attachedRunIds: z.array(RunIdSchema).max(browserSessionMaxAttachedRuns).optional(),
  /**
   * An agent is acting in this browser now: it sent a command within the last
   * few seconds. Attachment only says a Run may use it; this says one is.
   */
  acting: z.boolean().optional(),
  /** The page the person sees: its title and site (origin), never path or query. */
  page: BrowserPagePresenceSchema.nullable().optional(),
  /**
   * The conversations using this browser that the reader can open, most
   * recently active first. Which pages each Run used is read per conversation.
   */
  threadIds: z.array(ThreadIdSchema).max(browserSessionMaxThreads).optional(),
  updatedAt: IsoDateTimeSchema,
  workspaceId: WorkspaceIdSchema,
});
export type HostedBrowserSession = z.infer<typeof HostedBrowserSessionSchema>;

// Which Runs are attached is for a person's view of live work. An agent reads
// `attached`, and an older Runner's strict reply schema refuses an unknown key.
export const AgentBrowserSessionSummarySchema = HostedBrowserSessionSchema.omit({
  navigationVersion: true,
  workspaceTabRestoreVersion: true,
  acting: true,
  opener: true,
  tabCatalog: true,
  attachedRunIds: true,
  page: true,
  threadIds: true,
}).safeExtend({
  activeAttachmentCount: z.number().int().nonnegative().max(128),
  attached: z.boolean(),
  profileName: z.string().min(1).max(120).nullable(),
});
export type AgentBrowserSessionSummary = z.infer<typeof AgentBrowserSessionSummarySchema>;

export const WorkspaceTabLineageSchema = z.object({
  unavailableReason: z.string().max(1000).optional(),
  id: BrowserSessionIdSchema,
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  createdAt: IsoDateTimeSchema,
  session: HostedBrowserSessionSchema,
  tabs: z
    .array(
      z.object({
        kind: z.literal("browser"),
        id: BrowserSurfaceIdSchema,
        sessionId: BrowserSessionIdSchema,
        title: z.string().max(256),
        site: BrowserTabSummarySchema.shape.site,
        iconRef: BrowserTabIconRefSchema.nullable().optional(),
        order: BrowserTabSummarySchema.shape.order,
        openerId: BrowserSurfaceIdSchema.nullable(),
        state: z.enum(["suspended", "restoring", "live"]),
        /** When the Host recorded the tab, which places a tab with no saved place. */
        createdAt: IsoDateTimeSchema.optional(),
      }),
    )
    .max(64)
    .optional(),
});
export type WorkspaceTabLineage = z.infer<typeof WorkspaceTabLineageSchema>;
export const WorkspaceTabsInputSchema = z.strictObject({ groupId: BrowserSessionIdSchema });
export const WorkspaceTabActivateCommandSchema = z.strictObject({
  type: z.literal("workspace.tab.activate"),
  tabId: BrowserSurfaceIdSchema,
  idempotencyKey: z.string().min(1).max(255),
});
export const WorkspaceTabActivateResultSchema = z.object({
  type: z.literal("workspace.tab.activate"),
  group: WorkspaceTabLineageSchema,
  session: HostedBrowserSessionSchema,
  tabId: BrowserSurfaceIdSchema,
  catalog: BrowserTabCatalogViewSchema,
});
export const WorkspaceTabCloseCommandSchema = z.strictObject({
  type: z.literal("workspace.tab.close"),
  tabId: BrowserSurfaceIdSchema,
  idempotencyKey: z.string().min(1).max(255),
});
export const WorkspaceTabCloseResultSchema = z.object({
  type: z.literal("workspace.tab.close"),
  group: WorkspaceTabLineageSchema,
});

export const WorkspaceTabReopenCommandSchema = z.strictObject({
  type: z.literal("workspace.tab.reopen"),
  idempotencyKey: z.string().min(1).max(255),
});

/**
 * Tab groups are each person's own organization of their saved tabs, as
 * Chrome's are: a title, one of Chrome's nine colours and collapse, with a tab
 * in at most one of a person's groups. A group may hold tabs of any session,
 * profile, computer or Workspace the person can see, and grants nothing:
 * reaching a tab still follows its session. Unrelated to a tab's lineage.
 */
export const BrowserTabGroupSchema = z.object({
  id: BrowserTabGroupIdSchema,
  title: z.string().max(browserTabGroupTitleMaxLength),
  // A colour a later release adds reads as grey rather than refusing the layout.
  color: BrowserTabGroupColorSchema.catch("grey"),
  collapsed: z.boolean(),
  /** The member tabs this reader can see, in no particular order. */
  tabIds: BrowserTabGroupTabIdsSchema,
});
export type BrowserTabGroup = z.infer<typeof BrowserTabGroupSchema>;
/** One person's tab groups. The revision orders layouts; a higher one replaces a lower. */
export const BrowserTabLayoutSchema = z.object({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  groups: z.array(BrowserTabGroupSchema).max(browserTabGroupsMaxPerOwner),
  /**
   * The person's saved order of the tabs they can see, groups adjacent, from a
   * Host that accepts `workspace.tabs.move`. Tabs not in it take the place
   * `resolveBrowserTabOrder` gives them, on the Host and every client alike.
   */
  order: z.array(BrowserSurfaceIdSchema).max(browserTabOrderMaxTabs).optional(),
});
export type BrowserTabLayout = z.infer<typeof BrowserTabLayoutSchema>;
export const WorkspaceTabReopenResultSchema = z.object({
  type: z.literal("workspace.tab.reopen"),
  group: WorkspaceTabLineageSchema,
  tabId: BrowserSurfaceIdSchema,
  layout: BrowserTabLayoutSchema,
});
export const WorkspaceTabsGroupCommandSchema = z.strictObject({
  type: z.literal("workspace.tabs.group"),
  tabIds: BrowserTabGroupTabIdsSchema,
  /** The group the tabs join; without it they form a new group with this title and colour. */
  groupId: BrowserTabGroupIdSchema.optional(),
  title: BrowserTabGroupTitleSchema.optional(),
  color: BrowserTabGroupColorSchema.optional(),
  idempotencyKey: z.string().min(1).max(255),
});
export const WorkspaceTabsGroupResultSchema = z.object({
  type: z.literal("workspace.tabs.group"),
  groupId: BrowserTabGroupIdSchema,
  layout: BrowserTabLayoutSchema,
});
export const WorkspaceTabsMoveCommandSchema = BrowserTabMoveSchema.safeExtend({
  type: z.literal("workspace.tabs.move"),
  idempotencyKey: z.string().min(1).max(255),
});
export const WorkspaceTabsMoveResultSchema = z.object({
  type: z.literal("workspace.tabs.move"),
  layout: BrowserTabLayoutSchema,
});
export const WorkspaceTabsUngroupCommandSchema = z.strictObject({
  type: z.literal("workspace.tabs.ungroup"),
  tabIds: BrowserTabGroupTabIdsSchema,
  idempotencyKey: z.string().min(1).max(255),
});
export const WorkspaceTabsUngroupResultSchema = z.object({
  type: z.literal("workspace.tabs.ungroup"),
  layout: BrowserTabLayoutSchema,
});
export const WorkspaceTabGroupUpdateCommandSchema = z.strictObject({
  type: z.literal("workspace.tabGroup.update"),
  groupId: BrowserTabGroupIdSchema,
  title: BrowserTabGroupTitleSchema.optional(),
  color: BrowserTabGroupColorSchema.optional(),
  collapsed: z.boolean().optional(),
  idempotencyKey: z.string().min(1).max(255),
});
export const WorkspaceTabGroupUpdateResultSchema = z.object({
  type: z.literal("workspace.tabGroup.update"),
  layout: BrowserTabLayoutSchema,
});
/** Closes exactly these tabs, each as `workspace.tab.close` would; one failing leaves the rest closed. */
export const WorkspaceTabsCloseCommandSchema = z.strictObject({
  type: z.literal("workspace.tabs.close"),
  tabIds: BrowserTabGroupTabIdsSchema,
  idempotencyKey: z.string().min(1).max(255),
});
const BrowserTabCloseFailureSchema = z.object({
  tabId: BrowserSurfaceIdSchema,
  message: z.string().max(1_000),
});
export const WorkspaceTabsCloseResultSchema = z.object({
  type: z.literal("workspace.tabs.close"),
  closed: z.array(BrowserSurfaceIdSchema).max(browserTabGroupMaxTabs),
  failed: z.array(BrowserTabCloseFailureSchema).max(browserTabGroupMaxTabs),
});

/**
 * An agent's view of the tabs it can reach, open and asleep, a page at a time.
 * Every page lists all of the groups it may see: a group shows only when the
 * agent can reach every one of its tabs.
 */
export const BrowserTabReadResultSchema = z.object({
  groups: z
    .array(
      z.object({
        id: BrowserTabGroupIdSchema,
        title: z.string().max(browserTabGroupTitleMaxLength),
        color: BrowserTabGroupColorSchema,
        collapsed: z.boolean(),
        createdBy: z.enum(["person", "this-task", "another-task"]),
        tabCount: z.number().int().min(1).max(browserTabGroupMaxTabs),
      }),
    )
    .max(browserTabGroupsMaxPerOwner),
  tabs: z
    .array(
      z.object({
        tabId: BrowserSurfaceIdSchema,
        title: z.string().max(256),
        site: z.string().max(2_048),
        /** `open` tabs have a live session to drive; restore an `asleep` one first. */
        state: z.enum(["open", "opening", "asleep"]),
        sessionId: BrowserSessionIdSchema.nullable(),
        /** The profile this tab's lineage browses as; null is Guest, for open, opening and asleep tabs. */
        profileId: BrowserProfileIdSchema.nullable(),
        groupId: BrowserTabGroupIdSchema.nullable(),
        /** Where the tab stands in the person's order, counting only the tabs you can reach. */
        position: z.number().int().nonnegative().optional(),
        usedByThisTask: z.boolean(),
        usedByOtherTask: z.boolean(),
      }),
    )
    .max(1_000),
  nextCursor: z.string().min(1).max(512).nullable(),
});
export type BrowserTabReadResult = z.infer<typeof BrowserTabReadResultSchema>;
export const browserTabRestoreMaxTabs = 8;
export const BrowserTabWriteResultSchema = z.object({
  action: BrowserTabWriteInputSchema.shape.action,
  /** The group the tabs joined, for `group`. */
  groupId: BrowserTabGroupIdSchema.optional(),
  closed: z.array(BrowserSurfaceIdSchema).max(browserTabGroupMaxTabs).optional(),
  failed: z.array(BrowserTabCloseFailureSchema).max(browserTabGroupMaxTabs).optional(),
  /** Each restored tab's live session, attached to this Run for Browser Harness. */
  restored: z
    .array(z.object({ tabId: BrowserSurfaceIdSchema, sessionId: BrowserSessionIdSchema }))
    .max(browserTabRestoreMaxTabs)
    .optional(),
});
export type BrowserTabWriteResult = z.infer<typeof BrowserTabWriteResultSchema>;

export const HostedBrowserBootstrapSchema = z.object({
  workspaceTabRestoreVersion: z.literal(1).optional(),
  workspaceTabs: z.array(WorkspaceTabLineageSchema).max(100).optional(),
  /** 1 when this Host keeps tab groups and accepts their commands; clients show groups only then. */
  tabGroupsVersion: z.number().int().positive().optional(),
  tabGroups: BrowserTabLayoutSchema.optional(),
  profileGrants: z.array(BrowserProfileGrantSchema).max(100),
  available: z.boolean(),
  placements: z.array(BrowserPlacementSchema).max(129),
  profiles: z.array(BrowserProfileSchema).max(128),
  sessions: z
    .array(HostedBrowserSessionSchema)
    .max(100)
    .refine(
      (sessions) =>
        new TextEncoder().encode(JSON.stringify(sessions)).byteLength <=
        browserBootstrapSessionsMaxBytes,
      "Browser catalog exceeds its bootstrap byte budget.",
    ),
});
export type HostedBrowserBootstrap = z.infer<typeof HostedBrowserBootstrapSchema>;

export const CreateBrowserProfileGrantResponseSchema = z.object({
  grant: BrowserProfileGrantSchema,
});

export const CreateBrowserProfileBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
});

export const CreateBrowserProfileResponseSchema = z.object({
  profile: BrowserProfileSchema,
});

export const SaveBrowserSessionProfileBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
});

export const SaveBrowserSessionProfileResponseSchema = z.object({
  profile: BrowserProfileSchema,
});

const startHostedBrowserBase = {
  threadId: ThreadIdSchema.optional(),
  initialUrl: z.url().optional(),
  placement: BrowserPlacementSelectorSchema.optional(),
  reuseExisting: z.boolean().default(false),
  /**
   * The size of the view the person will read the browser in. Its first page
   * takes it before the first navigation, so the site loads at that size.
   */
  viewport: z
    .strictObject({
      height: z.number().int().positive().max(browserFrameLimits.maxHeight),
      width: z.number().int().positive().max(browserFrameLimits.maxWidth),
    })
    .refine((viewport) => browserViewportFits(viewport.width, viewport.height), {
      message: "The browser viewport exceeds the browser frame resource limit.",
    })
    .optional(),
} as const;

/** Identity is explicit at open: exactly one of a profile or fresh, never defaulted. */
export const StartHostedBrowserBodySchema = z.union([
  z.strictObject({ ...startHostedBrowserBase, profileId: BrowserProfileIdSchema }),
  z.strictObject({ ...startHostedBrowserBase, fresh: z.literal(true) }),
]);

export const StartHostedBrowserResponseSchema = z.object({
  session: HostedBrowserSessionSchema,
  wasExisting: z.boolean(),
});

interface DecodedBrowserFrameEnvelope {
  readonly data: Uint8Array;
  readonly header: BrowserBinaryFrameHeader;
}

const browserFrameHeaderLimit = 16_384;

/**
 * Decodes the binary envelope shared by Browser Runtime, Host, and clients.
 * The returned image bytes are a zero-copy view of the input.
 */
export function readBrowserFrameHeader(envelope: Uint8Array): BrowserBinaryFrameHeader {
  if (
    envelope.byteLength < 5 ||
    envelope.byteLength > 16 * 1024 * 1024 + browserFrameHeaderLimit + 4
  )
    throw new Error("Invalid frame size.");
  const headerLength = new DataView(
    envelope.buffer,
    envelope.byteOffset,
    envelope.byteLength,
  ).getUint32(0, false);
  if (
    headerLength < 2 ||
    headerLength > browserFrameHeaderLimit ||
    4 + headerLength >= envelope.byteLength
  )
    throw new Error("Invalid frame header size.");
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(envelope.subarray(4, 4 + headerLength)),
    );
  } catch (error) {
    throw new Error("The binary browser frame header is invalid JSON.", { cause: error });
  }
  return BrowserBinaryFrameHeaderSchema.parse(decoded);
}

export function decodeBrowserFrameEnvelope(
  envelope: Uint8Array,
  maximumImageBytes = 16 * 1_024 * 1_024,
): DecodedBrowserFrameEnvelope {
  if (
    envelope.byteLength < 5 ||
    envelope.byteLength > maximumImageBytes + browserFrameHeaderLimit + 4
  ) {
    throw new Error("The binary browser frame has an invalid size.");
  }
  const view = new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength);
  const headerLength = view.getUint32(0, false);
  if (
    headerLength < 2 ||
    headerLength > browserFrameHeaderLimit ||
    4 + headerLength >= envelope.byteLength
  ) {
    throw new Error("The binary browser frame header has an invalid size.");
  }
  const header = readBrowserFrameHeader(envelope);
  const data = envelope.subarray(4 + headerLength);
  if (
    data.byteLength < 1 ||
    data.byteLength > maximumImageBytes ||
    !matchesImageEncoding(data, header.encoding)
  ) {
    throw new Error("The binary browser frame image does not match its encoding.");
  }
  return { data, header };
}

function matchesImageEncoding(
  data: Uint8Array,
  encoding: BrowserBinaryFrameHeader["encoding"],
): boolean {
  if (encoding === "jpeg") return data.byteLength >= 2 && data[0] === 0xff && data[1] === 0xd8;
  if (encoding === "png") {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10] as const;
    return (
      data.byteLength >= signature.length && signature.every((byte, index) => data[index] === byte)
    );
  }
  return (
    data.byteLength >= 12 &&
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  );
}

export const BrowserContextCandidateInputSchema = z.strictObject({
  sessionId: BrowserSessionIdSchema,
  tabId: BrowserSurfaceIdSchema,
});
/**
 * A tab's current page as a message would carry it: its exact document, title
 * and full bounded address, read from the page itself.
 */
export const BrowserContextCandidateSchema = z.object({
  sessionId: BrowserSessionIdSchema,
  tabId: BrowserSurfaceIdSchema,
  documentId: z.string().min(1).max(255),
  title: z.string().max(256),
  url: z.string().max(2048),
  // Read only by the previous release, which took a page as automatic context
  // only when it was `eligible`; see `previousReleaseEligibility`.
  eligibility: BrowserContextEligibilitySchema.optional(),
  reason: z
    .enum(["form", "sign-in", "inaccessible-frame", "frame-churn", "timeout", "unavailable"])
    .nullable()
    .optional(),
  checkedAt: IsoDateTimeSchema.optional(),
});
export type BrowserContextCandidate = z.infer<typeof BrowserContextCandidateSchema>;
/**
 * The fields Hosts and clients of the previous release require on a candidate.
 * Every page may be included automatically, so a candidate always says so.
 */
export function previousReleaseEligibility(checkedAt: Date) {
  return { eligibility: "eligible", reason: null, checkedAt: checkedAt.toISOString() } as const;
}
export type BrowserContextCandidateInput = z.infer<typeof BrowserContextCandidateInputSchema>;
export const BrowserOpenIdentitySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("profile"), profileId: BrowserProfileIdSchema }),
  z.strictObject({ kind: z.literal("guest") }),
]);
export type BrowserOpenIdentity = z.infer<typeof BrowserOpenIdentitySchema>;
const browserTabOpenFields = {
  type: z.literal("browser.tab.open"),
  viewport: z
    .strictObject({ width: BrowserViewportDimensionSchema, height: BrowserViewportDimensionSchema })
    .refine(
      (viewport) => browserFrameFits(viewport.width, viewport.height),
      "The viewport exceeds frame limits.",
    )
    .optional(),
  url: z
    .url()
    .max(8192)
    .refine((value) => {
      const url = new URL(value);
      return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
    }, "Only HTTP and HTTPS addresses without credentials may open.")
    .optional(),
  idempotencyKey: z.string().min(1).max(255),
};
export const BrowserSessionTabOpenCommandSchema = z.strictObject({
  ...browserTabOpenFields,
  sessionId: BrowserSessionIdSchema,
});
/** Main Workspace is implied by the authenticated reader, never supplied by the UI. */
export const BrowserIdentityTabOpenCommandSchema = z.strictObject({
  ...browserTabOpenFields,
  identity: BrowserOpenIdentitySchema,
  placement: BrowserPlacementSelectorSchema.optional(),
});
export const BrowserTabOpenCommandSchema = z
  .strictObject({
    ...browserTabOpenFields,
    sessionId: BrowserSessionIdSchema.optional(),
    identity: BrowserOpenIdentitySchema.optional(),
    placement: BrowserPlacementSelectorSchema.optional(),
  })
  .refine(
    (command) =>
      (command.sessionId !== undefined) !== (command.identity !== undefined) &&
      (command.placement === undefined || command.identity !== undefined),
    "Supply exactly one session or identity target; placement requires an identity.",
  );
export type BrowserTabOpenTarget =
  | Pick<z.infer<typeof BrowserSessionTabOpenCommandSchema>, "sessionId">
  | Pick<z.infer<typeof BrowserIdentityTabOpenCommandSchema>, "identity" | "placement">;
export const BrowserTabOpenResultSchema = z
  .object({
    type: z.literal("browser.tab.open"),
    sessionId: BrowserSessionIdSchema,
    tabId: BrowserSurfaceIdSchema,
    catalog: BrowserTabCatalogViewSchema,
    browserStarted: z.boolean(),
    /** Authorized adoption view, including the originally chosen initial-page outcome on replay. */
    session: HostedBrowserSessionSchema,
  })
  .refine(
    (result) => result.session.id === result.sessionId,
    "The adopted session must match the opened browser.",
  );
export type BrowserTabOpenCommand = z.infer<typeof BrowserTabOpenCommandSchema>;
export type BrowserTabOpenResult = z.infer<typeof BrowserTabOpenResultSchema>;
export const browserTabOpenClosedReason = "browser-session-closed";
export const BrowserTabOpenRefusalReasonSchema = z.enum([
  browserTabOpenClosedReason,
  "browser-session-unavailable",
  "browser-profile-unavailable",
  "browser-placement-unavailable",
  "browser-placement-ambiguous",
  "browser-tab-open-outcome-unknown",
]);
export type BrowserTabOpenRefusalReason = z.infer<typeof BrowserTabOpenRefusalReasonSchema>;
/** Host bindings live at least 24 hours; one older successful binding per identity retains placement. */
export const browserTabOpenReplayWindowMs = 24 * 60 * 60_000;
/** Durable Host binding written before the selected browser/initial-page operation can run. */
export const BrowserTabOpenBindingSchema = z.strictObject({
  callerUserId: UserIdSchema,
  idempotencyKey: z.string().min(1).max(255),
  requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  chosenSessionId: BrowserSessionIdSchema,
  browserStarted: z.boolean(),
  initialPageOperationKey: z.string().min(1).max(255),
  outcome: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("pending") }),
    z.strictObject({ kind: z.literal("opened"), tabId: BrowserSurfaceIdSchema }),
  ]),
});
export type BrowserTabOpenBinding = z.infer<typeof BrowserTabOpenBindingSchema>;
export const BrowserTabOpenRefusalDetailsSchema = z.object({
  placements: z.array(BrowserPlacementSchema).max(129).optional(),
});

export const BrowserTabCloseCommandSchema = z.strictObject({
  type: z.literal("browser.tab.close"),
  sessionId: BrowserSessionIdSchema,
  surfaceId: BrowserSurfaceIdSchema,
  expectedGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  idempotencyKey: z.string().min(1).max(255),
});
export const BrowserTabCloseResultSchema = z.object({
  type: z.literal("browser.tab.close"),
  sessionId: BrowserSessionIdSchema,
  outcome: z.enum(["tab-closed", "session-closed"]),
  catalog: BrowserTabCatalogViewSchema,
});
export type BrowserTabCloseCommand = z.infer<typeof BrowserTabCloseCommandSchema>;
export type BrowserTabCloseResult = z.infer<typeof BrowserTabCloseResultSchema>;
export const staleBrowserTabInventoryReason = "stale-tab-inventory";
