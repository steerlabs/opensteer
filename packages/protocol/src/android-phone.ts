import agentPhoneRelease from "./agent-phone-release.json" with { type: "json" };
import {
  CanonicalOriginSchema,
  DeploymentIdSchema,
  HostInstanceIdSchema,
  IsoDateTimeSchema,
  RunnerIdSchema,
  isLoopbackHostname,
} from "@opensteer/core";
import { z } from "zod";
import {
  LoginActContextSchema,
  LoginTextSchema,
  SealedLoginTextSchema,
  validateSealedLoginActionBindings,
} from "./password-sign-in.js";
import {
  ComputerUseErrorSchema,
  ComputerUseObservationIdSchema,
  ComputerUsePerformedSchema,
  ComputerUseScreenshotSchema,
  computerUseMaxActions,
  computerUseMaxElements,
  computerUseTreeMaxBytes,
} from "./computer-use.js";

/**
 * The catalog definition an Android phone serves: the phone's whole display,
 * operated by the Opensteer Agent Phone app on that phone.
 *
 * It is a `display` computer app, so its connection names no app and one
 * session holds the entire screen. Everything here is the phone's half of the
 * computer-use contract; the Mac's half stays in `computer-use.ts` unchanged.
 */
export const androidPhoneDefinitionId = "android-phone";

/** The Opensteer Agent Phone app's package, which is also how an observation names it in front. */
export const agentPhonePackageName = "com.opensteer.agentphone";

/**
 * The longest a batch may spend in timed actions: holds, gestures and waits.
 *
 * An act must answer inside the Host's act deadline, and the phone still needs
 * time after the last gesture to let the screen settle and to observe it. A
 * batch that cannot finish in time would be cut off after doing part of its
 * work, which is the one outcome nobody can reason about.
 */
export const androidPhoneMaxTimedActionMs = 40_000;

/** An element index, which only ever resolves against the one observation an act cites. */
const ElementIndexSchema = z
  .number()
  .int()
  .nonnegative()
  .max(computerUseMaxElements - 1);

/** A point in the cited observation's screenshot pixels, origin at the top-left. */
const ScreenshotPointSchema = z.strictObject({
  x: z.number().int().nonnegative().max(10_000),
  y: z.number().int().nonnegative().max(10_000),
});

/**
 * Where an action lands: an element of the cited observation, which the phone
 * acts on at its centre, or a point in that observation's screenshot.
 *
 * Both resolve against the cited observation only. The phone refuses a point
 * outside its geometry and an element that no longer exists rather than acting
 * on whatever now occupies that place.
 */
export const AndroidPhoneTargetSchema = z.union([
  z.strictObject({ index: ElementIndexSchema }),
  ScreenshotPointSchema,
]);
export type AndroidPhoneTarget = z.infer<typeof AndroidPhoneTargetSchema>;

/**
 * The phone's buttons that are not on its screen, named as Android names the
 * system actions an accessibility service performs.
 */
export const AndroidPhoneNavigationSchema = z.enum([
  "back",
  "home",
  "recents",
  "notifications",
  "quickSettings",
]);
export type AndroidPhoneNavigation = z.infer<typeof AndroidPhoneNavigationSchema>;

/** An installed app's package name, the identifier Android launches it by. */
export const AndroidPackageNameSchema = z
  .string()
  .min(3)
  .max(255)
  .regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u);

/**
 * What an agent may ask a phone's app list for. The list is the phone's
 * inventory, like a Mac's installed apps: it is its owner's to read, needs no
 * hold on the screen, and changes nothing on the phone.
 */
export const AndroidPhoneInstalledAppsParamsSchema = z.strictObject({
  query: z.string().max(240).default(""),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
});
export type AndroidPhoneInstalledAppsParams = z.infer<typeof AndroidPhoneInstalledAppsParamsSchema>;

/**
 * One app the `launch` action can open: a package with a launcher entry in
 * the phone's own user. `label` is what the phone shows under its icon.
 */
export const AndroidPhoneInstalledAppSchema = z.strictObject({
  label: z.string().min(1).max(200),
  packageName: AndroidPackageNameSchema,
});
export type AndroidPhoneInstalledApp = z.infer<typeof AndroidPhoneInstalledAppSchema>;

