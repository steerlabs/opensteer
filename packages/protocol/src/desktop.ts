import { BrowserOpenIdentitySchema } from "./browser.js";
import { type DisplayClientDiagnostic } from "./display-stream.js";
import type { DictationPort } from "./dictation.js";
export { DisplayClientDiagnosticSchema } from "./display-stream.js";
import { HostCapabilitySchema } from "@opensteer/deployment-authority";
import { ComputerViewRefSchema } from "./computer-view.js";
import { ComputerAppIdentitySchema } from "@opensteer/core";
import {
  BrowserSessionIdSchema,
  BrowserSurfaceIdSchema,
  CanonicalOriginSchema,
  DeploymentIdSchema,
  UserIdSchema,
  MessageIdSchema,
  DeploymentDisplayKindSchema,
  EnvironmentIdSchema,
  IsoDateTimeSchema,
  NotificationIdSchema,
  NotificationViewSchema,
  RequestIdSchema,
  RunnerIdSchema,
  ThreadIdSchema,
  MarkColorSchema,
  WorkspaceIconNameSchema,
  isBareOrigin,
  isSecureOrLoopbackOrigin,
  requestReasonMaxLength,
} from "@opensteer/core";
import { z } from "zod";
import {
  ComputerAppBundleIdSchema,
  IntegrationAccessSchema,
  LocalMcpLaunchViewSchema,
} from "@opensteer/integration-core";
import {
  ComputerUsePermissionsViewSchema,
  ComputerUsePermissionPaneSchema,
  ComputerUsePermissionsRequestParamsSchema,
  ComputerUseRiskSchema,
  computerUseIconMaxBase64Length,
  ComputerUseDataAppIdSchema,
  ComputerUseDataGrantSchema,
} from "./computer-use.js";
import {
  CloudDeploymentOperationIdSchema,
  DeleteCloudDeploymentRequestSchema,
  type CloudDeploymentOperation,
  type CreateCloudDeploymentRequest,
  type ListCloudDeploymentsResponse,
} from "@opensteer/control-plane-protocol";
export type { CloudDeploymentOperation } from "@opensteer/control-plane-protocol";
import { AgentPhoneArtifactManifestSchema, agentPhoneApkMaxBytes } from "./android-phone.js";
import { PersonalPairingCodeSchema } from "./personal-remote-access.js";
import type {
  DesktopConfigurePersonalRemoteAccessInput,
  DesktopPersonalPairingCode,
  DesktopPersonalRemoteAccessStatus,
} from "./personal-remote-access.js";

export {
  DesktopConfigurePersonalRemoteAccessInputSchema,
  DesktopPersonalPairingCodeSchema,
  DesktopPersonalRemoteAccessPhaseSchema,
  DesktopPersonalRemoteAccessStatusSchema,
  PersonalRemoteAccessModeSchema,
} from "./personal-remote-access.js";
export type {
  DesktopConfigurePersonalRemoteAccessInput,
  DesktopPersonalPairingCode,
  DesktopPersonalRemoteAccessPhase,
  DesktopPersonalRemoteAccessStatus,
  PersonalRemoteAccessMode,
} from "./personal-remote-access.js";
import type {
  DesktopPasswordsSignInApproveInput,
  DesktopPasswordsSignInApproveResult,
  DesktopPasswordsSignInCardInput,
  DesktopPasswordsSignInCardState,
  DesktopPasswordsStatus,
} from "./desktop-passwords.js";
export {
  DesktopPasswordsSignInApproveInputSchema,
  DesktopPasswordsSignInApproveResultSchema,
  DesktopPasswordsSignInCardChangedSchema,
  DesktopPasswordsSignInCardInputSchema,
  DesktopPasswordsSignInCardStateSchema,
  DesktopPasswordsStatusSchema,
} from "./desktop-passwords.js";
export type {
  DesktopPasswordsSignInApproveInput,
  DesktopPasswordsSignInApproveResult,
  DesktopPasswordsSignInCardChanged,
  DesktopPasswordsSignInCardInput,
  DesktopPasswordsSignInCardState,
  DesktopPasswordsStatus,
} from "./desktop-passwords.js";

/**
 * `windows` is a first-class local-execution platform even though PortableFS
 * does not run there: a Windows machine can hold its own Workspace directories
 * and run agents on them, which is what lending a computer is for.
 */
export const DesktopLocalExecutionPlatformSchema = z.enum([
  "linux",
  "macos",
  "windows",
  "unsupported",
]);

export const DesktopPortableFsStateSchema = z.enum([
  "checking",
  "installing",
  "missing",
  "needs-user-approval",
  "ready-to-mount",
  "unsupported",
  "failed",
]);
export type DesktopPortableFsState = z.infer<typeof DesktopPortableFsStateSchema>;

/**
 * Stable PortableFS mount-readiness issue. Opensteer preserves this machine
 * code so the Desktop UI can offer a platform-specific repair without ever
 * parsing PortableFS's human-readable diagnostics. New PortableFS issue codes
 * remain forward-compatible and still render their supplied detail.
 */
export const DesktopPortableFsIssueSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
  .nullable();
export type DesktopPortableFsIssue = z.infer<typeof DesktopPortableFsIssueSchema>;

export const DesktopRunnerStateSchema = z.enum([
  "disabled",
  "starting",
  "running",
  "stopping",
  "failed",
]);

export const DesktopLocalExecutionStatusSchema = z
  .strictObject({
    available: z.boolean(),
    /** The operating system's name for this computer; the default machine name. */
    computerName: z.string().trim().min(1).max(120),
    deploymentId: DeploymentIdSchema,
    /** Whether this Deployment's grant lets this computer run agents (server only). */
    mayRunAgents: z.boolean(),
    platform: DesktopLocalExecutionPlatformSchema,
    portableFs: z.strictObject({
      binaryPath: z.string().min(1).max(4_096).nullable(),
      detail: z.string().min(1).max(2_000),
      installAvailable: z.boolean(),
      issue: DesktopPortableFsIssueSchema,
      state: DesktopPortableFsStateSchema,
      version: z.string().min(1).max(255).nullable(),
    }),
    /** Whether the Runner is asked to advertise `agents` while it runs here. */
    runAgents: z.boolean(),
    runner: z.strictObject({
      detail: z.string().min(1).max(2_000),
      enrolled: z.boolean(),
      environmentId: EnvironmentIdSchema.nullable(),
      runnerId: RunnerIdSchema.nullable(),
      state: DesktopRunnerStateSchema,
    }),
    schemaVersion: z.literal(4),
  })
  .superRefine((status, context) => {
    if (
      !status.available &&
      (status.portableFs.binaryPath !== null ||
        status.portableFs.installAvailable ||
        status.portableFs.issue !== null ||
        status.portableFs.state !== "unsupported" ||
        status.portableFs.version !== null ||
        status.runner.enrolled ||
        status.runner.environmentId !== null ||
        status.runner.runnerId !== null ||
        status.runner.state !== "disabled")
    ) {
      context.addIssue({
        code: "custom",
        message: "Unavailable local execution must be an inert status",
        path: ["available"],
      });
    }
  });
export type DesktopLocalExecutionStatus = z.infer<typeof DesktopLocalExecutionStatusSchema>;

export const DesktopLocalExecutionInputSchema = z.strictObject({
  deploymentId: DeploymentIdSchema,
});
export type DesktopLocalExecutionInput = z.infer<typeof DesktopLocalExecutionInputSchema>;

export const DesktopStartLocalRunnerInputSchema = z.strictObject({
  deploymentId: DeploymentIdSchema,
  enrollmentToken: z.string().min(32).max(4_096).optional(),
  /**
   * Whether the Runner advertises `agents`. Starting a running slot with the
   * other value restarts it with the other module set; identity is untouched.
   */
  runAgents: z.boolean(),
  runnerName: z.string().trim().min(1).max(120),
});
export type DesktopStartLocalRunnerInput = z.infer<typeof DesktopStartLocalRunnerInputSchema>;

export const DesktopPersonalDeploymentStateSchema = z.enum([
  "checking",
  "stopped",
  "starting",
  "ready",
  "degraded",
  "repair-required",
  "stopping",
  "update-required",
]);
export type DesktopPersonalDeploymentState = z.infer<typeof DesktopPersonalDeploymentStateSchema>;

export const DesktopPersonalDeploymentStepSchema = z.enum([
  "checking-computer",
  "preparing-database",
  "starting-host",
  "creating-main",
  "starting-local-agents",
  "connecting-computer",
  "ready",
]);
export type DesktopPersonalDeploymentStep = z.infer<typeof DesktopPersonalDeploymentStepSchema>;

export const DesktopPersonalComponentStateSchema = z.enum([
  "stopped",
  "starting",
  "ready",
  "degraded",
  "failed",
  "stopping",
]);
export type DesktopPersonalComponentState = z.infer<typeof DesktopPersonalComponentStateSchema>;

const DesktopPersonalComponentStatusSchema = z.strictObject({
  state: DesktopPersonalComponentStateSchema,
  version: z.string().trim().min(1).max(120).nullable(),
});

export const DesktopPersonalDeploymentIssueCodeSchema = z.enum([
  "release-missing",
  "release-incompatible",
  "release-tampered",
  "protected-storage-unavailable",
  "protected-state-unreadable",
  "directory-invalid",
  "disk-space-insufficient",
  "private-port-unavailable",
  "database-initialization-failed",
  "database-unavailable",
  "host-unavailable",
  "host-authority-mismatch",
  "personal-bootstrap-unavailable",
  "provider-environment-unavailable",
  "runner-unavailable",
  "browser-unavailable",
  "messaging-unavailable",
  "service-crash-loop",
  "shutdown-incomplete",
  "update-incompatible",
  "unexpected",
]);

export const DesktopPersonalDeploymentIssueSchema = z.strictObject({
  code: DesktopPersonalDeploymentIssueCodeSchema,
  component: z.enum(["desktop", "postgresql", "host", "runner", "browser", "messaging"]),
  detail: z.string().trim().min(1).max(2_000),
  repairAction: z.enum([
    "install-compatible-release",
    "free-disk-space",
    "restore-permissions",
    "open-diagnostics",
    "restart-opensteer",
    "update-opensteer",
  ]),
});
export type DesktopPersonalDeploymentIssue = z.infer<typeof DesktopPersonalDeploymentIssueSchema>;

