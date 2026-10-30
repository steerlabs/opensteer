import {
  macWindowVideoParams,
  macWindowVideoResults,
  MacWindowVideoStateSchema,
  MacOwnerInputEventSchema,
  MacWindowVideoSourceEventSchema,
  macOwnerInputVersion,
} from "./mac-window-video.js";
import { ComputerViewHelperRequestSchema } from "./computer-view-requests.js";
import { ComputerViewSchema, ComputerViewNativeResultSchema } from "./computer-view.js";
import {
  ComputerWindowIdSchema,
  IsoDateTimeSchema,
  RunIdSchema,
  ThreadIdSchema,
} from "@opensteer/core";
import {
  ComputerAppIdentitySchema,
  ComputerAppIdentityViewSchema,
  IntegrationAccessSchema,
  IntegrationServerIdSchema,
  ComputerUseAppApprovalSchema,
  computerAppIdentityKey,
  type ComputerAppIdentity,
} from "@opensteer/integration-core";
import { z } from "zod";
import {
  LoginActContextSchema,
  LoginReceiverKeySchema,
  LoginTextSchema,
  PasswordSignInAuthorityCommandSchema,
  PasswordSignInAuthorityEventSchema,
  PasswordSignInAuthorityResultSchema,
  SealedLoginTextSchema,
  validateSealedLoginActionBindings,
} from "./password-sign-in.js";
import {
  ComputerAppApprovalAnswerFrameSchema,
  ComputerAppApprovalListSchema,
  ComputerAppApprovalOutcomeFrameSchema,
  ComputerAppApprovalKeyChallengeSchema,
  ComputerAppApprovalKeyProofSchema,
  approvalAnswerNamesItsRequest,
} from "./computer-app-approvals.js";

import { ComputerUseSessionIdSchema, type ComputerUseSessionId } from "./computer-use-id.js";
export { ComputerUseSessionIdSchema, type ComputerUseSessionId } from "./computer-use-id.js";

/** Nothing was sent to the Mac before the request's deadline passed. */
export const computerUseOutOfTimeSentence =
  "The request ran out of time before it reached the Mac.";

/** Sessions are internal, minted by the Host and never resumed, so one maker. */
export function mintComputerUseSessionId(): ComputerUseSessionId {
  return ComputerUseSessionIdSchema.parse(`cus_${globalThis.crypto.randomUUID()}`);
}

export {
  ComputerAppIdentitySchema,
  ComputerAppIdentityViewSchema,
  computerAppIdentityKey,
  type ComputerAppIdentity,
};

/**
 * How much of an app an agent may do, in the one vocabulary every computer app
 * already uses: `read` is "Can see", `read-write` is "Can see and control".
 * There is deliberately no parallel enum — a second spelling of the same two
 * levels would let a connection and a grant disagree about one of them.
 */
export const ComputerUseAccessSchema = IntegrationAccessSchema;
export type ComputerUseAccess = z.infer<typeof ComputerUseAccessSchema>;

/**
 * Whether operating this app reaches past the app itself.
 *
 * Browsers, Finder, Mail, System Settings and editors with built-in terminals
 * are allowed, but each is a door
 * to everything the person is signed in to, so the approval names it rather
 * than reading like any other app.
 */
export const ComputerUseRiskSchema = z.enum(["standard", "elevated"]);
export type ComputerUseRisk = z.infer<typeof ComputerUseRiskSchema>;

export const ComputerUsePermissionStateSchema = z.enum(["granted", "denied"]);
export type ComputerUsePermissionState = z.infer<typeof ComputerUsePermissionStateSchema>;

/**
 * The two macOS grants the helper holds, each named as macOS names it.
 *
 * They are separate because they gate separate work — Screen Recording is what
 * observing needs, Accessibility what acting needs — and a Mac holding one of
 * them is half set up rather than unavailable.
 */
export const ComputerUsePermissionsSchema = z.strictObject({
  accessibility: ComputerUsePermissionStateSchema,
  screenRecording: ComputerUsePermissionStateSchema,
});
export const ComputerUsePermissionsViewSchema = z.object(ComputerUsePermissionsSchema.shape);
export type ComputerUsePermissions = z.infer<typeof ComputerUsePermissionsSchema>;

/** At most 64 KiB of base64, which is the picker's icon budget per app. */
export const computerUseIconMaxBase64Length = 64 * 1_024;
/**
 * The two halves of one observation's budget, in the unit each is written in.
 *
 * The tree's budget is set by the smallest tool-output limit of the engines an
 * agent runs on, not by the frame: an engine that cuts a longer result drops
 * elements from the middle or the picture after the text, and the model then
 * acts on a tree it cannot tell is incomplete. It is measured in UTF-8 bytes,
 * the unit the helper that wrote it counts in.
 *
 * The screenshot's pixel budget is the largest picture every current vision
 * model reads without resizing it first. A resized picture moves every point
 * a model reads off it, so a point target would land beside what it chose.
 */
export const computerUseTreeMaxBytes = 32_000;
export const computerUseScreenshotMaxBase64Length = 600_000;
export const computerUseScreenshotMaxLongSide = 1_440;
export const computerUseScreenshotMaxPixels = 1_150_000;
/** The elements one observation may name, which bounds every element index. */
export const computerUseMaxElements = 1_500;
/** Installed apps one picker listing carries. */
export const computerUseMaxInstalledApps = 100;
/** Apps one session may hold on one Mac. */
export const computerUseMaxSessionApps = 8;

const Base64Schema = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/u);

/**
 * A window-relative point in macOS points.
 *
 * Bounded rather than merely numeric: a point becomes a synthetic event
 * stamped with the target window, so a value the helper cannot place inside
 * that window is refused here rather than posted somewhere unintended.
 */
const PointSchema = z.number().min(-100_000).max(100_000);

/** An element index, which is only ever read from one cited observation. */
const ElementIndexSchema = z
  .number()
  .int()
  .nonnegative()
  .max(computerUseMaxElements - 1);

/** Opaque helper identities, bound to one session and process incarnation. */
export const ComputerUseWindowRefSchema = z.string().min(1).max(128);
export const ComputerUseSnapshotSchema = z.string().min(1).max(64);
/** Android retains its existing observation contract. Mac operations use snapshots. */
export const ComputerUseObservationIdSchema = z.string().min(1).max(64);
export const computerUseMaxWindows = 64;

export const computerUseToolRequiredSentence =
  "Use the computer tool to see and operate apps and phones.";
export const computerUseWindowClosedSentence = "That window is closed.";
export const computerUseObserveAgainSentence = "Observe this window again.";
export const computerUseObserveFirstSentence = "Observe this window first.";
export const computerUseBlockedWindowSentence = (title: string, id: number): string =>
  `"${title}" (window ${id}) blocks this app; use that window.`;
export const computerUseUpdateMacSentence = (name: string): string =>
  `Update Opensteer on ${name} to let agents use its apps.`;