/**
 * One page of the launchable apps matching a query, ordered by label and then
 * package, each package once. `total` counts every match, not just this page.
 */
export const AndroidPhoneInstalledAppsResultSchema = z.strictObject({
  apps: z.array(AndroidPhoneInstalledAppSchema).max(100),
  total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type AndroidPhoneInstalledAppsResult = z.infer<typeof AndroidPhoneInstalledAppsResultSchema>;

const androidPhoneActionVariants = [
  z.strictObject({
    count: z.union([z.literal(1), z.literal(2)]).default(1),
    target: AndroidPhoneTargetSchema,
    type: z.literal("tap"),
  }),
  z.strictObject({
    durationMs: z.number().int().min(400).max(5_000).default(800),
    target: AndroidPhoneTargetSchema,
    type: z.literal("longPress"),
  }),
  /** One finger moved from one place to another without pausing, as when scrolling a feed. */
  z.strictObject({
    durationMs: z.number().int().min(50).max(5_000).default(300),
    from: AndroidPhoneTargetSchema,
    to: AndroidPhoneTargetSchema,
    type: z.literal("swipe"),
  }),
  /** Press, hold until the item lifts, then move it, as when reordering or dragging a slider. */
  z.strictObject({
    durationMs: z.number().int().min(100).max(5_000).default(600),
    from: AndroidPhoneTargetSchema,
    holdMs: z.number().int().min(400).max(3_000).default(600),
    to: AndroidPhoneTargetSchema,
    type: z.literal("drag"),
  }),
  /**
   * Inserts `text` at the field's cursor, replacing any selected text, the way
   * typing does. Without a target it goes to the field that has input focus
   * after the earlier actions in the batch. `submit` then presses the
   * keyboard's action key, which is Send, Search or Done as the field declares.
   */
  z.strictObject({
    submit: z.boolean().default(false),
    target: AndroidPhoneTargetSchema.optional(),
    text: z.union([z.string().min(1).max(5_000), LoginTextSchema]),
    type: z.literal("type"),
  }),
  z.strictObject({ target: AndroidPhoneTargetSchema, type: z.literal("clear") }),
  z.strictObject({ to: AndroidPhoneNavigationSchema, type: z.literal("navigate") }),
  z.strictObject({ packageName: AndroidPackageNameSchema, type: z.literal("launch") }),
  /**
   * Scrolls the content under the target with `amount` bounded swipes over
   * it, toward the content that should move into view. How far the content
   * moves is the app's to decide, so the next observation says where it is.
   */
  z.strictObject({
    amount: z.number().int().min(1).max(20),
    direction: z.enum(["up", "down", "left", "right"]),
    target: AndroidPhoneTargetSchema,
    type: z.literal("scroll"),
  }),
  /** Turns the screen on. An observation of a dark screen says so, and this is the answer to it. */
  z.strictObject({ type: z.literal("wake") }),
  z.strictObject({ ms: z.number().int().min(1).max(5_000), type: z.literal("wait") }),
] as const;
export const AndroidPhoneActionSchema = z.discriminatedUnion("type", androidPhoneActionVariants);
export type AndroidPhoneAction = z.infer<typeof AndroidPhoneActionSchema>;

const [tapAction, longPressAction, swipeAction, dragAction, typeAction, ...otherActions] =
  androidPhoneActionVariants;
export const AndroidPhoneDispatchActionSchema = z.discriminatedUnion("type", [
  tapAction,
  longPressAction,
  swipeAction,
  dragAction,
  typeAction.extend({ text: z.union([typeAction.shape.text.options[0], SealedLoginTextSchema]) }),
  ...otherActions,
]);
export type AndroidPhoneDispatchAction = z.infer<typeof AndroidPhoneDispatchActionSchema>;

type TimedAction = Exclude<AndroidPhoneAction, { type: "type" }> | { readonly type: "type" };

/** The time an action spends holding, moving or waiting, before the phone settles after it. */
export function androidPhoneTimedActionMs(action: TimedAction): number {
  switch (action.type) {
    case "longPress":
    case "swipe":
      return action.durationMs;
    case "drag":
      return action.holdMs + action.durationMs;
    case "wait":
      return action.ms;
    case "scroll":
      return action.amount * androidPhoneScrollStepMs;
    case "tap":
    case "type":
    case "clear":
    case "navigate":
    case "launch":
    case "wake":
      return 0;
  }
}

/** One scroll step's swipe, which `androidPhoneTimedActionMs` charges against the batch. */
export const androidPhoneScrollStepMs = 350;

export const AndroidPhoneActionsSchema = z
  .array(AndroidPhoneActionSchema)
  .min(1)
  .max(computerUseMaxActions)
  .superRefine(validateTimedActions);

function validateTimedActions(actions: readonly TimedAction[], context: z.RefinementCtx): void {
  const total = actions.reduce((sum, action) => sum + androidPhoneTimedActionMs(action), 0);
  if (total > androidPhoneMaxTimedActionMs) {
    context.addIssue({
      code: "custom",
      message: `A batch may hold, move and wait for at most ${androidPhoneMaxTimedActionMs} ms in total; split it into more batches`,
    });
  }
}

export const AndroidPhoneDispatchActionsSchema = z
  .array(AndroidPhoneDispatchActionSchema)
  .min(1)
  .max(computerUseMaxActions)
  .superRefine(validateTimedActions);

/** `act` cites the observation it was decided from, exactly as on a Mac. */
export const AndroidPhoneActParamsSchema = z.strictObject({
  actions: AndroidPhoneActionsSchema,
  observationId: ComputerUseObservationIdSchema,
});
export type AndroidPhoneActParams = z.infer<typeof AndroidPhoneActParamsSchema>;

export const AndroidPhoneDispatchActParamsSchema = AndroidPhoneActParamsSchema.extend({
  actions: AndroidPhoneDispatchActionsSchema,
  includeScreenshot: z.boolean(),
  loginContext: LoginActContextSchema.optional(),
}).superRefine(validateSealedLoginActionBindings);
export type AndroidPhoneDispatchActParams = z.infer<typeof AndroidPhoneDispatchActParamsSchema>;

/** Why an observation carries no screenshot, so an agent knows whether asking again can help. */
export const AndroidPhoneScreenshotUnavailableSchema = z.enum([
  // The engine or model this Run uses cannot take a picture; the Host did not ask.
  "not-requested",
  // The screen is off; `wake` turns it on.
  "screen-off",
  // The Opensteer Agent Phone app itself is in front: its screens are the
  // owner's, and they name the Deployment the phone works for.
  "opensteer-app",
  "failed",
]);
export type AndroidPhoneScreenshotUnavailable = z.infer<
  typeof AndroidPhoneScreenshotUnavailableSchema
>;

/** The reasons that hide the whole observation, not only its picture. */
type HiddenObservationReason = Extract<
  AndroidPhoneScreenshotUnavailable,
  "screen-off" | "opensteer-app"
>;
const hiddenObservationReasons: ReadonlySet<AndroidPhoneScreenshotUnavailable> =
  new Set<AndroidPhoneScreenshotUnavailable>(["screen-off", "opensteer-app"]);
const hiddenObservationSubject: Readonly<Record<HiddenObservationReason, string>> = {
  "opensteer-app": "the Opensteer Agent Phone app",
  "screen-off": "a dark screen",
};

/**
 * What an agent sees of the phone at one moment.
 *
 * Like a Mac observation it is a full snapshot whose indices are reassigned
 * every time, bound to what may be done next by `observationId` alone. The
 * screen state comes first because a phone, unlike a Mac, is dark most of the
 * time: `screen: "off"` arrives with an empty tree, and the agent's answer is
 * the `wake` action.
 *
 * `locked` is whether the lock screen is showing now; `secureLock` is whether
 * one that needs a PIN, pattern or password is configured. When both are true,
 * the agent must enter that credential to reach the phone's apps.
 *
 * With the Opensteer Agent Phone app itself in front, nothing of the screen is
 * shared either, but `foreground` still names the app, so an agent knows why
 * and that navigating away is its answer.
 */
export const AndroidPhoneObservationSchema = z
  .strictObject({
    capturedAt: IsoDateTimeSchema,
    elementCount: z.number().int().nonnegative().max(computerUseMaxElements),
    foreground: z
      .strictObject({
        label: z.string().min(1).max(255).nullable(),
        packageName: AndroidPackageNameSchema,
      })
      .nullable(),
    /** The screenshot's pixel size, which is also the space every point and tree frame uses. */
    geometry: z.strictObject({
      height: z.number().int().positive().max(10_000),
      width: z.number().int().positive().max(10_000),
    }),
    locked: z.boolean(),
    observationId: ComputerUseObservationIdSchema,
    rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
    screen: z.enum(["on", "off"]),
    screenshot: ComputerUseScreenshotSchema.nullable(),
    screenshotUnavailable: AndroidPhoneScreenshotUnavailableSchema.nullable(),
    secureLock: z.boolean(),
    tree: z.string().max(computerUseTreeMaxBytes),
    /** Whether the element cap cut the tree, which the tree also states. */
    truncated: z.boolean(),
  })
  .superRefine((observation, context) => {
    // What an agent may see is decided here, at the boundary the Host parses,
    // rather than trusted to the phone: a dark screen has nothing to share,
    // and the Opensteer app's own screens are the owner's.
    const hidden: HiddenObservationReason | null =
      observation.screen === "off"
        ? "screen-off"
        : observation.foreground?.packageName === agentPhonePackageName
          ? "opensteer-app"
          : null;
    if (hidden !== null) {
      if (
        observation.tree !== "" ||
        observation.elementCount !== 0 ||
        observation.truncated ||
        observation.screenshot !== null ||
        observation.screenshotUnavailable !== hidden
      ) {
        context.addIssue({
          code: "custom",
          message: `An observation of a phone showing ${hiddenObservationSubject[hidden]} carries no elements and no screenshot, and says why`,
          path: ["tree"],
        });
      }
    } else if (
      observation.screenshotUnavailable !== null &&
      hiddenObservationReasons.has(observation.screenshotUnavailable)
    ) {
      context.addIssue({
        code: "custom",
        message: `${observation.screenshotUnavailable} explains only an observation that is hidden for that reason`,
        path: ["screenshotUnavailable"],
      });
    }
    if ((observation.screenshot === null) === (observation.screenshotUnavailable === null)) {
      context.addIssue({
        code: "custom",
        message: "An observation carries either a screenshot or the reason it has none",
        path: ["screenshotUnavailable"],
      });
    }
    if (new TextEncoder().encode(observation.tree).byteLength > computerUseTreeMaxBytes) {
      context.addIssue({
        code: "custom",
        message: `An observation tree must be at most ${computerUseTreeMaxBytes} bytes of UTF-8`,
        path: ["tree"],
      });
    }
    if (observation.screenshot !== null) {
      const { height, width } = observation.screenshot;
      if (width !== observation.geometry.width || height !== observation.geometry.height) {
        context.addIssue({
          code: "custom",
          message: "An observation's geometry is its screenshot's size",
          path: ["geometry"],
        });
      }
    }
  });
export type AndroidPhoneObservation = z.infer<typeof AndroidPhoneObservationSchema>;

export const AndroidPhoneObservationResultSchema = z.strictObject({
  observation: AndroidPhoneObservationSchema,
});
export type AndroidPhoneObservationResult = z.infer<typeof AndroidPhoneObservationResultSchema>;

/** A failed batch may have changed the phone; its progress and resulting state travel together. */
export const AndroidPhoneActResultSchema = z
  .strictObject({
    error: ComputerUseErrorSchema.shape.error.nullable(),
    observation: AndroidPhoneObservationSchema.nullable(),
    /** One entry per fully completed action, in order; its length is the completed count. */
    performed: z.array(ComputerUsePerformedSchema).max(computerUseMaxActions),
  })
  .refine((result) => result.error !== null || result.observation !== null, {
    message: "A successful action batch must include its resulting observation",
    path: ["observation"],
  })
  .refine((result) => result.error?.code !== "stale-observation" || result.performed.length === 0, {
    message: "A stale observation refuses the batch before any action runs",
    path: ["performed"],
  });
export type AndroidPhoneActResult = z.infer<typeof AndroidPhoneActResultSchema>;

/**
 * Where a phone reaches the Deployment that enrolled it, as the Host itself
 * says: the Host knows the address it is served at — a server's public
 * origin, a Personal Deployment's live remote-access route — and a client
 * guessing it would hand a phone the loopback address of the Mac it sits on.
 *
 * The identifiers let the phone confirm, before it spends its one-use
 * enrollment token, that the server answering at `hostUrl` is this
 * Deployment's Host rather than whatever an address now points at.
 */
export const AgentPhoneHostUrlSchema = CanonicalOriginSchema.refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHostname(url.hostname))
  );
}, "A phone reaches Opensteer over HTTPS, or over HTTP only to its own loopback address.");