/**
 * The Personal setup snapshot is intentionally free of paths, ports, command
 * lines, credentials, and child logs. Those remain private to Electron main.
 */
export const DesktopPersonalDeploymentStatusSchema = z.strictObject({
  canStart: z.boolean(),
  components: z.strictObject({
    browser: DesktopPersonalComponentStatusSchema,
    host: DesktopPersonalComponentStatusSchema,
    /**
     * The one optional service in the graph: messaging carries Slack, and a
     * Deployment with no messaging account connected still works without it.
     * A failure here is reported next to the others and never stops the rest.
     */
    messaging: DesktopPersonalComponentStatusSchema,
    postgresql: DesktopPersonalComponentStatusSchema,
    runner: DesktopPersonalComponentStatusSchema,
  }),
  deploymentId: DeploymentIdSchema.nullable(),
  environmentId: EnvironmentIdSchema.nullable(),
  issue: DesktopPersonalDeploymentIssueSchema.nullable(),
  schemaVersion: z.literal(1),
  state: DesktopPersonalDeploymentStateSchema,
  step: DesktopPersonalDeploymentStepSchema.nullable(),
});
export type DesktopPersonalDeploymentStatus = z.infer<typeof DesktopPersonalDeploymentStatusSchema>;

/** One app the helper serves, set up on this Mac at the access its connection allows. */
export const DesktopOpenComputerAppSetupInputSchema = z.strictObject({
  access: IntegrationAccessSchema,
  definitionId: ComputerUseDataAppIdSchema,
});
export type DesktopOpenComputerAppSetupInput = z.infer<
  typeof DesktopOpenComputerAppSetupInputSchema
>;

/** False when macOS already gives everything that access needs. */
export const DesktopOpenComputerAppSetupResultSchema = z.strictObject({ opened: z.boolean() });
export type DesktopOpenComputerAppSetupResult = z.infer<
  typeof DesktopOpenComputerAppSetupResultSchema
>;

/**
 * One macOS step: `settings` is a switch only System Settings gives (Full
 * Disk Access, or a grant macOS refused before), `ask` a question macOS asks
 * in place.
 */
export const DesktopComputerAppSetupStepSchema = z.strictObject({
  grant: ComputerUseDataGrantSchema,
  kind: z.enum(["settings", "ask"]),
  state: z.enum(["waiting", "current", "done"]),
});
export type DesktopComputerAppSetupStep = z.infer<typeof DesktopComputerAppSetupStepSchema>;

/**
 * The setup panel's whole picture. `offer` waits for the person's Set up;
 * `steps` takes them; `done` lingers and closes. `appName` is this app as
 * macOS lists it, struck out in the panel when `thisAppHasFullDiskAccess`,
 * because that grant is not the one the helper reads with. `appIconPng` is the
 * target app's icon from the helper (base64 PNG), or null.
 */
export const DesktopComputerAppSetupSchema = z.strictObject({
  appIconPng: z.string().max(computerUseIconMaxBase64Length).nullable(),
  appName: z.string().min(1).max(120),
  definitionId: ComputerUseDataAppIdSchema,
  helperReachable: z.boolean(),
  phase: z.enum(["offer", "steps", "done"]),
  steps: z.array(DesktopComputerAppSetupStepSchema).min(1).max(2),
  targetName: z.string().min(1).max(60),
  thisAppHasFullDiskAccess: z.boolean(),
});
export type DesktopComputerAppSetup = z.infer<typeof DesktopComputerAppSetupSchema>;

/**
 * The app the setup panel showed when the person acted. Main ignores an act
 * that arrives after another app replaced it.
 */
export const DesktopComputerAppSetupTargetSchema = z.strictObject({
  definitionId: ComputerUseDataAppIdSchema,
});
export type DesktopComputerAppSetupTarget = z.infer<typeof DesktopComputerAppSetupTargetSchema>;

/** Null when nothing is being set up, which closes the panel. */
export const DesktopComputerAppSetupStatusSchema = z.strictObject({
  setup: DesktopComputerAppSetupSchema.nullable(),
});
export type DesktopComputerAppSetupStatus = z.infer<typeof DesktopComputerAppSetupStatusSchema>;

/** Desktop main verifies selected deployment + authenticated local machine + the view's exact app. */
export const DesktopUseComputerViewInputSchema = ComputerViewRefSchema.extend({
  deploymentId: DeploymentIdSchema,
  machineId: RunnerIdSchema,
  app: ComputerAppIdentitySchema,
});
export type DesktopUseComputerViewInput = z.infer<typeof DesktopUseComputerViewInputSchema>;
export const DesktopUseComputerViewResultSchema = z.discriminatedUnion("activated", [
  z.strictObject({ activated: z.literal(true) }),
  z.strictObject({
    activated: z.literal(false),
    reason: z.enum([
      "deployment-changed",
      "not-local",
      "view-ended",
      "app-changed",
      "permission-required",
      "unavailable",
    ]),
  }),
]);
export type DesktopUseComputerViewResult = z.infer<typeof DesktopUseComputerViewResultSchema>;
/**
 * This desktop's approval key, which the computer's page on this Mac registers
 * with the Host for this Mac's Runner (`integration.computer.approval-key.set`).
 * The private half never leaves desktop main; `keyId` is the fingerprint the
 * Host reports back in `MachineSummary.computerUse.approvalKeyId`, so the page
 * can tell whether the registered key is this desktop's.
 */
export const DesktopComputerUseApprovalKeyResultSchema = z.strictObject({
  keyId: z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/u),
  publicKey: z.string().min(1).max(512),
});
export type DesktopComputerUseApprovalKeyResult = z.infer<
  typeof DesktopComputerUseApprovalKeyResultSchema
>;

/**
 * One open approval, named by a token the main process minted.
 *
 * The panel is handed a token and nothing else: the presentation it renders is
 * read back from the main process, so a page cannot name an app, an access
 * level or a Deployment that nobody asked about, and a token the main process
 * has already answered is refused rather than answered twice.
 */
export const DesktopComputerUseApprovalTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
export type DesktopComputerUseApprovalToken = z.infer<typeof DesktopComputerUseApprovalTokenSchema>;

export const DesktopComputerUseApprovalInputSchema = z.strictObject({
  token: DesktopComputerUseApprovalTokenSchema,
});
export type DesktopComputerUseApprovalInput = z.infer<typeof DesktopComputerUseApprovalInputSchema>;

/**
 * The app the panel shows, as the Mac itself resolved it.
 *
 * It is the resolved app flattened to what a person reads — there is no team
 * identifier here, because nobody approves a team. `path` is shown when a name
 * could mean two things; `iconPng` is null for a definition whose connection
 * names no app (Messages and every app like it) and for an app the helper
 * could not draw; `risk` and `reason` are the helper's own verdict about the
 * app, never the Host's.
 */
export const DesktopComputerUseApprovalAppSchema = z.strictObject({
  bundleId: ComputerAppBundleIdSchema,
  displayName: z.string().min(1).max(255),
  iconPng: z
    .string()
    .regex(/^[A-Za-z0-9+/]*={0,2}$/u)
    .max(computerUseIconMaxBase64Length)
    .nullable(),
  path: z.string().min(1).max(4_096).nullable(),
  reason: z.string().min(1).max(1_000).nullable(),
  risk: ComputerUseRiskSchema,
});
export type DesktopComputerUseApprovalApp = z.infer<typeof DesktopComputerUseApprovalAppSchema>;

/**
 * What the approval panel renders: one app, or the Mac's automatic policy.
 *
 * An app request names the task that asked when there is one. `threadTitle`,
 * `workspaceName` and `reason` are null for a request the person started from
 * the picker, and each is null on its own when that context is absent. The
 * Host snapshots the labels in the signed setup request. A
 * policy request names no app: it is the one question whose answer covers
 * every app on this Mac, so it carries only where it applies.
 */
export const DesktopComputerUseApprovalPresentationSchema = z.discriminatedUnion("kind", [
  z.object({
    access: IntegrationAccessSchema,
    /** The exact access in the product's words. */
    accessLabel: z.string().min(1).max(80),
    accessSummary: z.string().min(1).max(500),
    app: DesktopComputerUseApprovalAppSchema,
    deploymentName: z.string().min(1).max(200),
    kind: z.literal("app"),
    machineName: z.string().min(1).max(200),
    reason: z.string().min(1).max(requestReasonMaxLength).nullable(),
    threadTitle: z.string().min(1).max(240).nullable(),
    token: DesktopComputerUseApprovalTokenSchema,
    workspaceName: z.string().min(1).max(160).nullable(),
  }),
  z.object({
    appApproval: z.literal("automatic"),
    deploymentName: z.string().min(1).max(200),
    kind: z.literal("policy"),
    machineName: z.string().min(1).max(200),
    token: DesktopComputerUseApprovalTokenSchema,
  }),
  /** An MCP server to run on this Mac, shown exactly as it will run. */
  z.object({
    deploymentName: z.string().min(1).max(200),
    installationTitle: z.string().min(1).max(160),
    kind: z.literal("server"),
    launch: LocalMcpLaunchViewSchema,
    machineName: z.string().min(1).max(200),
    serverName: z.string().min(1).max(128),
    token: DesktopComputerUseApprovalTokenSchema,
  }),
]);
export type DesktopComputerUseApprovalPresentation = z.infer<
  typeof DesktopComputerUseApprovalPresentationSchema
>;

/**
 * A setup request the page just created, by id, whose answer on this Mac the
 * page waits for.
 *
 * The page creates the request and nothing else: the Host pushes it to this
 * Mac's Runner, desktop main shows the panel from that push, and the answer
 * goes back over the same Runner stream. `allowed` is whether the person
 * allowed it and the Host took the approval; `false` is a refusal, or the
 * request ending some other way while it waited.
 */
export const DesktopReviewComputerAppSetupInputSchema = z.strictObject({
  setupRequestId: z.uuid(),
});
export type DesktopReviewComputerAppSetupInput = z.infer<
  typeof DesktopReviewComputerAppSetupInputSchema
>;
export const DesktopReviewComputerAppSetupResultSchema = z.strictObject({
  allowed: z.boolean(),
});
export type DesktopReviewComputerAppSetupResult = z.infer<
  typeof DesktopReviewComputerAppSetupResultSchema
>;

export const DesktopComputerUseApprovalRespondInputSchema = z.strictObject({
  allow: z.boolean(),
  token: DesktopComputerUseApprovalTokenSchema,
});
export type DesktopComputerUseApprovalRespondInput = z.infer<
  typeof DesktopComputerUseApprovalRespondInputSchema