/** A Runner's own words never name its computer; the Host adds which Mac it is. */
export const computerUseUpdateSentence = "Update Opensteer to let agents use its apps.";

export const ComputerUseInstalledAppSchema = z.strictObject({
  iconPng: Base64Schema.max(computerUseIconMaxBase64Length).optional(),
  identity: ComputerAppIdentitySchema,
  running: z.boolean(),
});
export type ComputerUseInstalledApp = z.infer<typeof ComputerUseInstalledAppSchema>;

/**
 * What one Mac says about one app before anybody approves it.
 *
 * `allowed` is the helper's deny-list verdict and `reason` the sentence that
 * goes with it, so a refused app explains itself in the picker rather than
 * failing later. `running` is a fact of the moment, never part of the identity.
 */
export const ComputerUseResolvedAppSchema = z.strictObject({
  allowed: z.boolean(),
  identity: ComputerAppIdentitySchema,
  path: z.string().min(1).max(4_096),
  reason: z.string().min(1).max(1_000).nullable(),
  risk: ComputerUseRiskSchema,
  running: z.boolean(),
});
export type ComputerUseResolvedApp = z.infer<typeof ComputerUseResolvedAppSchema>;

/**
 * The app one call targets: what the Host resolved from the connection, and
 * the access it resolved from the effective grant. Every observe and act
 * carries it, so the helper enforces the target of each call rather than a
 * list declared when the session opened.
 */
export const ComputerUseSessionAppSchema = z.strictObject({
  access: ComputerUseAccessSchema,
  identity: ComputerAppIdentitySchema,
});
export type ComputerUseSessionApp = z.infer<typeof ComputerUseSessionAppSchema>;

/**
 * Where an action lands: an element from the cited observation, or a point in
 * the screenshot. Both use screenshot pixels, with the origin at its top-left.
 */
export const ComputerUseTargetSchema = z.union([
  z.strictObject({ index: ElementIndexSchema }),
  z.strictObject({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative() }),
]);
export type ComputerUseTarget = z.infer<typeof ComputerUseTargetSchema>;

const computerUseActionVariants = [
  z.strictObject({
    button: z.enum(["left", "right", "middle"]).default("left"),
    count: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
    target: ComputerUseTargetSchema,
    type: z.literal("click"),
  }),
  /**
   * Without a target, text goes to whatever the app has focused after the
   * earlier actions in the batch. With one, the helper focuses that element
   * first, which is the only dependable way to type into an app that is not
   * frontmost.
   */
  z.strictObject({
    target: ComputerUseTargetSchema.optional(),
    text: z.union([z.string().min(1).max(20_000), LoginTextSchema]),
    type: z.literal("type"),
  }),
  z.strictObject({ keys: z.string().min(1).max(64), type: z.literal("key") }),
  z.strictObject({
    index: ElementIndexSchema,
    type: z.literal("setValue"),
    value: z.string().max(100_000),
  }),
  z.strictObject({
    amount: z.number().int().min(1).max(20),
    direction: z.enum(["up", "down", "left", "right"]),
    target: ComputerUseTargetSchema,
    type: z.literal("scroll"),
  }),
] as const;
export const ComputerUseActionSchema = z.discriminatedUnion("type", computerUseActionVariants);
export type ComputerUseAction = z.infer<typeof ComputerUseActionSchema>;

const [clickAction, typeAction, ...otherActions] = computerUseActionVariants;
export const ComputerUseDispatchActionSchema = z.discriminatedUnion("type", [
  clickAction,
  typeAction.extend({ text: z.union([typeAction.shape.text.options[0], SealedLoginTextSchema]) }),
  ...otherActions,
]);
export type ComputerUseDispatchAction = z.infer<typeof ComputerUseDispatchActionSchema>;

/**
 * One batch, performed in order and stopped at the first failure.
 *
 * The cap is the batch a person can follow on the preview and a model can
 * reason about having written; longer work is more batches.
 */
export const computerUseMaxActions = 32;
export const ComputerUseActionsSchema = z
  .array(ComputerUseActionSchema)
  .min(1)
  .max(computerUseMaxActions);
export const ComputerUseDispatchActionsSchema = z
  .array(ComputerUseDispatchActionSchema)
  .min(1)
  .max(computerUseMaxActions);

const ComputerUseWindowFrameSchema = z.strictObject({
  height: PointSchema,
  width: PointSchema,
  x: PointSchema,
  y: PointSchema,
});

export const OwnerWindowInfoSchema = z.strictObject({
  id: ComputerWindowIdSchema,
  title: z.string().max(1_024),
  focused: z.boolean(),
  main: z.boolean(),
  minimized: z.boolean(),
  onScreen: z.boolean(),
});
export type OwnerWindowInfo = z.infer<typeof OwnerWindowInfoSchema>;
export const WindowInfoSchema = OwnerWindowInfoSchema.extend({
  ref: ComputerUseWindowRefSchema,
  modal: z.boolean(),
  current: z.boolean(),
  frame: ComputerUseWindowFrameSchema,
});
export type WindowInfo = z.infer<typeof WindowInfoSchema>;

export const ComputerUseWindowSchema = z.strictObject({
  ref: ComputerUseWindowRefSchema,
  id: ComputerWindowIdSchema,
  frame: ComputerUseWindowFrameSchema,
  /** Pixels per window point after resizing. */
  scale: z.number().min(0.1).max(8),
  title: z.string().max(1_024),
});
export type ComputerUseWindow = z.infer<typeof ComputerUseWindowSchema>;

/**
 * The bound window and its OS-associated surfaces, never sibling documents.
 *
 * Tree frames and action targets use these screenshot pixels.
 */
export const ComputerUseScreenshotSchema = z
  .strictObject({
    base64: Base64Schema.max(computerUseScreenshotMaxBase64Length),
    height: z.number().int().positive().max(computerUseScreenshotMaxLongSide),
    mime: z.literal("image/jpeg"),
    width: z.number().int().positive().max(computerUseScreenshotMaxLongSide),
  })
  .refine((screenshot) => screenshot.width * screenshot.height <= computerUseScreenshotMaxPixels, {
    message: `A screenshot must be at most ${computerUseScreenshotMaxPixels} pixels`,
  });
export type ComputerUseScreenshot = z.infer<typeof ComputerUseScreenshotSchema>;