/**
 * What the phone calls the Deployment it works for — "Opensteer on Mac mini" —
 * as the Host names it: the Deployment's own name, which for a Personal
 * Deployment is the Mac it runs on. A phone shows it to its owner wherever it
 * would otherwise show an address.
 */
export const AgentPhoneDeploymentNameSchema = z.string().trim().min(1).max(120);

export const AgentPhoneHostTargetSchema = z.strictObject({
  deploymentId: DeploymentIdSchema,
  deploymentName: AgentPhoneDeploymentNameSchema,
  hostInstanceId: HostInstanceIdSchema,
  hostUrl: AgentPhoneHostUrlSchema,
});
export type AgentPhoneHostTarget = z.infer<typeof AgentPhoneHostTargetSchema>;
export const AgentPhoneHostTargetViewSchema = z.object(AgentPhoneHostTargetSchema.shape);

/**
 * What setup hands the Agent Phone app over USB: everything it needs to enroll
 * itself, and nothing it could use to act for the person — the enrollment
 * token only ever admits this one phone, with only its screen.
 */
export const AgentPhonePairingSchema = AgentPhoneHostTargetSchema.extend({
  enrollmentId: z.string().min(1).max(256),
  enrollmentToken: z.string().min(32).max(4_096),
  expiresAt: IsoDateTimeSchema,
  runnerName: z.string().trim().min(1).max(120),
  version: z.literal(1),
});
export type AgentPhonePairing = z.infer<typeof AgentPhonePairingSchema>;