>;

/** The two macOS grants as the helper sees them right now, on this Mac. */
export const DesktopComputerUsePermissionsResultSchema = ComputerUsePermissionsViewSchema;
export type DesktopComputerUsePermissionsResult = z.infer<
  typeof DesktopComputerUsePermissionsResultSchema
>;

/**
 * Which System Settings pane to open, by name rather than by URL.
 *
 * `openExternalUrl` refuses anything but web pages for the same reason it does for
 * Full Disk Access: a renderer that could name an `x-apple.systempreferences:`
 * target would hold a general way to launch system panes. The two panes this
 * feature needs live in the main process, and the page asks for one of them.
 */
export const DesktopComputerUseSettingsPaneSchema = ComputerUsePermissionPaneSchema;
export type DesktopComputerUseSettingsPane = z.infer<typeof DesktopComputerUseSettingsPaneSchema>;

export const DesktopOpenComputerUseSettingsInputSchema = ComputerUsePermissionsRequestParamsSchema;
export type DesktopOpenComputerUseSettingsInput = z.infer<
  typeof DesktopOpenComputerUseSettingsInputSchema
>;

/** A build that is not Developer ID signed refuses its own helper, so it opens no panel. */
export const DesktopOpenComputerUsePermissionsPanelResultSchema = z.union([
  z.strictObject({ opened: z.literal(true) }),
  z.strictObject({ opened: z.literal(false), reason: z.literal("unsigned-build") }),
]);
export type DesktopOpenComputerUsePermissionsPanelResult = z.infer<
  typeof DesktopOpenComputerUsePermissionsPanelResultSchema
>;

export const DesktopOpenIntegrationAuthorizationInputSchema = z.strictObject({
  attemptId: z
    .string()
    .regex(
      /^(?:ioa|imo)_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    ),
  launchTicket: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
});
export type DesktopOpenIntegrationAuthorizationInput = z.infer<
  typeof DesktopOpenIntegrationAuthorizationInputSchema
>;
export const DesktopOpenIntegrationAuthorizationResultSchema = z.strictObject({
  opened: z.literal(true),
});
export type DesktopOpenIntegrationAuthorizationResult = z.infer<
  typeof DesktopOpenIntegrationAuthorizationResultSchema
>;

/**
 * HTTPS anywhere, or a Personal Deployment's Chrome connect page on this
 * computer's loopback address: the default browser is the only place the
 * Opensteer extension can be reached from. Nothing else on loopback opens, so
 * a link an engine or Runner supplies cannot reach a local service.
 */
const loopbackExternalHostnames = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** The web app's `/connect/chrome` route; the fragment carries the one-use link. */
const loopbackChromeConnectPath = "/connect/chrome";
export function desktopExternalUrlAllowed(value: string): boolean {
  const url = new URL(value);
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return (
    url.protocol === "http:" &&
    loopbackExternalHostnames.has(url.hostname) &&
    url.pathname === loopbackChromeConnectPath &&
    url.search === ""
  );
}
export const DesktopOpenExternalUrlInputSchema = z.strictObject({
  url: z.url().refine(desktopExternalUrlAllowed, {
    message: "External links must use HTTPS",
  }),
});
export type DesktopOpenExternalUrlInput = z.infer<typeof DesktopOpenExternalUrlInputSchema>;
export const DesktopOpenExternalUrlResultSchema = z.strictObject({ opened: z.literal(true) });
export type DesktopOpenExternalUrlResult = z.infer<typeof DesktopOpenExternalUrlResultSchema>;

/**
 * One notification the Host decided this person gets, as the operating system
 * shows it and as a click hands it back: the words to show and where they lead.
 * Title and body keep the Host's bounds, so every notification it sends fits.
 */
export const DesktopNotificationTargetSchema = z.strictObject({
  body: NotificationViewSchema.shape.body,
  deploymentId: DeploymentIdSchema,
  messageId: MessageIdSchema.nullable(),
  notificationId: NotificationIdSchema,
  requestId: RequestIdSchema.nullable(),
  threadId: ThreadIdSchema,
  title: NotificationViewSchema.shape.title,
});
export type DesktopNotificationTarget = z.infer<typeof DesktopNotificationTargetSchema>;
export const DesktopNotificationSupportSchema = z.strictObject({
  supported: z.boolean(),
});
export type DesktopNotificationSupport = z.infer<typeof DesktopNotificationSupportSchema>;
export const DesktopNotificationResultSchema = z.strictObject({
  status: z.enum(["shown", "unsupported"]),
});
export type DesktopNotificationResult = z.infer<typeof DesktopNotificationResultSchema>;
/**
 * The count on the app's icon: the questions waiting on the person in the
 * Deployment on screen. Zero clears it.
 */
export const DesktopBadgeCountInputSchema = z.strictObject({
  count: z.number().int().min(0).max(9_999),
});
export type DesktopBadgeCountInput = z.infer<typeof DesktopBadgeCountInputSchema>;

/**
 * Files this computer's browser pages and app windows saved to its Downloads
 * folder during this app run. Electron main owns them; a renderer names one
 * only by id, never by path.
 */
export const DesktopDownloadIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u);
export type DesktopDownloadId = z.infer<typeof DesktopDownloadIdSchema>;
/** Unfinished downloads main admits at once; it refuses more as failed. */
export const desktopDownloadsActiveLimit = 100;
/** Finished downloads the list keeps, newest first. */
export const desktopDownloadsFinishedLimit = 50;
export const DesktopDownloadSchema = z.strictObject({
  id: DesktopDownloadIdSchema,
  /** The saved file's name in the Downloads folder. */
  filename: z.string().min(1).max(255),
  /** The host name the file came from, without a port; null when its address names none, as a data: URL's. */
  site: z.string().min(1).max(253).nullable(),
  state: z.enum(["progressing", "completed", "cancelled", "failed"]),
  receivedBytes: z.number().int().nonnegative(),
  /** Null while the size is unknown. */
  totalBytes: z.number().int().nonnegative().nullable(),
});
export type DesktopDownload = z.infer<typeof DesktopDownloadSchema>;
export const DesktopDownloadsSnapshotSchema = z.strictObject({
  /** Newest first: every unfinished download, then the newest finished ones. */
  downloads: z
    .array(DesktopDownloadSchema)
    .max(desktopDownloadsActiveLimit + desktopDownloadsFinishedLimit),
});
export type DesktopDownloadsSnapshot = z.infer<typeof DesktopDownloadsSnapshotSchema>;
export const DesktopDownloadTargetSchema = z.strictObject({ id: DesktopDownloadIdSchema });
export type DesktopDownloadTarget = z.infer<typeof DesktopDownloadTargetSchema>;
/**
 * `missing`: no such download in the state the action needs, or its file was
 * moved or deleted. `failed`: the system could not open an existing file.
 */
export const DesktopDownloadActionResultSchema = z.strictObject({
  status: z.enum(["done", "missing", "failed"]),
});
export type DesktopDownloadActionResult = z.infer<typeof DesktopDownloadActionResultSchema>;

/** This computer's downloads, app-wide; every app window sees the same list. */
export interface DesktopDownloadsBridge {
  get(): Promise<DesktopDownloadsSnapshot>;
  onChanged(listener: (snapshot: DesktopDownloadsSnapshot) => void): () => void;
  /** Opens a completed download with its default app. */
  open(input: DesktopDownloadTarget): Promise<DesktopDownloadActionResult>;
  /** Reveals a completed download in Finder. */
  show(input: DesktopDownloadTarget): Promise<DesktopDownloadActionResult>;
  /** Stops an unfinished download and removes its partial file. */
  cancel(input: DesktopDownloadTarget): Promise<DesktopDownloadActionResult>;
}

/**
 * This app's own release updates. Electron main checks on its own; the person
 * starts the download and the restart that installs it.
 */
export const DesktopUpdateStateSchema = z.strictObject({
  /** `unavailable`: this copy cannot update itself, as outside Applications. */
  status: z.enum([
    "unavailable",
    "idle",
    "checking",
    "up-to-date",
    "available",
    "downloading",
    "downloaded",
    "error",
  ]),
  currentVersion: z.string().min(1).max(64),
  /** The newer version on offer, from `available` through `downloaded`, and after its download failed. */
  availableVersion: z.string().min(1).max(64).nullable(),
  /** Whole percent while `downloading`. */
  downloadPercent: z.number().int().min(0).max(100).nullable(),
  /** With `error`: whether the check or the download failed. */
  failed: z.enum(["check", "download"]).nullable(),
});
export type DesktopUpdateState = z.infer<typeof DesktopUpdateStateSchema>;

/** This app's updates, app-wide; every app window sees the same state. */
export interface DesktopUpdatesBridge {
  get(): Promise<DesktopUpdateState>;
  onChanged(listener: (state: DesktopUpdateState) => void): () => void;
  /** Starts downloading the offered version; progress arrives as changes. */
  download(): Promise<void>;
  /** Quits and relaunches into the downloaded version. */
  restart(): Promise<void>;
}

/**
 * macOS Full Disk Access for this app, and therefore for every agent command
 * that runs as its descendant. The main process asks the native helper, which
 * opens a location macOS gates behind the grant; there is no API to read the
 * setting itself.
 */
export const DesktopFullDiskAccessStatusSchema = z.strictObject({ granted: z.boolean() });
export type DesktopFullDiskAccessStatus = z.infer<typeof DesktopFullDiskAccessStatusSchema>;

/**
 * Asking for the grant takes no input on purpose.
 *
 * `openExternalUrl` refuses anything but web pages, and relaxing it so a page
 * could name an `x-apple.systempreferences:` target would hand the renderer a
 * general way to launch system panes. The one pane a person is sent to lives
 * in the main process, which opens it and floats the panel that walks the
 * person through the list; this call only asks for that.
 */
export const DesktopRequestFullDiskAccessResultSchema = z.strictObject({
  opened: z.literal(true),
});
export type DesktopRequestFullDiskAccessResult = z.infer<
  typeof DesktopRequestFullDiskAccessResultSchema
>;

/**
 * A folder somebody chose in the desktop's own file dialog, or null when they
 * closed it without choosing. The path is the dialog's answer, not the page's:
 * a renderer cannot ask for a particular folder, only for a chooser.
 */