/** A full snapshot of one bound window; indices are reassigned on each observation. */
export const ComputerUseObservationSchema = z
  .strictObject({
    app: ComputerAppIdentitySchema,
    capturedAt: IsoDateTimeSchema,
    elementCount: z.number().int().nonnegative().max(computerUseMaxElements),
    focusChanged: z.boolean(),
    geometry: z.strictObject({
      width: z.number().int().positive().max(10_000),
      height: z.number().int().positive().max(10_000),
    }),
    snapshot: ComputerUseSnapshotSchema,
    windows: z.array(WindowInfoSchema).max(computerUseMaxWindows),
    blockedBy: z
      .array(
        z.strictObject({
          id: ComputerWindowIdSchema,
          title: z.string().max(1_024),
          kind: z.enum(["dialog", "menu"]),
        }),
      )
      .max(8),
    alone: z.boolean(),
    screenshot: ComputerUseScreenshotSchema.nullable(),
    tree: z.string().max(computerUseTreeMaxBytes),
    /** Whether the element cap cut the tree, which the tree also states. */
    truncated: z.boolean(),
    window: ComputerUseWindowSchema,
  })
  .superRefine((observation, context) => {
    // Measured in the unit the helper counts in: a tree this side accepted as
    // 200,000 "characters" could be 600,000 bytes there, and the frame it
    // travels in is budgeted in bytes.
    if (utf8ByteLength(observation.tree) > computerUseTreeMaxBytes) {
      context.addIssue({
        code: "custom",
        message: `An observation tree must be at most ${computerUseTreeMaxBytes} bytes of UTF-8`,
        path: ["tree"],
      });
    }
  });
export type ComputerUseObservation = z.infer<typeof ComputerUseObservationSchema>;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Every refusal computer use has, each a sentence a person or a model can act
 * on. `outcome-unknown` is the one that is never retried: an action whose
 * answer was lost may already have happened in the app.
 */
export const ComputerUseErrorCodeSchema = z.enum([
  "permission-required",
  "app-not-allowed",
  "app-not-found",
  "app-not-running",
  "no-session",
  "busy",
  "stale-observation",
  "stopped-by-user",
  "unsupported",
  "failed",
  "outcome-unknown",
  // A persisted iMessage attempt is unconfirmed. Repeating its delivery key
  // cannot establish the outcome; a lost bridge answer remains outcome-unknown.
  "delivery-unconfirmed",
  "incompatible-version",
]);
export type ComputerUseErrorCode = z.infer<typeof ComputerUseErrorCodeSchema>;

/** The refusal body every computer-use surface prints, so it is a sentence. */
export const ComputerUseErrorSchema = z.strictObject({
  error: z.strictObject({
    code: ComputerUseErrorCodeSchema,
    message: z.string().min(1).max(1_000),
  }),
});
export type ComputerUseError = z.infer<typeof ComputerUseErrorSchema>;

/**
 * What the Host asks a Mac to do, which is not what a model may ask for.
 *
 * Only `observe` and `act` have tool rows;
 * the other operations are Host bookkeeping. They reach the Mac on the same
 * frame, and the helper enforces the difference.
 */
export const ComputerUseOperationSchema = z.enum([
  "permissions",
  "installed_apps",
  "resolve_app",
  "windows",
  "bind",
  "observe",
  "act",
  "close",
]);
export type ComputerUseOperation = z.infer<typeof ComputerUseOperationSchema>;

export const ComputerUseWindowsParamsSchema = z.strictObject({});
export type ComputerUseWindowsParams = z.infer<typeof ComputerUseWindowsParamsSchema>;
export const ComputerUseBindParamsSchema = z.strictObject({
  window: ComputerWindowIdSchema.nullable(),
});
export type ComputerUseBindParams = z.infer<typeof ComputerUseBindParamsSchema>;
export const ComputerUseObserveParamsSchema = z.strictObject({
  window: ComputerUseWindowRefSchema,
});
export type ComputerUseObserveParams = z.infer<typeof ComputerUseObserveParamsSchema>;

/** The Host chooses whether the selected engine and model can receive pixels. */
export const ComputerUseDispatchObserveParamsSchema = ComputerUseObserveParamsSchema.extend({
  includeScreenshot: z.boolean(),
});
export type ComputerUseDispatchObserveParams = z.infer<
  typeof ComputerUseDispatchObserveParamsSchema
>;

export const ComputerUseActParamsSchema = z.strictObject({
  window: ComputerUseWindowRefSchema,
  snapshot: ComputerUseSnapshotSchema.nullable(),
  actions: ComputerUseActionsSchema,
});
export type ComputerUseActParams = z.infer<typeof ComputerUseActParamsSchema>;

export const ComputerUseDispatchActParamsSchema = ComputerUseActParamsSchema.extend({
  actions: ComputerUseDispatchActionsSchema,
  loginContext: LoginActContextSchema.optional(),
}).superRefine(validateSealedLoginActionBindings);
export type ComputerUseDispatchActParams = z.infer<typeof ComputerUseDispatchActParamsSchema>;

export const ComputerUseWindowsResultSchema = z.strictObject({
  windows: z.array(WindowInfoSchema).max(computerUseMaxWindows),
});
export type ComputerUseWindowsResult = z.infer<typeof ComputerUseWindowsResultSchema>;
export const ComputerUseBindResultSchema = z.strictObject({ window: WindowInfoSchema });
export type ComputerUseBindResult = z.infer<typeof ComputerUseBindResultSchema>;
export const ComputerUseViewWindowsParamsSchema = z.strictObject({
  app: ComputerAppIdentitySchema,
});
export const ComputerUseViewWindowsResultSchema = z.strictObject({
  windows: z.array(OwnerWindowInfoSchema).max(computerUseMaxWindows),
});
export type ComputerUseViewWindowsResult = z.infer<typeof ComputerUseViewWindowsResultSchema>;
export const ComputerUseObservationResultSchema = z.strictObject({
  observation: ComputerUseObservationSchema,
});
export type ComputerUseObservationResult = z.infer<typeof ComputerUseObservationResultSchema>;

/**
 * What one completed action did, in words a person and a model both read:
 * a past-tense verb and the element as the person sees it — `Clicked "Save"`,
 * `Typed "Venue shortlist" into "Title"`, `Pressed ⌘S`. Text typed into a
 * secure field is never repeated, only counted.
 */
export const computerUsePerformedMaxLength = 160;
export const ComputerUsePerformedSchema = z.string().min(1).max(computerUsePerformedMaxLength);

/** Receipts travel even when a batch stops; acting never observes. */
export const ComputerUseActResultSchema = z
  .strictObject({
    error: ComputerUseErrorSchema.shape.error.nullable(),
    /** One entry per fully completed action, in order. */
    performed: z.array(ComputerUsePerformedSchema).max(computerUseMaxActions),
  })
  .refine((result) => result.error?.code !== "stale-observation" || result.performed.length === 0, {
    message: "A stale observation refuses the batch before any action runs",
    path: ["performed"],
  });
export type ComputerUseActResult = z.infer<typeof ComputerUseActResultSchema>;

/**
 * A live session as a computer's page and a Thread show it.
 *
 * A session holds either apps on a Mac or a phone's whole display, never
 * both: `display` says which, and a display session names no app.
 *
 * It is a `z.object` rather than a strict one because it reaches clients
 * inside `MachineSummary`, where every level stays forward tolerant.
 */