/**
 * Why the phone is not, or not yet, working for its Deployment, in words setup
 * and the phone's own screen both show.
 */
export const AgentPhoneIssueCodeSchema = z.enum([
  // The token's ten minutes ran out before the phone could use it.
  "enrollment-expired",
  // The Host refused the token or this phone's identity for another reason.
  "enrollment-refused",
  // Nothing answered at the address, or it was not a reachable Opensteer.
  "host-unreachable",
  // Something answered at the address, but it is not this Deployment's Host.
  "host-mismatch",
  // A Personal Deployment with remote access off has no route to arrive on.
  "remote-access-off",
  // The phone was removed from the Deployment; only setup again brings it back.
  "removed",
  // Android turned off the accessibility service the app works through.
  "accessibility-off",
  // The Host keeps sending what this app cannot read, connection after
  // connection; installing the app the Host's Opensteer carries ends it.
  "protocol-error",
  "needs-update",
  "failed",
]);
export type AgentPhoneIssueCode = z.infer<typeof AgentPhoneIssueCodeSchema>;

/**
 * The phone app's answer to setup's `status` command.
 *
 * It travels as an ordered broadcast's result data, which Android also writes
 * to its log, so it carries no enrollment token.
 */
export const AgentPhoneSetupStatusSchema = z.strictObject({
  accessibility: z.strictObject({
    /** Listed in the secure setting that enables accessibility services. */
    enabled: z.boolean(),
    /** Bound and running: the only state in which the phone can work. */
    connected: z.boolean(),
  }),
  app: z.strictObject({
    versionCode: z.number().int().positive(),
    versionName: z.string().min(1).max(64),
  }),
  batteryOptimizationExempt: z.boolean(),
  connection: z.enum([
    "unpaired",
    "pairing",
    "connecting",
    "online",
    "offline",
    "removed",
    "needs-update",
  ]),
  issue: z
    .strictObject({ code: AgentPhoneIssueCodeSchema, detail: z.string().min(1).max(500) })
    .nullable(),
  pairing: z
    .strictObject({
      deploymentId: DeploymentIdSchema,
      /** The name it was last given, which setup compares to send a rename. */
      deploymentName: AgentPhoneDeploymentNameSchema,
      enrollmentId: z.string().min(1).max(256),
      hostUrl: AgentPhoneHostUrlSchema,
      /** Known once the phone has an identity, which it keeps from before its first enrollment. */
      runnerId: RunnerIdSchema,
    })
    .nullable(),
  paused: z.boolean(),
  version: z.literal(1),
});
export type AgentPhoneSetupStatus = z.infer<typeof AgentPhoneSetupStatusSchema>;