export const DesktopPickFolderResultSchema = z
  .strictObject({ path: z.string().min(1).max(1_024) })
  .nullable();
export type DesktopPickFolderResult = z.infer<typeof DesktopPickFolderResultSchema>;

export const DesktopAccessOriginSchema = z
  .string()
  .max(512)
  .superRefine((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: "custom", message: "Access endpoint must be an absolute URL" });
      return;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      context.addIssue({ code: "custom", message: "Access endpoint must use HTTP or HTTPS" });
    }
    if (!isBareOrigin(url)) {
      context.addIssue({
        code: "custom",
        message: "Access endpoint must be an uncredentialed origin without a path, query, or hash",
      });
    }
    if (value !== url.origin) {
      context.addIssue({ code: "custom", message: "Access endpoint origin is not canonical" });
    }
    if (!isSecureOrLoopbackOrigin(url)) {
      context.addIssue({ code: "custom", message: "A non-loopback endpoint must use HTTPS" });
    }
  });
export type DesktopAccessOrigin = z.infer<typeof DesktopAccessOriginSchema>;

/**
 * Why a Deployment the Account directory lists could not become a usable local
 * route. These are the honest, actionable distinctions: a Host that is simply
 * unreachable, one whose identity does not match what the Account pinned, one
 * that is no longer active, or one on the wrong side of a protocol epoch.
 * Protocol peers must match this tree's exact version; a mismatched signed
 * authority is not accepted as the pinned identity.
 *
 * The two epoch reasons are deliberately separate, because the repair is on a
 * different machine in each case: `host-too-old` is fixed by whoever runs the
 * deployment, `client-too-old` by whoever holds this app.
 */
export const DesktopDeploymentUnavailableReasonSchema = z.enum([
  "client-too-old",
  "host-too-old",
  "host-unavailable",
  "identity-mismatch",
  "not-active",
]);
export type DesktopDeploymentUnavailableReason = z.infer<
  typeof DesktopDeploymentUnavailableReasonSchema
>;

/**
 * A Deployment the Account directory listed but the Desktop could not turn into
 * a usable route, carried far enough to be shown. The name travels with the
 * reason because the surface that renders it has nothing else to call the place:
 * an unavailable Deployment never entered the local catalog. The Account
 * relation travels too because the only move a person has on an unreachable
 * listing depends on it: a member can drop the listing, while an owner removes
 * the Deployment from the computer that runs it. It is named for the Account
 * deliberately — `access` on the summary beside it is live routing.
 */
export const DeploymentAccessUnavailableSchema = z.strictObject({
  accountAccess: z.enum(["owner", "member"]),
  deploymentId: DeploymentIdSchema,
  name: z.string().trim().min(1).max(120),
  reason: DesktopDeploymentUnavailableReasonSchema,
});
export type DeploymentAccessUnavailable = z.infer<typeof DeploymentAccessUnavailableSchema>;

export const DesktopDeploymentRouteSchema = z.strictObject({
  kind: z.enum(["canonical", "direct"]),
  origin: DesktopAccessOriginSchema,
  selected: z.boolean(),
});

/**
 * How this Desktop reaches one Deployment right now. `owner` is the Personal
 * Host this app supervises and is currently running; `connect` and `private`
 * are the two signed Personal remote routes; `native` is every direct or
 * canonical HTTPS route. `null` is a listed Deployment with no usable route —
 * an Account's projection of a computer that is switched off.
 */
export const DesktopAccessSchema = z.enum(["owner", "native", "connect", "private"]);
export type DesktopAccess = z.infer<typeof DesktopAccessSchema>;

export const DesktopDeploymentSummarySchema = z.strictObject({
  access: DesktopAccessSchema.nullable(),
  activeOrigin: DesktopAccessOriginSchema,
  canonicalOrigin: CanonicalOriginSchema,
  id: DeploymentIdSchema,
  kind: DeploymentDisplayKindSchema,
  lastUsedAt: IsoDateTimeSchema.nullable(),
  name: z.string().trim().min(1).max(120),
  onThisComputer: z.boolean(),
  routes: z.array(DesktopDeploymentRouteSchema).min(1).max(8),
});
export type DesktopDeploymentSummary = z.infer<typeof DesktopDeploymentSummarySchema>;

export const DesktopDeploymentSelectionSchema = z.strictObject({
  deployments: z.array(DesktopDeploymentSummarySchema).max(100),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  schemaVersion: z.literal(1),
  selectedDeploymentId: DeploymentIdSchema.nullable(),
});
export type DesktopDeploymentSelection = z.infer<typeof DesktopDeploymentSelectionSchema>;

export const DesktopAccountAuthStatusSchema = z.enum([
  "signed-out",
  "authorizing",
  "signed-in",
  "error",
]);
export type DesktopAccountAuthStatus = z.infer<typeof DesktopAccountAuthStatusSchema>;

const DesktopAccountAuthSubjectStateSchema = z
  .strictObject({
    available: z.boolean(),
    detail: z.string().min(1).max(1_000).nullable(),
    identity: z
      .strictObject({
        email: z.email().max(320).optional(),
        issuer: z.url(),
        subject: z.string().min(1).max(200),
      })
      .nullable(),
    status: DesktopAccountAuthStatusSchema,
  })
  .superRefine((state, context) => {
    if (state.status === "signed-in" && state.identity === null) {
      context.addIssue({
        code: "custom",
        message: "A signed-in Desktop Account session requires an identity",
        path: ["identity"],
      });
    }
    if (state.status === "signed-out" && state.identity !== null) {
      context.addIssue({
        code: "custom",
        message: "A signed-out Desktop Account session cannot retain an identity",
        path: ["identity"],
      });
    }
  });

export const DesktopAccountAuthStateSchema = z.strictObject({
  account: DesktopAccountAuthSubjectStateSchema,
  schemaVersion: z.literal(2),
});
export type DesktopAccountAuthState = z.infer<typeof DesktopAccountAuthStateSchema>;

export const DesktopSelectDeploymentInputSchema = z.strictObject({
  deploymentId: DeploymentIdSchema,
});
export type DesktopSelectDeploymentInput = z.infer<typeof DesktopSelectDeploymentInputSchema>;

export const DesktopRemoveAccountDeploymentInputSchema = z.strictObject({
  deploymentId: DeploymentIdSchema,
});
export type DesktopRemoveAccountDeploymentInput = z.infer<
  typeof DesktopRemoveAccountDeploymentInputSchema
>;

export const DesktopAddDirectRouteInputSchema = z.strictObject({
  deploymentId: DeploymentIdSchema,
  origin: DesktopAccessOriginSchema,
});
export type DesktopAddDirectRouteInput = z.infer<typeof DesktopAddDirectRouteInputSchema>;

/**
 * Connects a fresh Desktop client through one explicitly selected trust path.
 * Personal pairing verifies the Host-signed remote route before spending its
 * one-use code. Self-hosted connection verifies ordinary signed discovery and
 * then delegates authentication to that Host's native OAuth surface. Electron
 * main derives every Deployment identity and catalog field from those signed
 * documents; the renderer cannot infer or assert a Deployment kind.
 */
export const DesktopConnectPrivateDeploymentInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("personal-pairing"),
    origin: DesktopAccessOriginSchema,
    pairingCode: PersonalPairingCodeSchema,
  }),
  z.strictObject({
    kind: z.literal("self-hosted"),
    origin: DesktopAccessOriginSchema,
  }),
]);
export type DesktopConnectPrivateDeploymentInput = z.infer<
  typeof DesktopConnectPrivateDeploymentInputSchema
>;

export const DesktopSetDeploymentRouteInputSchema = z.strictObject({
  deploymentId: DeploymentIdSchema,
  origin: DesktopAccessOriginSchema.nullable(),
});
export type DesktopSetDeploymentRouteInput = z.infer<typeof DesktopSetDeploymentRouteInputSchema>;

/**
 * The words a person ever reads about whether a place is usable. The schema
 * lives here because it travels on the wire inside the access snapshot; what
 * each word *says* — its label, its tone, whether it can be opened — is
 * defined exactly once in `./deployment-status.js`. `checking` is the honest
 * word while a check is under way: nothing about the place is claimed yet.
 */
export const DeploymentStatusSchema = z.enum([
  "ready",
  "starting",
  "checking",
  "attention",
  "offline",
]);
export type DeploymentStatus = z.infer<typeof DeploymentStatusSchema>;

/**
 * A status plus, when the place is not plainly ready, the one short sentence
 * that tells a person what happened and what they can do about it. `label`
 * names the condition when the status word alone would be too vague to act
 * on — "Remote access off" rather than "Offline".
 */
export const DeploymentStatusInfoSchema = z.strictObject({
  label: z.string().trim().min(1).max(40).optional(),
  reason: z.string().trim().min(1).max(2_000).nullable(),
  status: DeploymentStatusSchema,
});
export type DeploymentStatusInfo = z.infer<typeof DeploymentStatusInfoSchema>;

export const DeploymentAccessSourceSchema = z.enum(["account", "manual", "this-device"]);

/**
 * What this Desktop's own attachment to one Deployment is doing. `idle` is the
 * honest reading for every row this app is simply not attached to, which is
 * every row but the selected one: it says nothing about whether the place is
 * up, which `statusInfo` beside it answers from the authority that knows.
 *
 * `connecting` and `authorizing` are deliberately different words for two
 * different waits. `connecting` is this app waiting on a machine; `authorizing`
 * is this app waiting on a person to finish in their browser, which no amount
 * of waiting here can advance — so it is a state that must be shown, and one a
 * person can always leave.
 */
export const DeploymentConnectionStatusSchema = z.enum([
  "authorizing",
  "connected",
  "connecting",
  "idle",
  "needs-sign-in",
  "offline",
  "needs-remote-access",
]);
export type DeploymentConnectionStatus = z.infer<typeof DeploymentConnectionStatusSchema>;

/**
 * The moves a row offers. Each one is an operation the Desktop will actually
 * run, so nothing here can be advertised and then refused; a state whose only
 * repair lives on another computer offers no action and says so in words.
 */
export const DeploymentConnectionActionSchema = z.enum(["select", "retry", "cancel"]);
export type DeploymentConnectionAction = z.infer<typeof DeploymentConnectionActionSchema>;