export const ComputerUseSessionSummarySchema = z
  .object({
    actionCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    actingDisplay: z.boolean().optional(),
    actor: z.object({ threadId: ThreadIdSchema, home: z.boolean() }).nullable().optional(),
    /** Apps with accepted activity inside the acting window; presence patches keep it current. */
    actingAppKeys: z.array(z.string().min(1).max(255)).max(computerUseMaxSessionApps).default([]),
    apps: z.array(ComputerAppIdentityViewSchema).max(computerUseMaxSessionApps),
    windows: z
      .array(
        z.object({
          appKey: z.string().min(1).max(255),
          id: ComputerWindowIdSchema,
          title: z.string().max(1_024),
        }),
      )
      .max(computerUseMaxSessionApps)
      .optional(),
    display: z.boolean(),
    openedAt: IsoDateTimeSchema,
    runId: RunIdSchema,
    sessionId: ComputerUseSessionIdSchema,
    threadId: ThreadIdSchema,
    threadTitle: z.string().max(240).nullable(),
  })
  .refine((session) => session.display === (session.apps.length === 0), {
    message: "A session holds apps or the whole display, never both and never neither",
    path: ["apps"],
  });
export type ComputerUseSessionSummary = z.infer<typeof ComputerUseSessionSummarySchema>;

export const ComputerUseMachineStateSchema = z.enum([
  "unavailable",
  "permission-required",
  "ready",
]);
export type ComputerUseMachineState = z.infer<typeof ComputerUseMachineStateSchema>;

/**
 * What one computer's row says about computer use. `permissions` is null for
 * every Mac that has not reported them and for every machine with no helper at
 * all, which is not the same as both grants being denied.
 */
export const MachineComputerUseSchema = z.object({
  ownerViewVersion: z.number().int().positive().max(1000).optional(),
  ownerViews: z
    .array(z.lazy(() => ComputerViewSchema))
    .max(64)
    .optional(),
  detail: z.string().nullable(),
  permissions: ComputerUsePermissionsViewSchema.nullable(),
  /** The signed integrations descriptor advertises live display streaming. */
  displayStreamSupported: z.boolean().default(false),
  appApproval: ComputerUseAppApprovalSchema.nullable(),
  /**
   * The approval key the Host accepts this Mac's answers with, or null when
   * none is registered: then no approval can be given until the owner opens
   * this Mac's page in Opensteer on that Mac, which registers the desktop's
   * key. This projection is required by Host API epoch 15.
   */
  approvalKeyId: z.string().max(128).nullable(),
  sessions: z.array(ComputerUseSessionSummarySchema),
  state: ComputerUseMachineStateSchema,
});
export type MachineComputerUse = z.infer<typeof MachineComputerUseSchema>;

/**
 * The helper IPC protocol: desktop main to `Opensteer Computer Use`, over a
 * Unix socket framed by a 4-byte big-endian length. The Swift side reads these
 * names and fields as its own contract, so this file decides them.
 */
export const computerUseHelperProtocolVersion = 10;
export const computerUseHelperMaxFrameBytes = 4 * 1_024 * 1_024;

export const ComputerUseHelperMethodSchema = z.enum([
  "hello",
  "display.input",
  "display.input-reset",
  "display.resolve",
  "display.start",
  "display.demand",
  "display.refresh",
  "display.stop",
  "display.attach",
  "view.windows",
  "view.open",
  "view.renew",
  "view.close",
  "view.activate",
  "permissions.get",
  "permissions.request",
  "apps.installed",
  "app.resolve",
  "session.open",
  "session.close",
  "session.windows",
  "session.bind",
  "session.observe",
  "session.act",
  "data.status",
  "data.request",
  "data.invoke",
  "imessage.account",
  "imessage.poll",
  "imessage.send",
]);
export type ComputerUseHelperMethod = z.infer<typeof ComputerUseHelperMethodSchema>;

const EmptyParamsSchema = z.strictObject({});

export const ComputerUseHelloParamsSchema = z.strictObject({
  loginText: z.literal(1).optional(),
  ownerInputVersion: z.literal(macOwnerInputVersion).optional(),
  ownerViewVersion: z.literal(3).optional(),
  clientVersion: z.string().min(1).max(64),
  protocolVersion: z.number().int().positive().max(1_000),
});

/**
 * The helper's version answer. It states a range rather than one number: one
 * installed helper serves both Stable and Beta, so a newer Beta refreshing the
 * canonical copy must not disable the Stable app talking to it. Outside the
 * range the answer is `incompatible-version`: the desktop then installs its own
 * helper when that is newer, and the person updates Opensteer when it is not.
 */
export const ComputerUseHelloResultSchema = z.strictObject({
  loginText: LoginReceiverKeySchema.optional(),
  ownerInputVersion: z.literal(macOwnerInputVersion).optional(),
  ownerViewVersion: z.number().int().positive().max(1000).optional(),
  helperVersion: z.string().min(1).max(64),
  minProtocolVersion: z.number().int().positive().max(1_000),
  permissions: ComputerUsePermissionsSchema,
  protocolVersion: z.number().int().positive().max(1_000),
  /**
   * Which delivery routes this helper build has. Read tolerantly: an older helper
   * states fewer routes, or none, and must still parse so it can be refused as
   * incompatible rather than failing the handshake.
   */
  routes: z
    .object({ windowLocation: z.boolean(), windowGroups: z.boolean().optional() })
    .optional(),
});

export const ComputerUsePermissionsResultSchema = z.strictObject({
  /** Desktop bridge advertisement derived from its authenticated helper handshake. */
  computerUseVersion: z.literal(2).optional(),
  ownerInputVersion: z.literal(macOwnerInputVersion).optional(),
  ownerViewVersion: z.number().int().positive().max(1000).optional(),
  permissions: ComputerUsePermissionsSchema,
});

export const ComputerUsePermissionPaneSchema = z.enum(["accessibility", "screen-recording"]);
export type ComputerUsePermissionPane = z.infer<typeof ComputerUsePermissionPaneSchema>;

/** One explicit local consent action; never request both macOS grants together. */
export const ComputerUsePermissionsRequestParamsSchema = z.strictObject({
  pane: ComputerUsePermissionPaneSchema,
});

/**
 * The macOS privacy grants the helper holds for apps agents use through a
 * bounded API rather than their interface. They are separate from computer
 * use's two: reading a contact needs no Accessibility, and observing an app
 * needs no Contacts. The helper holds them rather than Opensteer.app because
 * every command an agent runs descends from Opensteer.app, and a grant held
 * there would be every agent's, whatever its Workspace was granted.
 */
/**
 * The macOS grants the helper holds for apps it serves. `automation` is its
 * Automation permission for Messages; `full-disk-access` is its own Full Disk
 * Access, which only System Settings grants.
 */
export const ComputerUseDataGrantSchema = z.enum([
  "automation",
  "calendars",
  "contacts",
  "full-disk-access",
  "reminders",
]);
export type ComputerUseDataGrant = z.infer<typeof ComputerUseDataGrantSchema>;

/**
 * `requestable` means macOS asks when the person at this Mac asks it to:
 * never asked, or — for Calendars and Reminders — allowed to add but not to
 * read. `denied` means only System Settings can change it. `unknown` means
 * macOS will not say yet — Automation while Messages is not running — and
 * the helper settles it, without asking, before it acts.
 */