/**
 * The Agent Phone app's identity on Android, which setup addresses it by over
 * USB. The broadcast receiver is exported only to holders of
 * `android.permission.DUMP` — the ADB shell and the system — so these names
 * are an address, not an invitation.
 */
export const agentPhoneAccessibilityService = `${agentPhonePackageName}/${agentPhonePackageName}.control.AgentPhoneAccessibilityService`;
export const agentPhoneSetupReceiver = `${agentPhonePackageName}/${agentPhonePackageName}.setup.SetupReceiver`;
export const agentPhoneSetupActions = {
  pair: `${agentPhonePackageName}.action.PAIR`,
  /**
   * Brings a phone paired to this Deployment up to date with its Host — the
   * address it gives now and the name it has now — keeping its identity: a
   * Personal Deployment whose remote-access route changed, or that was
   * renamed, is still the Deployment the phone joined. A phone still waiting
   * for its first welcome moves too, keeping the token it has not yet spent.
   */
  retarget: `${agentPhonePackageName}.action.RETARGET`,
  status: `${agentPhonePackageName}.action.STATUS`,
  unpair: `${agentPhonePackageName}.action.UNPAIR`,
} as const;
/**
 * The broadcast extra carrying a command's base64url JSON: `AgentPhonePairing`
 * for PAIR, `AgentPhoneHostTarget` for RETARGET.
 */