export const DeploymentAccessDeploymentSchema = DesktopDeploymentSummarySchema.extend({
  /**
   * This Account's relation to the Deployment, or null for a row the Account
   * did not list. Distinct from `access` above, which is how this computer
   * reaches the place right now.
   */
  accountAccess: z.enum(["owner", "member"]).nullable(),
  availableActions: z.array(DeploymentConnectionActionSchema).max(3),
  /** Capabilities verified for this attachment; absent/null is still unknown. */
  capabilities: z.array(HostCapabilitySchema).max(32).nullable().optional(),
  attachmentKey: z.string().min(1).max(4096).nullable().optional(),
  failure: z.lazy(() => DeploymentAccessFailureSchema).nullable(),
  source: DeploymentAccessSourceSchema,
  status: DeploymentConnectionStatusSchema,
  /** What the authority that owns this place says about it, attachment aside. */
  statusInfo: DeploymentStatusInfoSchema,
});
export type DeploymentAccessDeployment = z.infer<typeof DeploymentAccessDeploymentSchema>;

export const DeploymentAccessFailureSchema = z.strictObject({
  code: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  detail: z.string().trim().min(1).max(2_000),
  retryable: z.boolean(),
});
export type DeploymentAccessFailure = z.infer<typeof DeploymentAccessFailureSchema>;

export const DesktopPersonalAccountLinkStatusSchema = z.strictObject({
  account: z.strictObject({ issuer: z.url(), subject: z.string().min(1).max(200) }).nullable(),
  deploymentId: DeploymentIdSchema.nullable(),
  displayName: z.string().trim().min(1).max(120).nullable(),
  status: z.enum([
    "unavailable",
    "unlinked",
    "activating",
    "linked",
    "linked-elsewhere",
    "needs-repair",
    "unlinking",
  ]),
  unlinkStep: z
    .enum([
      "disable-connect",
      "revoke-account-sessions",
      "revoke-connect-resource",
      "remove-host-link",
      "repair-hosted-oauth-connections",
      "retain-local-data",
    ])
    .nullable(),
});
export type DesktopPersonalAccountLinkStatus = z.infer<
  typeof DesktopPersonalAccountLinkStatusSchema
>;

export const DeploymentAccessSnapshotSchema = z.strictObject({
  account: z.strictObject({
    available: z.boolean(),
    detail: z.string().trim().min(1).max(1_000).optional(),
    email: z.string().email().max(320).optional(),
    issuer: z.url().optional(),
    status: DesktopAccountAuthStatusSchema,
    subject: z.string().min(1).max(200).optional(),
  }),
  deployments: z.array(DeploymentAccessDeploymentSchema).max(100),
  directoryFailure: DeploymentAccessFailureSchema.nullable().default(null),
  personalSetup: DesktopPersonalDeploymentStatusSchema.nullable(),
  personalAccountLink: DesktopPersonalAccountLinkStatusSchema,
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  selectedDeploymentId: DeploymentIdSchema.nullable(),
  /** Listed Deployments that could not be reached, with the reason each time. */
  unavailable: z.array(DeploymentAccessUnavailableSchema).max(100).default([]),
});
export type DeploymentAccessSnapshot = z.infer<typeof DeploymentAccessSnapshotSchema>;

const DesktopHostPathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => {
    const rawPath = value.split("?", 1)[0] ?? "";
    if (
      !value.startsWith("/") ||
      value.startsWith("//") ||
      rawPath.includes("%") ||
      value.includes("\\") ||
      hasAsciiControl(value)
    )
      return false;
    let url: URL;
    try {
      url = new URL(value, "https://host.invalid");
    } catch {
      return false;
    }
    return (
      url.origin === "https://host.invalid" &&
      !url.hash &&
      (url.pathname === "/v1" || url.pathname.startsWith("/v1/"))
    );
  }, "Desktop Host paths must remain within /v1 on the selected Host");

export function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function boundedUtf8String(minimumBytes: number, maximumBytes: number) {
  return z
    .string()
    .min(minimumBytes > 0 ? 1 : 0)
    .max(maximumBytes)
    .refine((value) => {
      const bytes = new TextEncoder().encode(value).byteLength;
      return bytes >= minimumBytes && bytes <= maximumBytes;
    }, `Value must contain between ${minimumBytes} and ${maximumBytes} UTF-8 bytes`);
}

const DesktopAcceptHeaderSchema = z.string().regex(/^[\x20-\x7e]{1,255}$/u);
const DesktopIdempotencyKeySchema = z.string().regex(/^[\x21-\x7e]{1,255}$/u);
/** The protocol epoch the calling client states, relayed as it was sent. */
const DesktopApiVersionSchema = z.string().regex(/^[0-9]{1,6}$/u);

export const DesktopHostHttpRequestSchema = z.strictObject({
  body: boundedUtf8String(0, 1 * 1_024 * 1_024).optional(),
  headers: z.strictObject({
    accept: DesktopAcceptHeaderSchema.optional(),
    apiVersion: DesktopApiVersionSchema.optional(),
    bootstrapDiagnostics: z
      .string()
      .regex(/^[\x20-\x7e]{1,2048}$/u)
      .optional(),
    contentType: z.literal("application/json").optional(),
    idempotencyKey: DesktopIdempotencyKeySchema.optional(),
  }),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: DesktopHostPathSchema,
  timeoutMs: z.number().int().min(1).max(120_000).optional(),
});
export type DesktopHostHttpRequest = z.infer<typeof DesktopHostHttpRequestSchema>;

export const DesktopHostHttpResponseSchema = z.strictObject({
  body: boundedUtf8String(0, 16 * 1_024 * 1_024),
  headers: z.strictObject({ contentType: z.string().min(1).max(255).nullable() }),
  status: z.number().int().min(100).max(599),
});
export type DesktopHostHttpResponse = z.infer<typeof DesktopHostHttpResponseSchema>;

export const DesktopHostTransportFailureSchema = z.strictObject({
  ok: z.literal(false),
  error: z.strictObject({
    code: z.enum([
      "response-too-large",
      "timed-out",
      "deployment-changed",
      "cancelled",
      "unreachable",
    ]),
  }),
});
export type DesktopHostTransportFailure = z.infer<typeof DesktopHostTransportFailureSchema>;

export type DesktopHostResult<Data> =
  { readonly ok: true; readonly data: Data } | DesktopHostTransportFailure;

function desktopHostResultSchema<Schema extends z.ZodType>(data: Schema) {
  return z.discriminatedUnion("ok", [
    z.strictObject({ ok: z.literal(true), data }),
    DesktopHostTransportFailureSchema,
  ]);
}

export const DesktopHostHttpResultSchema = desktopHostResultSchema(DesktopHostHttpResponseSchema);
export const DesktopHostVoidResultSchema = desktopHostResultSchema(z.null());

const DesktopHostBinaryTransferIdSchema = z.string().uuid();
const DesktopHostBinaryChunkSchema = z
  .instanceof(Uint8Array)
  .refine((bytes) => bytes.byteLength <= 256 * 1_024);

/** A bounded byte stream over IPC, scoped to the renderer that opened it. */
export const DesktopHostBinaryOpenInputSchema = z
  .strictObject({
    body: boundedUtf8String(0, 1 * 1_024 * 1_024).optional(),
    headers: z.strictObject({
      accept: DesktopAcceptHeaderSchema.optional(),
      apiVersion: DesktopApiVersionSchema.optional(),
      contentType: z.enum(["application/json", "application/octet-stream"]).optional(),
    }),
    method: z.enum(["GET", "POST"]),
    path: DesktopHostPathSchema,
    timeoutMs: z.number().int().min(1).max(120_000).optional(),
  })
  .refine(
    (input) =>
      input.method === "GET"
        ? input.body === undefined && input.path.startsWith("/v1/rpc/attachment.content?input=")
        : input.path.startsWith("/v1/rpc/attachment.upload?input=")
          ? input.body === undefined && input.headers.contentType === "application/octet-stream"
          : input.path === "/v1/rpc/workspace.files.preview" &&
            input.body !== undefined &&
            input.headers.contentType === "application/json",
    "Binary Host transfer must use an attachment or file preview route",
  );
export type DesktopHostBinaryOpenInput = z.infer<typeof DesktopHostBinaryOpenInputSchema>;
export const DesktopHostBinaryOpenResultSchema = z.strictObject({
  transferId: DesktopHostBinaryTransferIdSchema,
});
export type DesktopHostBinaryOpenResult = z.infer<typeof DesktopHostBinaryOpenResultSchema>;
export const DesktopHostBinaryWriteInputSchema = z.strictObject({
  bytes: DesktopHostBinaryChunkSchema,
  transferId: DesktopHostBinaryTransferIdSchema,
});
export type DesktopHostBinaryWriteInput = z.infer<typeof DesktopHostBinaryWriteInputSchema>;
export const DesktopHostBinaryTransferInputSchema = z.strictObject({
  transferId: DesktopHostBinaryTransferIdSchema,
});
export type DesktopHostBinaryTransferInput = z.infer<typeof DesktopHostBinaryTransferInputSchema>;
export const DesktopHostBinaryReadResultSchema = z.strictObject({
  bytes: DesktopHostBinaryChunkSchema,
  contentType: z.string().min(1).max(255).nullable(),
  done: z.boolean(),
  etag: z.string().min(1).max(255).nullable(),
  fileSizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  fileTruncated: z.boolean().nullable(),
  lastModified: z.string().min(1).max(255).nullable(),
  sizeBytes: z
    .number()
    .int()
    .nonnegative()
    .max(25 * 1_024 * 1_024)
    .nullable(),
  status: z.number().int().min(100).max(599),
});
export type DesktopHostBinaryReadResult = z.infer<typeof DesktopHostBinaryReadResultSchema>;

export const DesktopHostBinaryOpenResponseSchema = desktopHostResultSchema(
  DesktopHostBinaryOpenResultSchema,
);
export const DesktopHostBinaryReadResponseSchema = desktopHostResultSchema(
  DesktopHostBinaryReadResultSchema,
);

export const DesktopOpenHostWebSocketInputSchema = z.strictObject({
  path: DesktopHostPathSchema,
});
export type DesktopOpenHostWebSocketInput = z.infer<typeof DesktopOpenHostWebSocketInputSchema>;

const DesktopHostWebSocketConnectionIdSchema = z
  .string()
  .regex(
    /^desktop_host_socket_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );

export const DesktopOpenHostWebSocketResultSchema = z.strictObject({
  connectionId: DesktopHostWebSocketConnectionIdSchema,
});
export type DesktopOpenHostWebSocketResult = z.infer<typeof DesktopOpenHostWebSocketResultSchema>;