export const ComputerUseDataGrantStateSchema = z.enum([
  "granted",
  "requestable",
  "denied",
  "unknown",
]);
export type ComputerUseDataGrantState = z.infer<typeof ComputerUseDataGrantStateSchema>;

export const ComputerUseDataGrantsSchema = z.strictObject({
  automation: ComputerUseDataGrantStateSchema,
  calendars: ComputerUseDataGrantStateSchema,
  contacts: ComputerUseDataGrantStateSchema,
  "full-disk-access": ComputerUseDataGrantStateSchema,
  reminders: ComputerUseDataGrantStateSchema,
});
export type ComputerUseDataGrants = z.infer<typeof ComputerUseDataGrantsSchema>;

/**
 * The apps the helper serves, each with the grant its reads need and the one
 * its changes need. The Runner offers exactly these as helper-backed computer
 * apps, and the helper's contract table is generated from exactly these
 * catalog definitions, so the two cannot disagree about which apps exist.
 */
export const computerUseDataApps = {
  "apple-calendar": { read: "calendars", write: "calendars" },
  "apple-contacts": { read: "contacts", write: "contacts" },
  "apple-messages": { read: "full-disk-access", write: "automation" },
  "apple-reminders": { read: "reminders", write: "reminders" },
} as const satisfies Readonly<
  Record<string, { readonly read: ComputerUseDataGrant; readonly write: ComputerUseDataGrant }>
>;
export type ComputerUseDataAppId = keyof typeof computerUseDataApps;
/** Additional native data providers; these do not use Mac helper grants. */
export const iphoneDataAppIds = ["iphone-location", "iphone-photos"] as const;
export const ComputerUseDataAppIdSchema = z.enum([
  "apple-calendar",
  "apple-contacts",
  "apple-messages",
  "apple-reminders",
] as const satisfies readonly ComputerUseDataAppId[]);

/** `data.status` and `data.request` both answer with every grant, as it stands now. */
export const ComputerUseDataStatusResultSchema = z.strictObject({
  grants: ComputerUseDataGrantsSchema,
});

/** One explicit local consent action for one grant. */
export const ComputerUseDataRequestParamsSchema = z.strictObject({
  grant: ComputerUseDataGrantSchema,
});

/**
 * One operation of an app the helper serves. `contract` is the Host's
 * `computerAppOperationContract` for it, which the helper checks against the
 * table compiled into it, and `access` is what the Host resolved: the helper
 * refuses a write under `read` itself rather than trusting every hop before
 * it. `effect` travels so each hop can tell, without the catalog, whether a
 * lost answer may hide a change.
 */
export const ComputerUseDataInvokeParamsSchema = z.strictObject({
  access: IntegrationAccessSchema,
  arguments: z.record(z.string(), z.json()),
  contract: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  definitionId: z.string().min(1).max(64),
  effect: z.enum(["read", "write"]),
  operation: z.string().min(1).max(64),
});
export type ComputerUseDataInvokeParams = z.infer<typeof ComputerUseDataInvokeParamsSchema>;

export const ComputerUseDataInvokeResultSchema = z.strictObject({ value: z.json() });

/**
 * A place in `chat.db`: a message row and the guid it held when read, so a
 * history rebuilt under the same row ids is told apart. A null guid is the
 * start of a history that had no message yet.
 */