export const agentPhonePairingExtra = "payload";
/** The oldest Android the app runs on: API 30 is where an accessibility service can take screenshots. */
export const agentPhoneMinSdk = 30;
/** The largest Agent Phone APK a build may carry, and every reader of it accepts. */
export const agentPhoneApkMaxBytes = 24 * 1_024 * 1_024;

/**
 * What a build of the Agent Phone app says about its APK, written beside it
 * by the build and checked by setup before a single byte reaches a phone.
 */
export const AgentPhoneArtifactManifestSchema = z.strictObject({
  apkSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  apkSize: z.number().int().positive().max(agentPhoneApkMaxBytes),
  buildType: z.enum(["debug", "release"]),
  minSdk: z.number().int().min(agentPhoneMinSdk),
  packageName: z.literal(agentPhonePackageName),
  /** SHA-256 of the signing certificate, the identity Android preserves across updates. */
  signingCertSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  versionCode: z.number().int().positive(),
  versionName: z.string().min(1).max(64),
});
export type AgentPhoneArtifactManifest = z.infer<typeof AgentPhoneArtifactManifestSchema>;

/**
 * The result code the setup receiver answers a command with, as Android's
 * ordered broadcast carries it; `am broadcast` prints it as `result=<code>`.
 * `applied` is `Activity.RESULT_OK`, which a repeated command that was
 * already in effect also answers.
 */
export const agentPhoneSetupResultCodes = {
  applied: -1,
  invalidPayload: 1,
  alreadyPaired: 2,
  unknownCommand: 3,
  failed: 4,
  /** RETARGET reached a phone holding no identity for any Deployment; it pairs instead. */
  notEnrolled: 5,
} as const;

/** The permanent signer shared by release packaging, the Host and the Android build. */
export const agentPhoneReleaseSignerSha256 = agentPhoneRelease.signingCertSha256;

export const AgentPhoneReleaseReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/u),
  version: z.string().regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u),
  apkSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  apkSize: z.number().int().positive().max(agentPhoneApkMaxBytes),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  signingCertSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type AgentPhoneReleaseReceipt = z.infer<typeof AgentPhoneReleaseReceiptSchema>;

/** Stable update protocol 1 is independent of the phone's integrations contract. */
export const AgentPhoneUpdateOfferSchema = z.strictObject({
  type: z.literal("host.agent-phone.update"),
  protocolVersion: z.literal(1),
  release: z
    .strictObject({
      manifestJson: z.string().min(1).max(16_384),
      receipt: AgentPhoneReleaseReceiptSchema,
    })
    .nullable(),
});

export const AgentPhoneUpdateStatusSchema = z.strictObject({
  type: z.literal("phone.update.status"),
  apkSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  state: z.enum(["downloading", "installing", "awaiting-user", "failed"]),
});