export const DesktopHostWebSocketCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    connectionId: DesktopHostWebSocketConnectionIdSchema,
    data: boundedUtf8String(0, 1 * 1_024 * 1_024),
    type: z.literal("text"),
  }),
  z.strictObject({
    connectionId: DesktopHostWebSocketConnectionIdSchema,
    data: z.instanceof(Uint8Array).refine((value) => value.byteLength <= 8 * 1_024 * 1_024),
    type: z.literal("binary"),
  }),
]);
export type DesktopHostWebSocketCommand = z.infer<typeof DesktopHostWebSocketCommandSchema>;

export const DesktopCloseHostWebSocketInputSchema = z.strictObject({
  code: z
    .number()
    .int()
    .refine((value) => value === 1_000 || (value >= 3_000 && value <= 4_999))
    .optional(),
  connectionId: DesktopHostWebSocketConnectionIdSchema,
  reason: boundedUtf8String(0, 123).optional(),
});
export type DesktopCloseHostWebSocketInput = z.infer<typeof DesktopCloseHostWebSocketInputSchema>;

export const DesktopHostWebSocketEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ connectionId: DesktopHostWebSocketConnectionIdSchema, type: z.literal("open") }),
  z.strictObject({
    connectionId: DesktopHostWebSocketConnectionIdSchema,
    data: boundedUtf8String(0, 1 * 1_024 * 1_024),
    type: z.literal("text"),
  }),
  z.strictObject({
    connectionId: DesktopHostWebSocketConnectionIdSchema,
    data: z
      .instanceof(Uint8Array)
      .refine((value) => value.byteLength <= 8 * 1_024 * 1_024 + 20_000),
    type: z.literal("binary"),
  }),
  z.strictObject({
    code: z.number().int().min(0).max(4_999),
    connectionId: DesktopHostWebSocketConnectionIdSchema,
    reason: boundedUtf8String(0, 1_000),
    type: z.literal("close"),
  }),
  z.strictObject({
    connectionId: DesktopHostWebSocketConnectionIdSchema,
    message: boundedUtf8String(1, 1_000),
    type: z.literal("error"),
  }),
]);
export type DesktopHostWebSocketEvent = z.infer<typeof DesktopHostWebSocketEventSchema>;

/**
 * The Agent Phone app this desktop build carries, for setting a phone up over
 * USB from this window. Main reads the fixed bundled pair; the setup engine
 * checks the APK against its manifest before a byte reaches a phone.
 */
export const DesktopAgentPhoneArtifactSchema = z.strictObject({
  bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength <= agentPhoneApkMaxBytes),
  manifest: AgentPhoneArtifactManifestSchema,
});
export type DesktopAgentPhoneArtifact = z.infer<typeof DesktopAgentPhoneArtifactSchema>;

/** Null is a build packaged without the Agent Phone app. */
export const DesktopReadAgentPhoneArtifactResultSchema = DesktopAgentPhoneArtifactSchema.nullable();

/**
 * Several phones match a page's WebUSB request, so the person picks one.
 *
 * Electron has no device chooser of its own: main answers the request with
 * the one ADB phone plugged in, and asks the page that made the request when
 * there are more. Only the device picked is ever granted to the page.
 */
export const DesktopUsbDeviceChoiceSchema = z.strictObject({
  choiceId: z.uuid(),
  devices: z
    .array(
      z.strictObject({
        deviceId: z.string().min(1).max(128),
        name: z.string().max(256).nullable(),
        serialNumber: z.string().max(256).nullable(),
      }),
    )
    .min(2)
    .max(32),
});
export type DesktopUsbDeviceChoice = z.infer<typeof DesktopUsbDeviceChoiceSchema>;

/** The person's pick from one choice; a null device declines the request. */
export const DesktopChooseUsbDeviceInputSchema = z.strictObject({
  choiceId: z.uuid(),
  deviceId: z.string().min(1).max(128).nullable(),
});
export type DesktopChooseUsbDeviceInput = z.infer<typeof DesktopChooseUsbDeviceInputSchema>;

/** A Desktop setup session reaches only a USB device already chosen by this frame. */
export const DesktopAgentPhoneUsbIdentitySchema = z.strictObject({
  vendorId: z.number().int().min(0).max(65_535),
  productId: z.number().int().min(0).max(65_535),
  serialNumber: boundedUtf8String(0, 256),
});
export type DesktopAgentPhoneUsbIdentity = z.infer<typeof DesktopAgentPhoneUsbIdentitySchema>;
export const DesktopAgentPhoneAdbSessionSchema = z.strictObject({ sessionId: z.uuid() });
export const DesktopAgentPhoneAdbOpenSchema = DesktopAgentPhoneAdbSessionSchema.extend({
  device: DesktopAgentPhoneUsbIdentitySchema,
});
export const DesktopAgentPhoneAdbOpenResultSchema = z.enum(["direct", "connected"]);
export const DesktopAgentPhoneAdbCallSchema = z.discriminatedUnion("kind", [
  DesktopAgentPhoneAdbSessionSchema.extend({
    kind: z.literal("getProp"),
    key: boundedUtf8String(1, 256).regex(/^[a-zA-Z0-9_.-]+$/u),
  }),
  DesktopAgentPhoneAdbSessionSchema.extend({
    kind: z.literal("shell"),
    argv: z.array(boundedUtf8String(0, 16_384)).min(1).max(64),
  }),
  DesktopAgentPhoneAdbSessionSchema.extend({
    kind: z.literal("install"),
    bytes: z
      .instanceof(Uint8Array)
      .refine((bytes) => bytes.byteLength > 0 && bytes.byteLength <= agentPhoneApkMaxBytes),
  }),
  DesktopAgentPhoneAdbSessionSchema.extend({
    kind: z.literal("readFile"),
    path: boundedUtf8String(1, 4_096),
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(64 * 1_024 * 1_024),
  }),
]);
export const DesktopAgentPhoneAdbResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("getProp"), value: boundedUtf8String(0, 65_536) }),
  z.strictObject({
    kind: z.literal("shell"),
    value: z.strictObject({
      exitCode: z.number().int(),
      stdout: boundedUtf8String(0, 1_024 * 1_024),
      stderr: boundedUtf8String(0, 1_024 * 1_024),
    }),
  }),
  z.strictObject({
    kind: z.literal("install"),
    value: z.union([
      z.strictObject({ ok: z.literal(true) }),
      z.strictObject({ ok: z.literal(false), output: boundedUtf8String(0, 65_536) }),
    ]),
  }),
  z.strictObject({
    kind: z.literal("readFile"),
    value: z
      .instanceof(Uint8Array)
      .refine((bytes) => bytes.byteLength <= 64 * 1_024 * 1_024)
      .nullable(),
  }),
]);
export type DesktopAgentPhoneAdbOpen = z.infer<typeof DesktopAgentPhoneAdbOpenSchema>;
export type DesktopAgentPhoneAdbCall = z.infer<typeof DesktopAgentPhoneAdbCallSchema>;
export type DesktopAgentPhoneAdbResult = z.infer<typeof DesktopAgentPhoneAdbResultSchema>;
export interface DesktopAgentPhoneAdbBridge {
  open(
    input: DesktopAgentPhoneAdbOpen,
  ): Promise<z.infer<typeof DesktopAgentPhoneAdbOpenResultSchema>>;
  call(input: DesktopAgentPhoneAdbCall): Promise<DesktopAgentPhoneAdbResult>;
  close(input: z.infer<typeof DesktopAgentPhoneAdbSessionSchema>): Promise<void>;
  onAuthorize(
    listener: (input: z.infer<typeof DesktopAgentPhoneAdbSessionSchema>) => void,
  ): () => void;
}

export const desktopWebUrlMaxBytes = 8192;
export const DesktopWebUrlSchema = z
  .string()
  .min(1)
  .refine((raw) => {
    if (new TextEncoder().encode(raw).byteLength > desktopWebUrlMaxBytes) return false;
    try {
      const url = new URL(raw);
      return (
        (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
      );
    } catch {
      return false;
    }
  }, "A web link must be a valid HTTP or HTTPS URL.");
export const DesktopWebLinkRequestSchema = z.strictObject({
  deploymentId: DeploymentIdSchema,
  userId: UserIdSchema,
  identity: BrowserOpenIdentitySchema,
});
export type DesktopWebLinkRequest = z.infer<typeof DesktopWebLinkRequestSchema>;
export const DesktopWebLinkSchema = z.strictObject({
  type: z.literal("open-web-url"),
  id: z.uuid(),
  url: DesktopWebUrlSchema,
  request: DesktopWebLinkRequestSchema.optional(),
  generation: z.uuid().optional(),
  /** Main's wall-clock receipt time, so a person's later choice of view covers links still waiting. */
  receivedAt: z.number().int().nonnegative().optional(),
});
export type DesktopWebLink = z.infer<typeof DesktopWebLinkSchema>;
export const DesktopWebLinkDeliverySchema = z.strictObject({
  deploymentId: DeploymentIdSchema,
  acknowledgedId: z.uuid().optional(),
  dismissedId: z.uuid().optional(),
  bind: z.strictObject({ id: z.uuid(), identity: BrowserOpenIdentitySchema }).optional(),
  generation: z.uuid(),
  userId: UserIdSchema,
  ready: z.boolean(),
});
export type DesktopWebLinkDelivery = z.infer<typeof DesktopWebLinkDeliverySchema>;

export const DesktopWorkspaceTabCommandSchema = z.union([
  DesktopWebLinkSchema,
  z.strictObject({
    type: z.enum(["new-tab", "close-tab", "reopen-closed-tab", "next-tab", "previous-tab"]),
  }),
  z.strictObject({ type: z.literal("select-tab"), index: z.number().int().min(1).max(9) }),
]);
export type DesktopWorkspaceTabCommand = z.infer<typeof DesktopWorkspaceTabCommandSchema>;

const windowCoordinate = z.number().finite().min(-32_768).max(32_768);
const windowExtent = z.number().finite().min(0).max(32_768);

/** App CSS pixels in the app window's content area; main converts these to window DIPs. */
export const DesktopWindowRectSchema = z.strictObject({
  height: windowExtent,
  width: windowExtent,
  x: windowCoordinate,
  y: windowCoordinate,
});
export type DesktopWindowRect = z.infer<typeof DesktopWindowRectSchema>;

export const DesktopBrowserPresentationIdSchema = z.uuid().brand<"DesktopBrowserPresentationId">();
export type DesktopBrowserPresentationId = z.infer<typeof DesktopBrowserPresentationIdSchema>;

/**
 * Increases every time a presentation shows another surface; work addressed
 * to an older revision is discarded.
 */
const DesktopBrowserPresentationRevisionSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);