export const IMessagePositionSchema = z.strictObject({
  guid: z.string().min(1).max(256).nullable(),
  rowId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type IMessagePosition = z.infer<typeof IMessagePositionSchema>;

/** The Apple account a Mac's Messages uses for iMessage. */
export const IMessageAccountSchema = z.strictObject({
  handle: z.string().min(1).max(320).nullable(),
  id: z.string().min(1).max(256),
});
export type IMessageAccount = z.infer<typeof IMessageAccountSchema>;

/** `imessage.account`: the account, and the newest row a new channel starts after. */
export const ComputerUseIMessageAccountResultSchema = z.strictObject({
  account: IMessageAccountSchema.nullable(),
  end: IMessagePositionSchema.nullable(),
});

/**
 * `imessage.poll`: the rows after `after`, as far as Messages has written them
 * whole. `owner` is the channel asking: it takes or renews that channel's claim
 * on the Apple account, which another channel on this Mac cannot share.
 */
export const ComputerUseIMessagePollParamsSchema = z.strictObject({
  accountId: IMessageAccountSchema.shape.id,
  after: IMessagePositionSchema,
  limit: z.number().int().min(1).max(500),
  owner: z.string().min(1).max(128),
});

export const IMessageRowSchema = z.strictObject({
  guid: z.string().max(256),
  /** Null for a row that is not a person texting the bot one to one over iMessage. */
  message: z
    .strictObject({
      handle: z.string().min(1).max(320),
      sentAt: z.iso.datetime({ offset: true }),
      text: z
        .string()
        .min(1)
        .max(64 * 1_024),
    })
    .nullable(),
  rowId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type IMessageRow = z.infer<typeof IMessageRowSchema>;

export const ComputerUseIMessagePollResultSchema = z.strictObject({
  account: z.enum(["current", "changed", "signed-out"]),
  claim: z.enum(["held", "busy"]),
  cursor: z.enum(["valid", "deleted", "rebuilt"]),
  rows: z.array(IMessageRowSchema).max(500),
});
export type ComputerUseIMessagePollResult = z.infer<typeof ComputerUseIMessagePollResultSchema>;

/** `imessage.send`: one reply, from the bound account; `key` makes it happen once. */
export const ComputerUseIMessageSendParamsSchema = z.strictObject({
  accountId: IMessageAccountSchema.shape.id,
  key: z.string().min(1).max(128),
  owner: z.string().min(1).max(128),
  text: z.string().min(1).max(4_000),
  to: z.string().min(1).max(320),
});

export const ComputerUseIMessageSendResultSchema = z.strictObject({
  key: z.string().min(1).max(128),
  sentAt: z.iso.datetime({ offset: true }),
});

export const ComputerUseInstalledAppsParamsSchema = z.strictObject({
  query: z.string().default(""),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().nonnegative().default(0),
  icons: z.boolean().default(false),
});
export type ComputerUseInstalledAppsParams = z.infer<typeof ComputerUseInstalledAppsParamsSchema>;

export const ComputerUseInstalledAppsResultSchema = z.strictObject({
  apps: z.array(ComputerUseInstalledAppSchema).max(computerUseMaxInstalledApps),
  total: z.number().int().nonnegative(),
});

/** Name, path, or bundle identifier — whatever the person or the Host has. */
export const ComputerUseResolveAppParamsSchema = z.strictObject({
  app: z.string().min(1).max(4_096),
});

export const ComputerUseResolveAppResultSchema = z.strictObject({
  app: ComputerUseResolvedAppSchema,
});

/**
 * Opening a session is bookkeeping only: it names the session and the task the
 * person sees on the pill. The helper keeps no approval list and no declared
 * app set; each observe and act carries the app and access it may touch.
 */
export const ComputerUseSessionOpenParamsSchema = z.strictObject({
  runId: RunIdSchema.optional(),
  threadTitle: z.string().max(240).nullable(),
  sessionId: ComputerUseSessionIdSchema,
});

export const ComputerUseSessionOpenResultSchema = z.strictObject({
  sessionId: ComputerUseSessionIdSchema,
});

export const ComputerUseSessionParamsSchema = z.strictObject({
  sessionId: ComputerUseSessionIdSchema,
});

export const ComputerUseSessionWindowsParamsSchema = ComputerUseWindowsParamsSchema.extend({
  app: ComputerUseSessionAppSchema,
  sessionId: ComputerUseSessionIdSchema,
});
export const ComputerUseSessionBindParamsSchema = ComputerUseBindParamsSchema.extend({
  app: ComputerUseSessionAppSchema,
  sessionId: ComputerUseSessionIdSchema,
});
export const ComputerUseSessionObserveParamsSchema = ComputerUseDispatchObserveParamsSchema.extend({
  app: ComputerUseSessionAppSchema,
  sessionId: ComputerUseSessionIdSchema,
});
export const ComputerUseSessionActParamsSchema = ComputerUseDispatchActParamsSchema.safeExtend({
  app: ComputerUseSessionAppSchema,
  sessionId: ComputerUseSessionIdSchema,
});

const helperRequestIdSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * The time left for one request, counted from when it is received.
 *
 * It is the Host's one deadline carried down every hop, so each hop can tell
 * work that never started from work whose answer was lost: a request still
 * queued when its time runs out is refused as not done, and one already
 * running stops between actions and reports what it completed. Only a hop
 * whose own wait outlives the deadline plus a grace ends anything, and then
 * only that request's session.
 */
export const computerUseMaxTimeoutMs = 120_000;
const ComputerUseTimeoutMsSchema = z.number().int().positive().max(computerUseMaxTimeoutMs);

export const ComputerUseHelperRequestSchema = z.discriminatedUnion("method", [
  z.strictObject({
    id: helperRequestIdSchema,
    timeoutMs: ComputerUseTimeoutMsSchema.optional(),
    method: z.literal("display.input"),
    params: z.lazy(() => macWindowVideoParams["display.input"]),
  }),
  z.strictObject({
    id: helperRequestIdSchema,
    timeoutMs: ComputerUseTimeoutMsSchema.optional(),
    method: z.literal("display.input-reset"),
    params: z.lazy(() => macWindowVideoParams["display.input-reset"]),
  }),
  z.strictObject({
    id: helperRequestIdSchema,
    timeoutMs: ComputerUseTimeoutMsSchema.optional(),
    method: z.literal("display.resolve"),
    params: z.lazy(() => macWindowVideoParams["display.resolve"]),
  }),
  z.strictObject({
    id: helperRequestIdSchema,
    timeoutMs: ComputerUseTimeoutMsSchema.optional(),
    method: z.literal("display.start"),
    params: z.lazy(() => macWindowVideoParams["display.start"]),
  }),
  z.strictObject({
    id: helperRequestIdSchema,
    timeoutMs: ComputerUseTimeoutMsSchema.optional(),
    method: z.literal("display.demand"),
    params: z.lazy(() => macWindowVideoParams["display.demand"]),
  }),
  z.strictObject({
    id: helperRequestIdSchema,
    timeoutMs: ComputerUseTimeoutMsSchema.optional(),
    method: z.literal("display.refresh"),
    params: z.lazy(() => macWindowVideoParams["display.refresh"]),
  }),
  z.strictObject({
    id: helperRequestIdSchema,
    timeoutMs: ComputerUseTimeoutMsSchema.optional(),
    method: z.literal("display.stop"),
    params: z.lazy(() => macWindowVideoParams["display.stop"]),
  }),
  z.strictObject({
    id: helperRequestIdSchema,
    timeoutMs: ComputerUseTimeoutMsSchema.optional(),
    method: z.literal("display.attach"),
    params: z.lazy(() => macWindowVideoParams["display.attach"]),
  }),

  z.strictObject({
    id: helperRequestIdSchema,
    timeoutMs: ComputerUseTimeoutMsSchema.optional(),
    method: z.literal("view.windows"),
    params: ComputerUseViewWindowsParamsSchema,
  }),
  ...ComputerViewHelperRequestSchema.options,
  z.strictObject({
    id: helperRequestIdSchema,
    timeoutMs: ComputerUseTimeoutMsSchema.optional(),
    method: z.literal("hello"),
    params: ComputerUseHelloParamsSchema,
  }),
  z.strictObject({
    id: helperRequestIdSchema,
    timeoutMs: ComputerUseTimeoutMsSchema.optional(),
    method: z.literal("permissions.get"),
    params: EmptyParamsSchema,
  }),
  z.strictObject({
    id: helperRequestIdSchema,
    timeoutMs: ComputerUseTimeoutMsSchema.optional(),
    method: z.literal("permissions.request"),
    params: ComputerUsePermissionsRequestParamsSchema,
  }),
  z.strictObject({
    id: helperRequestIdSchema,
    timeoutMs: ComputerUseTimeoutMsSchema.optional(),
    method: z.literal("apps.installed"),
    params: ComputerUseInstalledAppsParamsSchema,
  }),
  z.strictObject({
    id: helperRequestIdSchema,
    timeoutMs: ComputerUseTimeoutMsSchema.optional(),
    method: z.literal("app.resolve"),
    params: ComputerUseResolveAppParamsSchema,
  }),
  z.strictObject({
    id: helperRequestIdSchema,
    timeoutMs: ComputerUseTimeoutMsSchema.optional(),
    method: z.literal("session.open"),
    params: ComputerUseSessionOpenParamsSchema,
  }),
  z.strictObject({
    id: helperRequestIdSchema,
    timeoutMs: ComputerUseTimeoutMsSchema.optional(),
    method: z.literal("session.close"),
    params: ComputerUseSessionParamsSchema,
  }),
  z.strictObject({
    id: helperRequestIdSchema,
    timeoutMs: ComputerUseTimeoutMsSchema.optional(),
    method: z.literal("session.windows"),
    params: ComputerUseSessionWindowsParamsSchema,
  }),
  z.strictObject({
    id: helperRequestIdSchema,
    timeoutMs: ComputerUseTimeoutMsSchema.optional(),
    method: z.literal("session.bind"),
    params: ComputerUseSessionBindParamsSchema,
  }),
  z.strictObject({
    id: helperRequestIdSchema,
    timeoutMs: ComputerUseTimeoutMsSchema.optional(),
    method: z.literal("session.observe"),
    params: ComputerUseSessionObserveParamsSchema,
  }),
  z.strictObject({
    id: helperRequestIdSchema,
    timeoutMs: ComputerUseTimeoutMsSchema.optional(),
    method: z.literal("session.act"),
    params: ComputerUseSessionActParamsSchema,
  }),
  z.strictObject({
    id: helperRequestIdSchema,
    timeoutMs: ComputerUseTimeoutMsSchema.optional(),
    method: z.literal("data.status"),
    params: EmptyParamsSchema,
  }),
  z.strictObject({
    id: helperRequestIdSchema,
    timeoutMs: ComputerUseTimeoutMsSchema.optional(),
    method: z.literal("data.request"),
    params: ComputerUseDataRequestParamsSchema,
  }),
  z.strictObject({
    id: helperRequestIdSchema,
    timeoutMs: ComputerUseTimeoutMsSchema.optional(),
    method: z.literal("data.invoke"),
    params: ComputerUseDataInvokeParamsSchema,
  }),
  z.strictObject({
    id: helperRequestIdSchema,
    timeoutMs: ComputerUseTimeoutMsSchema.optional(),
    method: z.literal("imessage.account"),
    params: EmptyParamsSchema,
  }),
  z.strictObject({
    id: helperRequestIdSchema,
    timeoutMs: ComputerUseTimeoutMsSchema.optional(),
    method: z.literal("imessage.poll"),
    params: ComputerUseIMessagePollParamsSchema,
  }),
  z.strictObject({
    id: helperRequestIdSchema,
    timeoutMs: ComputerUseTimeoutMsSchema.optional(),
    method: z.literal("imessage.send"),
    params: ComputerUseIMessageSendParamsSchema,
  }),
]);
export type ComputerUseHelperRequest = z.infer<typeof ComputerUseHelperRequestSchema>;

/**
 * An answer carries no method, so the envelope cannot discriminate on one and
 * the caller parses `result` with the schema of the method it asked. This
 * table is the one place that pairing lives.
 */
export const computerUseHelperResults = {
  "display.input": z.lazy(() => macWindowVideoResults["display.input"]),
  "display.input-reset": z.lazy(() => macWindowVideoResults["display.input-reset"]),
  "display.resolve": z.lazy(() => macWindowVideoResults["display.resolve"]),
  "display.start": z.lazy(() => macWindowVideoResults["display.start"]),
  "display.demand": z.lazy(() => macWindowVideoResults["display.demand"]),
  "display.refresh": z.lazy(() => macWindowVideoResults["display.refresh"]),
  "display.stop": z.lazy(() => macWindowVideoResults["display.stop"]),
  "display.attach": z.lazy(() => macWindowVideoResults["display.attach"]),
  "view.windows": ComputerUseViewWindowsResultSchema,
  "view.open": z.lazy(() => ComputerViewNativeResultSchema),
  "view.renew": z.lazy(() => ComputerViewNativeResultSchema),
  "view.close": z.lazy(() => ComputerViewNativeResultSchema),
  "view.activate": z.lazy(() => ComputerViewNativeResultSchema),
  "app.resolve": ComputerUseResolveAppResultSchema,
  "apps.installed": ComputerUseInstalledAppsResultSchema,
  "data.invoke": ComputerUseDataInvokeResultSchema,
  "data.request": ComputerUseDataStatusResultSchema,
  "data.status": ComputerUseDataStatusResultSchema,
  hello: ComputerUseHelloResultSchema,
  "imessage.account": ComputerUseIMessageAccountResultSchema,
  "imessage.poll": ComputerUseIMessagePollResultSchema,
  "imessage.send": ComputerUseIMessageSendResultSchema,
  "permissions.get": ComputerUsePermissionsResultSchema,
  "permissions.request": ComputerUsePermissionsResultSchema,
  "session.act": ComputerUseActResultSchema,
  "session.close": EmptyParamsSchema,
  "session.windows": ComputerUseWindowsResultSchema,
  "session.bind": ComputerUseBindResultSchema,
  "session.observe": ComputerUseObservationResultSchema,
  "session.open": ComputerUseSessionOpenResultSchema,
} satisfies Readonly<Record<ComputerUseHelperMethod, z.ZodType>>;

export const ComputerUseHelperResponseSchema = z.strictObject({
  id: helperRequestIdSchema,
  result: z.json(),
});
export type ComputerUseHelperResponse = z.infer<typeof ComputerUseHelperResponseSchema>;

export const ComputerUseHelperErrorSchema = z.strictObject({
  error: ComputerUseErrorSchema.shape.error,
  id: helperRequestIdSchema,
});
export type ComputerUseHelperError = z.infer<typeof ComputerUseHelperErrorSchema>;

/** Why a session ended without anybody asking it to. */
export const ComputerUseStopReasonSchema = z.enum(["user", "app-quit"]);
export type ComputerUseStopReason = z.infer<typeof ComputerUseStopReasonSchema>;

const computerUseEventVariants = [
  z.strictObject({
    event: z.literal("display.state"),
    params: z.lazy(() => MacWindowVideoStateSchema),
  }),
  z.strictObject({
    event: z.literal("display.source-ended"),
    params: z.lazy(() => MacWindowVideoSourceEventSchema),
  }),
  z.strictObject({
    event: z.literal("display.source-changed"),
    params: z.lazy(() => MacWindowVideoSourceEventSchema),
  }),
  z.strictObject({
    event: z.literal("session.stopped"),
    params: z.strictObject({
      reason: ComputerUseStopReasonSchema,
      /**
       * The Run the stopped session belonged to. A phone names it, because
       * its owner's Stop can reach the Host only on a later stream, after the
       * Host forgot the sessions of the one that dropped; a Mac's desktop
       * ends its sessions with that connection and leaves it out.
       */
      runId: RunIdSchema.optional(),
      sessionId: ComputerUseSessionIdSchema,
    }),
  }),
  z.strictObject({
    event: z.literal("display.owner-input"),
    params: z.lazy(() => MacOwnerInputEventSchema),
  }),
] as const;
export const ComputerUseHelperEventSchema = z.discriminatedUnion("event", computerUseEventVariants);
export type ComputerUseHelperEvent = z.infer<typeof ComputerUseHelperEventSchema>;

/** Everything either end of the socket may read, inside the frame budget. */
export const ComputerUseHelperEnvelopeSchema = z
  .union([
    ComputerUseHelperRequestSchema,
    ComputerUseHelperErrorSchema,
    ComputerUseHelperResponseSchema,
    ComputerUseHelperEventSchema,
  ])
  .refine(helperFrameFits, `Computer use frame exceeds ${computerUseHelperMaxFrameBytes} bytes`);
export type ComputerUseHelperEnvelope = z.infer<typeof ComputerUseHelperEnvelopeSchema>;

function helperFrameFits(value: unknown): boolean {
  return utf8ByteLength(JSON.stringify(value)) <= computerUseHelperMaxFrameBytes;
}

/**
 * The bridge protocol: the Runner's `integrations` handler to desktop main,
 * over a loopback WebSocket minted per slot. It carries the helper's methods
 * minus the handshake, which is desktop main's business with the helper and
 * never a Runner's.
 *
 * Authentication is `Authorization: Bearer <token>` on the upgrade. The token
 * is minted per slot and never enters the Runner's environment: desktop main
 * delivers it as `OPENSTEER_COMPUTER_USE_BRIDGE_TOKEN` among the Runner's
 * private secrets — on the local Runner's parent port, or on the standard
 * input `OPENSTEER_SECRETS_FD` names — exactly as the browser bridge's token
 * travels, and the Runner holds it only in memory.
 */
export const computerUseBridgeMaxFrameBytes = 4 * 1_024 * 1_024;
/** Connection opt-in keeps readiness replies readable by previous strict Runners. */
export const computerUseBridgeOwnerInputHeader = "x-opensteer-mac-owner-input";
export const ComputerUseBridgeTokenSchema = z.string().min(32).max(4_096);

/**
 * Desktop main's own methods, which never reach the helper: the Runner relays
 * the Host's approval list and the outcome of an answer, and main acknowledges
 * each with `{}` at once — the person's answer comes back later as an event.
 */
export const ComputerUseBridgeApprovalMethodSchema = z.enum([
  "approvals.list",
  "approvals.outcome",
  "approvals.key-challenge",
]);
export type ComputerUseBridgeApprovalMethod = z.infer<typeof ComputerUseBridgeApprovalMethodSchema>;

export const ComputerUseBridgeMethodSchema = z.enum([
  ...ComputerUseHelperMethodSchema.exclude(["hello"]).options,
  ...ComputerUseBridgeApprovalMethodSchema.options,
  "passwords.control",
  "passwords.capabilities",
]);
export type ComputerUseBridgeMethod = z.infer<typeof ComputerUseBridgeMethodSchema>;

const WritingDataInvokeSchema = z.object({ effect: z.literal("write") });

/**
 * Whether a request may have changed something on the Mac, which decides what
 * a lost, late or unreadable answer is at every hop: `outcome-unknown` rather
 * than `failed`, because a caller told "failed" asks again and the change
 * happens twice. An action batch and an iMessage reply always may; a data
 * operation when it writes.
 */
export function computerUseRequestMayHaveEffect(method: string, params: unknown): boolean {
  if (
    method === "display.input" ||
    method === "display.input-reset" ||
    method === "session.act" ||
    method === "imessage.send" ||
    method === "view.open" ||
    method === "view.activate"
  )
    return true;
  return method === "data.invoke" && WritingDataInvokeSchema.safeParse(params).success;
}

/** Each approval method's params and its acknowledgement. */
export const computerUseBridgeApprovalParams = {
  "approvals.list": ComputerAppApprovalListSchema,
  "approvals.outcome": ComputerAppApprovalOutcomeFrameSchema,
  "approvals.key-challenge": ComputerAppApprovalKeyChallengeSchema,
} satisfies Readonly<Record<ComputerUseBridgeApprovalMethod, z.ZodType>>;
export const ComputerUseBridgeApprovalAckSchema = z.strictObject({});
export const ComputerUseBridgeApprovalKeyProofSchema = ComputerAppApprovalKeyProofSchema;

export const computerUseBridgePasswordsParams = {
  "passwords.control": PasswordSignInAuthorityCommandSchema,
  "passwords.capabilities": EmptyParamsSchema,
} as const;
export const computerUseBridgePasswordsResults = {
  "passwords.control": PasswordSignInAuthorityResultSchema,
  "passwords.capabilities": z.strictObject({
    receiver: LoginReceiverKeySchema.nullable(),
    authority: z.literal(1).nullable(),
  }),
} as const;

const bridgeRequestIdSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const ComputerUseBridgeRequestSchema = z.strictObject({
  id: bridgeRequestIdSchema,
  kind: z.literal("request"),
  method: ComputerUseBridgeMethodSchema,
  params: z.json(),
  timeoutMs: ComputerUseTimeoutMsSchema.optional(),
});
export type ComputerUseBridgeRequest = z.infer<typeof ComputerUseBridgeRequestSchema>;

/**
 * One answer, which is a result or a refusal and never both: two members
 * rather than two optional fields, so a frame carrying each of them cannot be
 * read as either.
 */
export const ComputerUseBridgeResponseSchema = z.union([
  z.strictObject({ id: bridgeRequestIdSchema, kind: z.literal("response"), result: z.json() }),
  z.strictObject({
    error: ComputerUseErrorSchema.shape.error,
    id: bridgeRequestIdSchema,
    kind: z.literal("response"),
  }),
]);
export type ComputerUseBridgeResponse = z.infer<typeof ComputerUseBridgeResponseSchema>;

/**
 * What desktop main tells its Runner unasked: a helper session stopped, an
 * approval answered, or the person at the Mac answered macOS about a grant,
 * so every app's readiness is read again now rather than on its next round.
 */
export const ComputerUseBridgeEventSchema = z.discriminatedUnion("event", [
  z.strictObject({
    event: z.literal("passwords.event"),
    kind: z.literal("event"),
    params: PasswordSignInAuthorityEventSchema,
  }),
  z.strictObject({ ...computerUseEventVariants[0].shape, kind: z.literal("event") }),
  z.strictObject({ ...computerUseEventVariants[1].shape, kind: z.literal("event") }),
  z.strictObject({ ...computerUseEventVariants[2].shape, kind: z.literal("event") }),
  z.strictObject({ ...computerUseEventVariants[3].shape, kind: z.literal("event") }),
  z.strictObject({ ...computerUseEventVariants[4].shape, kind: z.literal("event") }),
  z.strictObject({ event: z.literal("grants.changed"), kind: z.literal("event") }),
  z
    .strictObject({
      event: z.literal("approval.answer"),
      kind: z.literal("event"),
      params: ComputerAppApprovalAnswerFrameSchema,
      /**
       * The MCP server and exact launch the person allowed, from the request
       * desktop main showed and signed; null for any other answer. It is what
       * lets that launch run on this computer, whatever the Host then does
       * (`docs/computers.md`, "MCP servers on a computer").
       */
      server: z
        .strictObject({
          launchDigest: z.string().min(1).max(128),
          serverId: IntegrationServerIdSchema,
        })
        .nullable()
        .default(null),
    })
    .refine(
      ({ params }) => approvalAnswerNamesItsRequest(params),
      "An approval answers the setup request it names",
    ),
]);
export type ComputerUseBridgeEvent = z.infer<typeof ComputerUseBridgeEventSchema>;

export const ComputerUseBridgeFrameSchema = z
  .union([
    ComputerUseBridgeRequestSchema,
    ComputerUseBridgeResponseSchema,
    ComputerUseBridgeEventSchema,
  ])
  .refine(
    bridgeFrameFits,
    `Computer use bridge frame exceeds ${computerUseBridgeMaxFrameBytes} bytes`,
  );
export type ComputerUseBridgeFrame = z.infer<typeof ComputerUseBridgeFrameSchema>;

function bridgeFrameFits(value: unknown): boolean {
  return utf8ByteLength(JSON.stringify(value)) <= computerUseBridgeMaxFrameBytes;
}