export const DesktopBrowserPresentationLocalInputSchema = z.strictObject({
  sessionId: BrowserSessionIdSchema,
});
export type DesktopBrowserPresentationLocalInput = z.infer<
  typeof DesktopBrowserPresentationLocalInputSchema
>;

export const DesktopBrowserPresentInputSchema = z.strictObject({
  rect: DesktopWindowRectSchema,
  sessionId: BrowserSessionIdSchema,
  surfaceId: BrowserSurfaceIdSchema,
});
export type DesktopBrowserPresentInput = z.infer<typeof DesktopBrowserPresentInputSchema>;

export const DesktopBrowserPresentResultSchema = z.strictObject({
  presentationId: DesktopBrowserPresentationIdSchema,
  revision: DesktopBrowserPresentationRevisionSchema,
});
export type DesktopBrowserPresentResult = z.infer<typeof DesktopBrowserPresentResultSchema>;

export const DesktopBrowserPresentationUpdateInputSchema = z.strictObject({
  presentationId: DesktopBrowserPresentationIdSchema,
  rect: DesktopWindowRectSchema.optional(),
  surfaceId: BrowserSurfaceIdSchema.optional(),
});
export type DesktopBrowserPresentationUpdateInput = z.infer<
  typeof DesktopBrowserPresentationUpdateInputSchema
>;

export const DesktopBrowserPresentationUpdateResultSchema = z.strictObject({
  revision: DesktopBrowserPresentationRevisionSchema,
});
export type DesktopBrowserPresentationUpdateResult = z.infer<
  typeof DesktopBrowserPresentationUpdateResultSchema
>;

export const DesktopBrowserPresentationTargetSchema = z.strictObject({
  presentationId: DesktopBrowserPresentationIdSchema,
  revision: DesktopBrowserPresentationRevisionSchema,
});
export type DesktopBrowserPresentationTarget = z.infer<
  typeof DesktopBrowserPresentationTargetSchema
>;

/** Why a native page left the window; every reason is final for that presentation. */
export const DesktopBrowserPresentationEndSchema = z.enum([
  "access-ended",
  "page-closed",
  "released",
  "renderer-gone",
  "runtime-stopped",
]);
export type DesktopBrowserPresentationEnd = z.infer<typeof DesktopBrowserPresentationEndSchema>;

/** A key the app handles that was pressed while a native page had the keyboard. */
export const DesktopForwardedKeySchema = z.strictObject({
  alt: z.boolean(),
  code: z.string().min(1).max(64),
  ctrl: z.boolean(),
  key: z.string().min(1).max(64),
  meta: z.boolean(),
  shift: z.boolean(),
});
export type DesktopForwardedKey = z.infer<typeof DesktopForwardedKeySchema>;

export const DesktopBrowserPresentationEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    /** The app view's zoom factor: one of the renderer's CSS pixels spans this many window DIPs. */
    appZoomFactor: z.number().finite().positive(),
    bounds: DesktopWindowRectSchema,
    croppedRight: z.boolean(),
    croppedBottom: z.boolean(),
    /** Whether a glass window draws marks over the page; Linux has none. */
    glass: z.boolean(),
    /** The ledger's geometry revision the page is laid out at; agent pointers name the one they were measured in. */
    geometryRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    presentationId: DesktopBrowserPresentationIdSchema,
    revision: DesktopBrowserPresentationRevisionSchema,
    /** The stage the page was placed in; bounds differ from it only for a page of another size. */
    stage: DesktopWindowRectSchema,
    sessionId: BrowserSessionIdSchema,
    surfaceId: BrowserSurfaceIdSchema,
    type: z.literal("placed"),
    /** The CSS size the page is laid out at: the agent's size when it set one. */
    viewport: z.strictObject({ height: windowExtent.positive(), width: windowExtent.positive() }),
  }),
  z.strictObject({
    presentationId: DesktopBrowserPresentationIdSchema,
    reason: DesktopBrowserPresentationEndSchema,
    type: z.literal("ended"),
  }),
  z.strictObject({
    activeMatch: z.number().int().min(0),
    final: z.boolean(),
    matches: z.number().int().min(0),
    presentationId: DesktopBrowserPresentationIdSchema,
    revision: DesktopBrowserPresentationRevisionSchema,
    type: z.literal("find"),
  }),
  z.strictObject({
    active: z.boolean(),
    presentationId: DesktopBrowserPresentationIdSchema,
    revision: DesktopBrowserPresentationRevisionSchema,
    type: z.literal("fullscreen"),
  }),
  z.strictObject({ key: DesktopForwardedKeySchema, type: z.literal("key") }),
  z.strictObject({ focused: z.boolean(), type: z.literal("window-focus") }),
]);
export type DesktopBrowserPresentationEvent = z.infer<typeof DesktopBrowserPresentationEventSchema>;

export const DesktopBrowserOverlayInputSchema = z.strictObject({ overlayId: z.uuid() });
export type DesktopBrowserOverlayInput = z.infer<typeof DesktopBrowserOverlayInputSchema>;

export const DesktopBrowserFindInputSchema = z.strictObject({
  findNext: z.boolean(),
  forward: z.boolean(),
  presentationId: DesktopBrowserPresentationIdSchema,
  query: z.string().min(1).max(1_000),
  revision: DesktopBrowserPresentationRevisionSchema,
});
export type DesktopBrowserFindInput = z.infer<typeof DesktopBrowserFindInputSchema>;

/**
 * One agent's cursor on a native page, in the page's CSS pixels. The glass
 * page holds no Host snapshot, so the renderer resolves the task's mark and
 * sends it: `icon` and `color` are null while unknown (and for Chat).
 */
export const DesktopGlassCursorSchema = z.strictObject({
  color: MarkColorSchema.nullable(),
  home: z.boolean(),
  icon: WorkspaceIconNameSchema.nullable(),
  leaving: z.boolean(),
  threadId: ThreadIdSchema,
  title: z.string().max(200),
  x: z.number().finite(),
  y: z.number().finite(),
});
export type DesktopGlassCursor = z.infer<typeof DesktopGlassCursorSchema>;

/** Marks drawn over a native page: never controls. */
export const DesktopGlassSceneSchema = z.strictObject({
  croppedBottom: z.boolean(),
  croppedRight: z.boolean(),
  cursors: z.array(DesktopGlassCursorSchema).max(32),
  /**
   * The page geometry the cursors' points were measured in. Points measured
   * in new geometry are a new layout: the glass redraws them there at once.
   */
  geometryRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  reducedMotion: z.boolean(),
});
export type DesktopGlassScene = z.infer<typeof DesktopGlassSceneSchema>;

export const DesktopBrowserGlassInputSchema = z.strictObject({
  presentationId: DesktopBrowserPresentationIdSchema,
  revision: DesktopBrowserPresentationRevisionSchema,
  scene: DesktopGlassSceneSchema.nullable(),
});
export type DesktopBrowserGlassInput = z.infer<typeof DesktopBrowserGlassInputSchema>;

/** What the glass page over a native page receives; it draws marks and takes no input. */
export interface OpensteerGlassBridge {
  onScene(listener: (scene: DesktopGlassScene | null) => void): () => void;
}

export const DesktopBrowserNavigationAvailableSchema = z.strictObject({ hardReload: z.boolean() });

/** Desktop page commands and native presentation of this process's own Runtime pages. */
export interface DesktopBrowserPresentationBridge {
  /** The selected page's negotiated commands, for this window's menu. */
  setNavigationAvailable?(
    input: z.infer<typeof DesktopBrowserNavigationAvailableSchema>,
  ): Promise<void>;
  /** Whether this process's own runtime holds the session. Locality only, never authority. */
  isLocal(input: DesktopBrowserPresentationLocalInput): Promise<boolean>;
  /** Mounts the page once this renderer's control socket for the session has its first snapshot. */
  present(input: DesktopBrowserPresentInput): Promise<DesktopBrowserPresentResult>;
  update(
    input: DesktopBrowserPresentationUpdateInput,
  ): Promise<DesktopBrowserPresentationUpdateResult>;
  release(input: DesktopBrowserPresentationTarget): Promise<void>;
  onEvent(listener: (event: DesktopBrowserPresentationEvent) => void): () => void;
  /** Whether this window has focus now; later changes arrive as `window-focus` events. */
  windowFocused(): Promise<boolean>;
  /** Resolves once the app layer is in front of the page; hold it until the overlay has left. */
  acquireOverlay(input: DesktopBrowserOverlayInput): Promise<void>;
  releaseOverlay(input: DesktopBrowserOverlayInput): Promise<void>;
  find(input: DesktopBrowserFindInput): Promise<void>;
  stopFind(input: DesktopBrowserPresentationTarget): Promise<void>;
  exitFullscreen(input: DesktopBrowserPresentationTarget): Promise<void>;
  setGlass(input: DesktopBrowserGlassInput): void;
  /** Gives the page the keyboard (Shift-F6, leaving find or the address); only for the current revision in the active window. */
  focusPage(input: DesktopBrowserPresentationTarget): Promise<void>;
}

export interface OpensteerDesktopBridge {
  readonly passkeys?: {
    available(): Promise<boolean>;
    present(input: { readonly requestId: string }): Promise<void>;
  };
  /** Present only in the desktop app. */
  browserPresentation?: DesktopBrowserPresentationBridge;
  /** Present only in the desktop app. */
  downloads?: DesktopDownloadsBridge;
  /** Present only in the desktop app. */
  updates?: DesktopUpdatesBridge;
  /** On-device dictation on this Mac. Present only in the desktop app. */
  dictation?: DictationPort;
  webLinkDelivery?(input: DesktopWebLinkDelivery): Promise<DesktopWebLink | null>;
  onWorkspaceTabCommand(listener: (command: DesktopWorkspaceTabCommand) => void): () => void;
  reportDisplayDiagnostic?(record: DisplayClientDiagnostic): Promise<void>;
  getLocalVisibility(): Promise<boolean>;
  onLocalVisibilityChanged(listener: (visible: boolean) => void): () => void;
  /** The Agent Phone app this build carries, or null when it carries none. */
  readAgentPhoneArtifact(): Promise<DesktopAgentPhoneArtifact | null>;
  agentPhoneAdb?: DesktopAgentPhoneAdbBridge;
  /** Several phones answered a WebUSB request from this page; the person picks one. */
  onUsbDeviceChoice(listener: (choice: DesktopUsbDeviceChoice) => void): () => void;
  /** Answers the open USB choice with the person's pick, or declines it. */
  chooseUsbDevice(input: DesktopChooseUsbDeviceInput): Promise<void>;
  /** Opensteer Passwords on this Mac, read without unlocking anything. */
  passwordsStatus(): Promise<DesktopPasswordsStatus>;
  onPasswordsStatusChanged(listener: (status: DesktopPasswordsStatus) => void): () => void;
  /** Brings up the Opensteer Passwords window, which decides between setup and the list. */
  passwordsOpen(): Promise<void>;
  /**
   * A sign-in Request's card on the Mac that runs it, keyed by the Request's
   * runtime operation: its stage, and every change Electron main sees.
   */
  passwordsSignInGet(
    input: DesktopPasswordsSignInCardInput,
  ): Promise<DesktopPasswordsSignInCardState>;
  onPasswordsSignInChanged(
    input: DesktopPasswordsSignInCardInput,
    listener: (state: DesktopPasswordsSignInCardState) => void,
  ): () => void;
  /** Allow or Only this time; the broker asks for Touch ID or the Mac's password first. */
  passwordsSignInApprove(
    input: DesktopPasswordsSignInApproveInput,
  ): Promise<DesktopPasswordsSignInApproveResult>;
  /** This desktop's approval key, for the computer's page on this Mac to register. */
  useComputerViewOnThisMac?(
    input: DesktopUseComputerViewInput,
  ): Promise<DesktopUseComputerViewResult>;
  computerUseApprovalKey(): Promise<DesktopComputerUseApprovalKeyResult>;
  /** Waits for this Mac's answer to a setup request the page just created. */
  reviewComputerAppSetup(
    input: DesktopReviewComputerAppSetupInput,
  ): Promise<DesktopReviewComputerAppSetupResult>;
  /**
   * Opens this Mac's setup panel for one app the helper serves, which takes
   * every macOS step that access needs. False when macOS already gives them.
   */
  openComputerAppSetup(
    input: DesktopOpenComputerAppSetupInput,
  ): Promise<DesktopOpenComputerAppSetupResult>;
  /**
   * The setup panel's own calls: what to draw, polled; the person's Set up on
   * an offer; showing the step again (its pane, or macOS's question); a native
   * drag of the installed helper into System Settings' list; and closing.
   * Every target — the pane, the question, the dragged file — is main's own.
   * Set up and closing name the app they answer.
   */
  computerAppSetupStatus(): Promise<DesktopComputerAppSetupStatus>;
  computerAppSetupBegin(input: DesktopComputerAppSetupTarget): Promise<void>;
  computerAppSetupShowAgain(): Promise<void>;
  computerAppSetupStartDrag(): Promise<void>;
  closeComputerAppSetup(input: DesktopComputerAppSetupTarget): Promise<void>;
  /**
   * The approval panel's two calls. It is opened with a token and reads its
   * presentation back, so nothing a page says decides which app, access or
   * Deployment somebody is being asked about.
   */
  computerUseApprovalGet(
    input: DesktopComputerUseApprovalInput,
  ): Promise<DesktopComputerUseApprovalPresentation>;
  computerUseApprovalRespond(input: DesktopComputerUseApprovalRespondInput): Promise<void>;
  /** Reads the two grants without prompting, which is what polling needs. */
  computerUsePermissionsGet(): Promise<DesktopComputerUsePermissionsResult>;
  /** Requests one macOS grant after an explicit action on this Mac. */
  computerUsePermissionsRequest(
    input: DesktopOpenComputerUseSettingsInput,
  ): Promise<DesktopComputerUsePermissionsResult>;
  /** Opens one System Settings pane by name, without activating this app. */
  computerUseOpenSystemSettings(input: DesktopOpenComputerUseSettingsInput): Promise<void>;
  /** Opens the permissions panel; called from the computer's page on this Mac. */
  openComputerUsePermissionsPanel(): Promise<DesktopOpenComputerUsePermissionsPanelResult>;
  /** From the panel: done, or not now. */
  closeComputerUsePermissionsPanel(): Promise<void>;
  acknowledgePortableFsApproval(
    input: DesktopLocalExecutionInput,
  ): Promise<DesktopLocalExecutionStatus>;
  addDirect(input: DesktopAddDirectRouteInput): Promise<void>;
  cancel(): Promise<void>;
  closeHostWebSocket(input: DesktopCloseHostWebSocketInput): Promise<void>;
  configurePersonalRemoteAccess(
    input: DesktopConfigurePersonalRemoteAccessInput,
  ): Promise<DesktopPersonalRemoteAccessStatus>;
  connectPrivate(input: DesktopConnectPrivateDeploymentInput): Promise<void>;
  createPersonalDeployment(): Promise<void>;
  createCloudDeployment(input: CreateCloudDeploymentRequest): Promise<CloudDeploymentOperation>;
  deleteCloudDeployment(
    input: DesktopDeleteCloudDeploymentInput,
  ): Promise<CloudDeploymentOperation>;
  getDeploymentAccessSnapshot(): Promise<DeploymentAccessSnapshot>;
  listCloudDeployments(): Promise<ListCloudDeploymentsResponse>;
  getLocalExecutionStatus(input: DesktopLocalExecutionInput): Promise<DesktopLocalExecutionStatus>;
  getPersonalRemoteAccessStatus(): Promise<DesktopPersonalRemoteAccessStatus>;
  hostRequest(input: DesktopHostHttpRequest): Promise<DesktopHostResult<DesktopHostHttpResponse>>;
  hostBinaryOpen(
    input: DesktopHostBinaryOpenInput,
  ): Promise<DesktopHostResult<DesktopHostBinaryOpenResult>>;
  hostBinaryWrite(input: DesktopHostBinaryWriteInput): Promise<DesktopHostResult<null>>;
  hostBinaryFinish(
    input: DesktopHostBinaryTransferInput,
  ): Promise<DesktopHostResult<DesktopHostHttpResponse>>;
  hostBinaryRead(
    input: DesktopHostBinaryTransferInput,
  ): Promise<DesktopHostResult<DesktopHostBinaryReadResult>>;
  hostBinaryClose(input: DesktopHostBinaryTransferInput): Promise<DesktopHostResult<null>>;
  installPortableFs(input: DesktopLocalExecutionInput): Promise<DesktopLocalExecutionStatus>;
  onDeploymentAccessSnapshotChanged(
    listener: (snapshot: DeploymentAccessSnapshot) => void,
  ): () => void;
  onHostWebSocketEvent(listener: (event: DesktopHostWebSocketEvent) => void): () => void;
  onLocalExecutionStatusChanged(
    listener: (status: DesktopLocalExecutionStatus) => void,
  ): () => void;
  onPersonalRemoteAccessStatusChanged(
    listener: (status: DesktopPersonalRemoteAccessStatus) => void,
  ): () => void;
  onNotificationActivated(listener: (target: DesktopNotificationTarget) => void): () => void;
  getNotificationSupport(): Promise<DesktopNotificationSupport>;
  showNotification(input: DesktopNotificationTarget): Promise<DesktopNotificationResult>;
  setBadgeCount(input: DesktopBadgeCountInput): Promise<void>;
  openExternalUrl(input: DesktopOpenExternalUrlInput): Promise<DesktopOpenExternalUrlResult>;
  openIntegrationAuthorization(
    input: DesktopOpenIntegrationAuthorizationInput,
  ): Promise<DesktopOpenIntegrationAuthorizationResult>;
  openHostWebSocket(input: DesktopOpenHostWebSocketInput): Promise<DesktopOpenHostWebSocketResult>;
  openPortableFsSetup(input: DesktopLocalExecutionInput): Promise<DesktopLocalExecutionStatus>;
  pickFolder(): Promise<DesktopPickFolderResult>;
  /** The grant as the helper sees it right now, on this Mac. */
  checkFullDiskAccess(): Promise<DesktopFullDiskAccessStatus>;
  /** Opens the Full Disk Access pane and floats the panel that guides the grant. */
  requestFullDiskAccess(): Promise<DesktopRequestFullDiskAccessResult>;
  /** From the panel: done, or not now. */
  closeFullDiskAccessPanel(): Promise<void>;
  issuePersonalPairingCode(): Promise<DesktopPersonalPairingCode>;
  linkPersonal(): Promise<void>;
  reauthorize(): Promise<void>;
  /**
   * Checks every place the person can see now: re-reads the Account's list
   * and proves each place added by hand still answers as itself. Cheap to
   * call whenever a list of places opens; repeated calls share one check.
   */
  checkDeployments(): Promise<void>;
  refreshDirectory(): Promise<void>;
  removeFromAccount(input: DesktopRemoveAccountDeploymentInput): Promise<void>;
  /** Discards an unusable Account-link journal so a needs-repair Personal Host
   * can be linked or unlinked again. Refused unless repair is actually needed. */
  retry(): Promise<void>;
  retryCloudDeployment(
    input: DesktopCloudDeploymentOperationInput,
  ): Promise<CloudDeploymentOperation>;
  select(input: DesktopSelectDeploymentInput): Promise<void>;
  sendHostWebSocket(input: DesktopHostWebSocketCommand): Promise<void>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  startLocalRunner(input: DesktopStartLocalRunnerInput): Promise<DesktopLocalExecutionStatus>;
  stopLocalRunner(input: DesktopLocalExecutionInput): Promise<DesktopLocalExecutionStatus>;
  unlinkPersonal(): Promise<void>;
}

export const DesktopCloudDeploymentOperationInputSchema = z.strictObject({
  operationId: CloudDeploymentOperationIdSchema,
});
export type DesktopCloudDeploymentOperationInput = z.infer<
  typeof DesktopCloudDeploymentOperationInputSchema
>;
export const DesktopDeleteCloudDeploymentInputSchema =
  DesktopCloudDeploymentOperationInputSchema.extend(
    DeleteCloudDeploymentRequestSchema.shape,
  ).strict();
export type DesktopDeleteCloudDeploymentInput = z.infer<
  typeof DesktopDeleteCloudDeploymentInputSchema
>;
