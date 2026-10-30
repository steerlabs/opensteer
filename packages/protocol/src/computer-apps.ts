import {
  MacOwnerInputResetParamsSchema,
  MacOwnerInputVersionSchema,
  MacOwnerInputParamsSchema,
  MacOwnerInputEventSchema,
} from "./mac-window-video.js";
import {
  MacWindowTargetSchema,
  DisplaySourceSchema as MacVideoSourceSchema,
} from "./display-stream.js";
import {
  ComputerViewAuthoritySchema,
  ComputerViewTargetSchema,
  ComputerViewNativeResultSchema,
} from "./computer-view.js";
import { RunIdSchema } from "@opensteer/core";
import {
  IntegrationAccessSchema,
  IntegrationDefinitionIdSchema,
  IntegrationServerIdSchema,
  LocalMcpLaunchSchema,
  McpIdentifierSchema,
} from "@opensteer/integration-core";
import { z } from "zod";
import {
  LoginReceiverKeySchema,
  PasswordSignInAuthorityCommandSchema,
  PasswordSignInAuthorityEventSchema,
  PasswordSignInAuthorityResultSchema,
} from "./password-sign-in.js";
import {
  ComputerAppApprovalAnswerFrameSchema,
  ComputerAppApprovalListSchema,
  ComputerAppApprovalOutcomeFrameSchema,
  ComputerAppApprovalKeyChallengeSchema,
  ComputerAppApprovalKeyProofSchema,
  approvalAnswerNamesItsRequest,
} from "./computer-app-approvals.js";
import { androidPhoneDefinitionId } from "./android-phone.js";
import {
  ComputerAppIdentitySchema,
  ComputerUseErrorCodeSchema,
  ComputerUseHelperEventSchema,
  ComputerUseOperationSchema,
  ComputerUseViewWindowsParamsSchema,
  ComputerUseViewWindowsResultSchema,
  ComputerUseSessionIdSchema,
  type ComputerUseOperation,
} from "./computer-use.js";
import {
  DisplaySourceSchema,
  DisplayDemandSchema,
  MacDisplayWarmSchema,
  DisplaySequenceSchema,
  DisplayInputSchema,
  DisplayInputResultSchema,
  DisplayEditingSchema,
  DisplayClipboardSchema,
  DisplayMaxFpsSchema,
  DisplayMaxLongSideSchema,
  DisplayStreamIdSchema,
  DisplayStreamReasonSchema,
  DisplayStreamStateSchema,
  DisplayViewerStateSchema,
} from "./display-stream.js";
import {
  RunnerAuxiliaryChallengeSchema,
  RunnerAuxiliaryFrameFenceSchema,
  RunnerAuxiliaryLeaseRenewedSchema,
  RunnerAuxiliaryRejectedSchema,
  RunnerAuxiliaryRequestIdSchema,
  RunnerAuxiliaryTicketSchema,
  RunnerAuxiliaryWelcomeSchema,
} from "./runner-auxiliary.js";

export const computerAppMaxFrameBytes = 1_024 * 1_024;
export const computerAppMaxConcurrentInvokes = 4;
export const computerAppMaxTimeoutMs = 60_000;
export const computerAppMaxStatusEntries = 64;

const contractSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
// Integration manifests deliberately accept unknown JSON-schema keywords, but
// an invoke is a JSON wire frame and must reject values JSON cannot carry.
const JsonObjectSchema = z.record(z.string(), z.json());
const integrationsFrameBase = {
  ...RunnerAuxiliaryFrameFenceSchema.shape,
  module: z.literal("integrations"),
} as const;

export const ComputerAppStateSchema = z.enum(["ready", "permission-required", "unavailable"]);
export type ComputerAppState = z.infer<typeof ComputerAppStateSchema>;

export const ComputerAppRemedySchema = z.enum([
  "full-disk-access",
  "automation",
  "accessibility",
  "screen-recording",
  "contacts",
  "calendars",
  "reminders",
]);
export type ComputerAppRemedy = z.infer<typeof ComputerAppRemedySchema>;

export const ComputerAppOperationStatusSchema = z.strictObject({
  detail: z.string().min(1).max(1_000).nullable(),
  operation: McpIdentifierSchema,
  remedy: ComputerAppRemedySchema.nullable(),
  state: ComputerAppStateSchema,
});
export type ComputerAppOperationStatus = z.infer<typeof ComputerAppOperationStatusSchema>;

export const ComputerAppStatusEntrySchema = z.strictObject({
  definitionId: IntegrationDefinitionIdSchema,
  operations: z.array(ComputerAppOperationStatusSchema).max(64),
});
export type ComputerAppStatusEntry = z.infer<typeof ComputerAppStatusEntrySchema>;

export const RunnerIntegrationsStatusSchema = z.strictObject({
  ...integrationsFrameBase,
  loginText: LoginReceiverKeySchema.optional(),
  passwordSignIn: z.literal(1).optional(),
  apps: z.array(ComputerAppStatusEntrySchema).max(computerAppMaxStatusEntries),
  captureSupported: z.boolean().optional(),
  displayAvailable: z.boolean().optional(),
  ownerViewVersion: z.number().int().positive().max(1000).optional(),
  type: z.literal("runner.integrations.status"),
});
export type RunnerIntegrationsStatus = z.infer<typeof RunnerIntegrationsStatusSchema>;

export const HostIntegrationsPasswordSignInSchema = z.strictObject({
  ...integrationsFrameBase,
  type: z.literal("host.integrations.password-sign-in"),
  requestId: RunnerAuxiliaryRequestIdSchema,
  timeoutMs: z.number().int().min(1).max(computerAppMaxTimeoutMs),
  command: PasswordSignInAuthorityCommandSchema,
});
export type HostIntegrationsPasswordSignIn = z.infer<typeof HostIntegrationsPasswordSignInSchema>;

export const RunnerIntegrationsPasswordSignInResultSchema = z.strictObject({
  ...integrationsFrameBase,
  type: z.literal("runner.integrations.password-sign-in-result"),
  requestId: RunnerAuxiliaryRequestIdSchema,
  result: PasswordSignInAuthorityResultSchema,
});
export type RunnerIntegrationsPasswordSignInResult = z.infer<
  typeof RunnerIntegrationsPasswordSignInResultSchema
>;

export const RunnerIntegrationsPasswordSignInEventSchema = z.strictObject({
  ...integrationsFrameBase,
  type: z.literal("runner.integrations.password-sign-in-event"),
  event: PasswordSignInAuthorityEventSchema,
});
export type RunnerIntegrationsPasswordSignInEvent = z.infer<
  typeof RunnerIntegrationsPasswordSignInEventSchema
>;

export const HostIntegrationsInvokeSchema = z.strictObject({
  ...integrationsFrameBase,
  access: IntegrationAccessSchema,
  arguments: JsonObjectSchema,
  contract: contractSchema,
  definitionId: IntegrationDefinitionIdSchema,
  operation: McpIdentifierSchema,
  requestId: RunnerAuxiliaryRequestIdSchema,
  timeoutMs: z.number().int().positive().max(computerAppMaxTimeoutMs),
  type: z.literal("host.integrations.invoke"),
});
export type HostIntegrationsInvoke = z.infer<typeof HostIntegrationsInvokeSchema>;

/**
 * One computer-use operation on this Mac.
 *
 * It rides the same stream as an invoke — same fence, lease, concurrency cap
 * and cancellation — rather than a transport of its own, because it is the
 * same authority: one Deployment reaching one app on one enrolled computer.
 * What it carries beyond an invoke is the session, which invokes do not have,
 * and the app and access the **Host** resolved from the connection and the
 * effective grant. Neither is ever a caller's argument: the Runner passes them
 * through untouched and the helper refuses anything else. They are null for
 * the three operations that are about the Mac rather than one app.
 *
 * `definitionId` names the computer app the operation belongs to when it is not
 * the Mac's: absent is `macos-app`, so a frame to a Mac is byte for byte what
 * it was before phones existed. An Android phone's operations name no app,
 * because its connection is the whole display, and it has none of the Mac's
 * app-picking operations.
 */
export const HostIntegrationsComputerUseSchema = z
  .strictObject({
    ...integrationsFrameBase,
    access: IntegrationAccessSchema.nullable(),
    app: ComputerAppIdentitySchema.nullable(),
    definitionId: z.literal(androidPhoneDefinitionId).optional(),
    operation: ComputerUseOperationSchema,
    params: JsonObjectSchema,
    requestId: RunnerAuxiliaryRequestIdSchema,
    runId: RunIdSchema,
    sessionId: ComputerUseSessionIdSchema,
    threadTitle: z.string().max(240).nullable(),
    timeoutMs: z.number().int().positive().max(computerAppMaxTimeoutMs),
    type: z.literal("host.integrations.computer-use"),
  })
  .superRefine((frame, context) => {
    const operated =
      frame.operation === "observe" ||
      frame.operation === "act" ||
      frame.operation === "windows" ||
      frame.operation === "bind";
    if (frame.definitionId === androidPhoneDefinitionId) {
      // A phone's connection is its whole display: there is no app to name,
      // and nothing to pick or resolve before operating it.
      if (frame.app !== null) {
        context.addIssue({
          code: "custom",
          message: "An Android phone operation names no app",
          path: ["app"],
        });
      }
      if (!androidPhoneOperations.has(frame.operation)) {
        context.addIssue({
          code: "custom",
          message: `An Android phone has no ${frame.operation} operation`,
          path: ["operation"],
        });
      }
      if (operated === (frame.access === null)) {
        context.addIssue({
          code: "custom",
          message: `Computer use ${frame.operation} ${operated ? "requires" : "carries no"} access`,
          path: ["access"],
        });
      }
      return;
    }
    // An app operation that names no app would leave the helper to guess which
    // process it is talking to, and a Mac operation that names one would imply
    // an approval nobody gave.
    const namesApp = operated;
    if (namesApp === (frame.app === null)) {
      context.addIssue({
        code: "custom",
        message: `Computer use ${frame.operation} ${namesApp ? "requires" : "carries no"} app identity`,
        path: ["app"],
      });
    }
    if (namesApp === (frame.access === null)) {
      context.addIssue({
        code: "custom",
        message: `Computer use ${frame.operation} ${namesApp ? "requires" : "carries no"} access`,
        path: ["access"],
      });
    }
  });
export type HostIntegrationsComputerUse = z.infer<typeof HostIntegrationsComputerUseSchema>;

/**
 * The computer-use operations an Android phone answers. `close` is how a
 * session lets go of it; `installed_apps` lists what `launch` can open, for
 * its owner, without touching any session.
 */
const androidPhoneOperations: ReadonlySet<ComputerUseOperation> = new Set([
  "observe",
  "act",
  "close",
  "installed_apps",
]);

/**
 * The Host's word that a person's Stop is durably recorded, so the computer
 * that reported it may stop reporting it again. It answers only a
 * `session.stopped` event that named its Run, which only a phone sends; a
 * Mac's desktop ends its sessions with its connection and never receives it.
 */
export const HostIntegrationsComputerUseStopRecordedSchema = z.strictObject({
  ...integrationsFrameBase,
  runId: RunIdSchema,
  sessionId: ComputerUseSessionIdSchema,
  type: z.literal("host.integrations.computer-use-stop-recorded"),
});
export type HostIntegrationsComputerUseStopRecorded = z.infer<
  typeof HostIntegrationsComputerUseStopRecordedSchema
>;

export const HostIntegrationsCancelSchema = z.strictObject({
  ...integrationsFrameBase,
  requestId: RunnerAuxiliaryRequestIdSchema,
  type: z.literal("host.integrations.cancel"),
});
export type HostIntegrationsCancel = z.infer<typeof HostIntegrationsCancelSchema>;

/**
 * Every approval waiting on this Mac, with what its panel shows. The Host sends
 * it when the stream attaches, when the Runner asks, and after anything changes
 * an approval on this Mac; `ComputerAppApprovalListSchema` says why it is
 * always the whole set. Only a Runner whose `integrations` module declares
 * `computerAppApprovals` is sent one.
 */
export const HostIntegrationsComputerAppApprovalsSchema = z.strictObject({
  ...integrationsFrameBase,
  ...ComputerAppApprovalListSchema.shape,
  type: z.literal("host.integrations.computer-app-approvals"),
});
export type HostIntegrationsComputerAppApprovals = z.infer<
  typeof HostIntegrationsComputerAppApprovalsSchema
>;

/** What the Host did with this Mac's answer to one approval. */
export const HostIntegrationsComputerAppApprovalOutcomeSchema = z.strictObject({
  ...integrationsFrameBase,
  ...ComputerAppApprovalOutcomeFrameSchema.shape,
  type: z.literal("host.integrations.computer-app-approval-outcome"),
});
export type HostIntegrationsComputerAppApprovalOutcome = z.infer<
  typeof HostIntegrationsComputerAppApprovalOutcomeSchema
>;

export const HostIntegrationsComputerAppApprovalKeyChallengeSchema = z.strictObject({
  ...integrationsFrameBase,
  ...ComputerAppApprovalKeyChallengeSchema.shape,
  type: z.literal("host.integrations.computer-app-approval-key-challenge"),
});
export type HostIntegrationsComputerAppApprovalKeyChallenge = z.infer<
  typeof HostIntegrationsComputerAppApprovalKeyChallengeSchema
>;

/**
 * One session with an MCP server this computer runs for its Deployment
 * (`docs/computers.md`, "MCP servers on a computer"). The Host is the
 * server's MCP client; the Runner starts the launch its owner approved on
 * this computer — or reaches its loopback — and carries JSON-RPC messages
 * both ways without reading them. A session ends when either side closes it
 * or the stream ends, and a program the Runner started ends with it.
 */
export const computerMcpMaxSessions = 16;
const McpSessionIdSchema = z.uuid();

export const HostIntegrationsMcpOpenSchema = z.strictObject({
  ...integrationsFrameBase,
  launch: LocalMcpLaunchSchema,
  serverId: IntegrationServerIdSchema,
  sessionId: McpSessionIdSchema,
  type: z.literal("host.integrations.mcp.open"),
});
export type HostIntegrationsMcpOpen = z.infer<typeof HostIntegrationsMcpOpenSchema>;

export const HostIntegrationsMcpMessageSchema = z.strictObject({
  ...integrationsFrameBase,
  message: z.json(),
  sessionId: McpSessionIdSchema,
  type: z.literal("host.integrations.mcp.message"),
});
export type HostIntegrationsMcpMessage = z.infer<typeof HostIntegrationsMcpMessageSchema>;

export const HostIntegrationsMcpCloseSchema = z.strictObject({
  ...integrationsFrameBase,
  sessionId: McpSessionIdSchema,
  type: z.literal("host.integrations.mcp.close"),
});
export type HostIntegrationsMcpClose = z.infer<typeof HostIntegrationsMcpCloseSchema>;

export type HostIntegrationsOperation =
  | HostIntegrationsPasswordSignIn
  | z.infer<typeof HostIntegrationsDisplayResolveSchema>
  | HostIntegrationsComputerAppWindows
  | HostIntegrationsComputerView
  | HostIntegrationsInvoke
  | HostIntegrationsComputerUse
  | HostIntegrationsComputerUseStopRecorded
  | HostIntegrationsCancel
  | HostIntegrationsComputerAppApprovals
  | HostIntegrationsComputerAppApprovalOutcome
  | HostIntegrationsComputerAppApprovalKeyChallenge
  | HostIntegrationsMcpOpen
  | HostIntegrationsMcpMessage
  | HostIntegrationsMcpClose
  | HostIntegrationsDisplayStart
  | z.infer<typeof HostIntegrationsDisplayDemandSchema>
  | HostIntegrationsDisplayStop
  | HostIntegrationsDisplayRefresh
  | HostIntegrationsDisplayInput
  | HostIntegrationsDisplayInputReset
  | z.infer<typeof HostIntegrationsMacOwnerInputSchema>
  | z.infer<typeof HostIntegrationsMacOwnerInputResetSchema>;

export const ComputerAppErrorCodeSchema = z.enum([
  "invalid-arguments",
  "permission-required",
  "unsupported",
  "busy",
  "failed",
  "outcome-unknown",
]);
export type ComputerAppErrorCode = z.infer<typeof ComputerAppErrorCodeSchema>;

const ComputerAppResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ok"), value: z.json() }),
  z.strictObject({
    code: ComputerAppErrorCodeSchema,
    kind: z.literal("error"),
    message: z.string().min(1).max(16_384),
  }),
]);

export const RunnerIntegrationsResultSchema = z.strictObject({
  ...integrationsFrameBase,
  requestId: RunnerAuxiliaryRequestIdSchema,
  result: ComputerAppResultSchema,
  type: z.literal("runner.integrations.result"),
});
export type RunnerIntegrationsResult = z.infer<typeof RunnerIntegrationsResultSchema>;

/**
 * The answer to one computer-use frame.
 *
 * Its failures are computer use's own vocabulary rather than the invoke codes:
 * `stale-observation` and `stopped-by-user` are the whole
 * point of the feature, and flattening them into `failed` would leave a model
 * with nothing to do next.
 */
const ComputerUseFrameResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ok"), value: z.json() }),
  z.strictObject({
    code: ComputerUseErrorCodeSchema,
    kind: z.literal("error"),
    message: z.string().min(1).max(16_384),
  }),
]);

export const RunnerIntegrationsComputerUseResultSchema = z.strictObject({
  ...integrationsFrameBase,
  requestId: RunnerAuxiliaryRequestIdSchema,
  result: ComputerUseFrameResultSchema,
  type: z.literal("runner.integrations.computer-use-result"),
});
export type RunnerIntegrationsComputerUseResult = z.infer<
  typeof RunnerIntegrationsComputerUseResultSchema
>;

export const RunnerIntegrationsComputerUseEventSchema = z.strictObject({
  ...integrationsFrameBase,
  event: ComputerUseHelperEventSchema,
  type: z.literal("runner.integrations.computer-use-event"),
});
export type RunnerIntegrationsComputerUseEvent = z.infer<
  typeof RunnerIntegrationsComputerUseEventSchema
>;

export const RunnerIntegrationsMcpOpenedSchema = z.strictObject({
  ...integrationsFrameBase,
  sessionId: McpSessionIdSchema,
  type: z.literal("runner.integrations.mcp.opened"),
});
export type RunnerIntegrationsMcpOpened = z.infer<typeof RunnerIntegrationsMcpOpenedSchema>;

export const RunnerIntegrationsMcpMessageSchema = z.strictObject({
  ...integrationsFrameBase,
  message: z.json(),
  sessionId: McpSessionIdSchema,
  type: z.literal("runner.integrations.mcp.message"),
});
export type RunnerIntegrationsMcpMessage = z.infer<typeof RunnerIntegrationsMcpMessageSchema>;

/**
 * Why a session ended, or null when the Host asked. `unapproved` is a launch
 * this computer's owner has not approved here, so it was never started;
 * `too-large` a message this stream cannot carry, so the session was ended
 * rather than the stream.
 */
export const McpSessionCloseCodeSchema = z.enum(["unapproved", "failed", "too-large"]);
export type McpSessionCloseCode = z.infer<typeof McpSessionCloseCodeSchema>;

export const RunnerIntegrationsMcpClosedSchema = z.strictObject({
  ...integrationsFrameBase,
  error: z
    .strictObject({ code: McpSessionCloseCodeSchema, message: z.string().min(1).max(4_096) })
    .nullable(),
  sessionId: McpSessionIdSchema,
  type: z.literal("runner.integrations.mcp.closed"),
});
export type RunnerIntegrationsMcpClosed = z.infer<typeof RunnerIntegrationsMcpClosedSchema>;

/** The person's answer on this Mac, signed with the desktop's approval key. */
export const RunnerIntegrationsComputerAppApprovalAnswerSchema = z
  .strictObject({
    ...integrationsFrameBase,
    ...ComputerAppApprovalAnswerFrameSchema.shape,
    type: z.literal("runner.integrations.computer-app-approval-answer"),
  })
  .refine(approvalAnswerNamesItsRequest, "An approval answers the setup request it names");
export type RunnerIntegrationsComputerAppApprovalAnswer = z.infer<
  typeof RunnerIntegrationsComputerAppApprovalAnswerSchema
>;

/**
 * Asks for the whole list again. A Runner asks whenever its bridge to the
 * desktop connects, because a desktop that started after the stream attached,
 * or was away when the list came, never saw it.
 */
export const RunnerIntegrationsComputerAppApprovalsSyncSchema = z.strictObject({
  ...integrationsFrameBase,
  type: z.literal("runner.integrations.computer-app-approvals-sync"),
});
export type RunnerIntegrationsComputerAppApprovalsSync = z.infer<
  typeof RunnerIntegrationsComputerAppApprovalsSyncSchema
>;

export const RunnerIntegrationsComputerAppApprovalKeyProofSchema = z.strictObject({
  ...integrationsFrameBase,
  ...ComputerAppApprovalKeyProofSchema.shape,
  type: z.literal("runner.integrations.computer-app-approval-key-proof"),
});
export type RunnerIntegrationsComputerAppApprovalKeyProof = z.infer<
  typeof RunnerIntegrationsComputerAppApprovalKeyProofSchema
>;

/** Independent owner authority, bound to this authenticated auxiliary connection; never a Run. */
export const HostIntegrationsComputerViewSchema = z
  .strictObject({
    ...integrationsFrameBase,
    type: z.literal("host.integrations.computer-view"),
    version: z.union([z.literal(1), z.literal(3)]),
    ...ComputerViewAuthoritySchema.shape,
    target: ComputerViewTargetSchema,
    operation: z.enum(["open", "renew", "close"]),
    requestId: RunnerAuxiliaryRequestIdSchema,
    timeoutMs: z.number().int().positive().max(computerAppMaxTimeoutMs),
  })
  .refine(
    (message) => message.version === (message.target.kind === "app" ? 3 : 1),
    "Owner-view version must match the target",
  );
export type HostIntegrationsComputerView = z.infer<typeof HostIntegrationsComputerViewSchema>;
export const RunnerIntegrationsComputerViewResultSchema = z.strictObject({
  ...integrationsFrameBase,
  type: z.literal("runner.integrations.computer-view-result"),
  requestId: RunnerAuxiliaryRequestIdSchema,
  result: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("ok"), value: ComputerViewNativeResultSchema }),
    z.strictObject({
      kind: z.literal("error"),
      code: z.enum([
        "unsupported",
        "ended",
        "stale-generation",
        "permission-required",
        "unavailable",
      ]),
      message: z.string().min(1).max(1000),
    }),
  ]),
});
export type RunnerIntegrationsComputerViewResult = z.infer<
  typeof RunnerIntegrationsComputerViewResultSchema
>;

export const HostIntegrationsComputerAppWindowsSchema = z.strictObject({
  ...integrationsFrameBase,
  ...ComputerUseViewWindowsParamsSchema.shape,
  requestId: RunnerAuxiliaryRequestIdSchema,
  timeoutMs: z.number().int().min(1).max(30_000),
  type: z.literal("host.integrations.computer-app-windows"),
});
export type HostIntegrationsComputerAppWindows = z.infer<
  typeof HostIntegrationsComputerAppWindowsSchema
>;
export const RunnerIntegrationsComputerAppWindowsResultSchema = z.strictObject({
  ...integrationsFrameBase,
  requestId: RunnerAuxiliaryRequestIdSchema,
  type: z.literal("runner.integrations.computer-app-windows-result"),
  result: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("ok"), value: ComputerUseViewWindowsResultSchema }),
    z.strictObject({
      kind: z.literal("error"),
      code: ComputerUseErrorCodeSchema,
      message: z.string().min(1).max(1_000),
    }),
  ]),
});
export type RunnerIntegrationsComputerAppWindowsResult = z.infer<
  typeof RunnerIntegrationsComputerAppWindowsResultSchema
>;

export const HostIntegrationsMacOwnerInputSchema = z.strictObject({
  ...integrationsFrameBase,
  type: z.literal("host.integrations.mac-owner.input"),
  ...MacOwnerInputParamsSchema.shape,
});
export const HostIntegrationsMacOwnerInputResetSchema = z.strictObject({
  ...integrationsFrameBase,
  type: z.literal("host.integrations.mac-owner.input-reset"),
  ...MacOwnerInputResetParamsSchema.shape,
});
export const RunnerIntegrationsMacOwnerEventSchema = z.strictObject({
  ...integrationsFrameBase,
  type: z.literal("runner.integrations.mac-owner.event"),
  ...MacOwnerInputEventSchema.shape,
});
export const HostIntegrationsDisplayResolveSchema = z.strictObject({
  ...integrationsFrameBase,
  type: z.literal("host.integrations.display.resolve"),
  requestId: RunnerAuxiliaryRequestIdSchema,
  source: MacVideoSourceSchema,
  ownerInputVersion: MacOwnerInputVersionSchema,
  timeoutMs: z.number().int().positive().max(30_000),
});
export const RunnerIntegrationsDisplayResolvedSchema = z.strictObject({
  ...integrationsFrameBase,
  type: z.literal("runner.integrations.display.resolved"),
  requestId: RunnerAuxiliaryRequestIdSchema,
  target: MacWindowTargetSchema.nullable(),
  reason: DisplayStreamReasonSchema.optional(),
});
export const RunnerIntegrationsDisplaySourceChangedSchema = z.strictObject({
  ...integrationsFrameBase,
  type: z.literal("runner.integrations.display.source-changed"),
  streamId: DisplayStreamIdSchema,
  source: MacVideoSourceSchema,
});

export const HostIntegrationsDisplayStartSchema = z
  .strictObject({
    ...integrationsFrameBase,
    type: z.literal("host.integrations.display.start"),
    display: z.literal("main"),
    target: MacWindowTargetSchema.optional(),
    streamId: DisplayStreamIdSchema,
    dataTicket: RunnerAuxiliaryTicketSchema,
    revision: DisplaySequenceSchema,
    sources: DisplayDemandSchema,
    maxLongSide: DisplayMaxLongSideSchema,
    maxFps: DisplayMaxFpsSchema,
    /** Only sent to producers advertising integrations.editing: 1. */
    editingVersion: z.literal(1).optional(),
    /** Only sent to Android producers advertising integrations.displayCut: 1. */
    displayCut: z.literal(1).optional(),
    /**
     * Only sent to Android producers advertising integrations.sharedInput: 1:
     * the person's input goes in alongside the agent's acts.
     */
    sharedInput: z.literal(1).optional(),
    /** Remaining resolution-through-first-keyframe budget; Mac only. */
    timeoutMs: z.number().int().positive().max(30_000).optional(),
  })
  .refine(
    (start) =>
      start.target === undefined ? start.timeoutMs === undefined : start.timeoutMs !== undefined,
    {
      message: "Mac starts require the remaining startup duration; phone starts do not carry it.",
    },
  );
export type HostIntegrationsDisplayStart = z.infer<typeof HostIntegrationsDisplayStartSchema>;
export const HostIntegrationsDisplayStopSchema = z.strictObject({
  ...integrationsFrameBase,
  type: z.literal("host.integrations.display.stop"),
  display: z.literal("main"),
  streamId: DisplayStreamIdSchema,
});
export type HostIntegrationsDisplayStop = z.infer<typeof HostIntegrationsDisplayStopSchema>;
export const HostIntegrationsDisplayRefreshSchema = z.strictObject({
  ...integrationsFrameBase,
  type: z.literal("host.integrations.display.refresh"),
  display: z.literal("main"),
  streamId: DisplayStreamIdSchema,
});
export type HostIntegrationsDisplayRefresh = z.infer<typeof HostIntegrationsDisplayRefreshSchema>;
/** One batch of the stream's person lane; sent only after display.start carried sharedInput. */
export const HostIntegrationsDisplayInputSchema = z.strictObject({
  ...integrationsFrameBase,
  type: z.literal("host.integrations.display.input"),
  sessionId: ComputerUseSessionIdSchema,
  streamId: DisplayStreamIdSchema,
  ...DisplayInputSchema.shape,
});
export type HostIntegrationsDisplayInput = z.infer<typeof HostIntegrationsDisplayInputSchema>;
/** The viewer holding the person lane left mid-gesture: end the stroke, release held keys, drop queued input. */
export const HostIntegrationsDisplayInputResetSchema = z.strictObject({
  ...integrationsFrameBase,
  type: z.literal("host.integrations.display.input-reset"),
  sessionId: ComputerUseSessionIdSchema,
  streamId: DisplayStreamIdSchema,
});
export type HostIntegrationsDisplayInputReset = z.infer<
  typeof HostIntegrationsDisplayInputResetSchema
>;
export const RunnerIntegrationsDisplayStateSchema = z.strictObject({
  ...integrationsFrameBase,
  type: z.literal("runner.integrations.display.state"),
  display: z.literal("main"),
  streamId: DisplayStreamIdSchema,
  state: DisplayStreamStateSchema,
  reason: DisplayStreamReasonSchema.optional(),
  generation: DisplayViewerStateSchema.shape.generation,
  width: DisplayViewerStateSchema.shape.width,
  height: DisplayViewerStateSchema.shape.height,
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
});
export type RunnerIntegrationsDisplayState = z.infer<typeof RunnerIntegrationsDisplayStateSchema>;
/** Editing replies name the stream's person lane and the picture fence of their input. */
const displayEditingReplyBase = {
  ...integrationsFrameBase,
  sessionId: ComputerUseSessionIdSchema,
  streamId: DisplayStreamIdSchema,
  geometry: DisplayInputSchema.shape.geometry,
};
export const RunnerIntegrationsDisplayInputResultSchema = z.strictObject({
  ...DisplayInputResultSchema.omit({ type: true }).shape,
  ...displayEditingReplyBase,
  type: z.literal("runner.integrations.display.input-result"),
});
export const RunnerIntegrationsDisplayEditingSchema = z.strictObject({
  ...DisplayEditingSchema.omit({ type: true, generation: true }).shape,
  ...displayEditingReplyBase,
  type: z.literal("runner.integrations.display.editing"),
});
export const RunnerIntegrationsDisplayClipboardSchema = z.strictObject({
  ...DisplayClipboardSchema.omit({ type: true }).shape,
  ...displayEditingReplyBase,
  type: z.literal("runner.integrations.display.clipboard"),
});

export const HostIntegrationsDisplayDemandSchema = z.strictObject({
  ...integrationsFrameBase,
  type: z.literal("host.integrations.display.demand"),
  display: z.literal("main"),
  streamId: DisplayStreamIdSchema,
  revision: DisplaySequenceSchema,
  sources: DisplayDemandSchema,
  warm: MacDisplayWarmSchema.optional(),
  maxLongSide: DisplayMaxLongSideSchema.optional(),
});
export const RunnerIntegrationsDisplaySourceEndedSchema = z.strictObject({
  ...integrationsFrameBase,
  type: z.literal("runner.integrations.display.source-ended"),
  display: z.literal("main"),
  streamId: DisplayStreamIdSchema,
  source: DisplaySourceSchema,
  reason: z.enum(["session-ended", "owner-ended", "owner-expired", "owner-revoked"]),
});

export const HostToIntegrationsModuleMessageSchema = z
  .discriminatedUnion("type", [
    HostIntegrationsPasswordSignInSchema,
    RunnerAuxiliaryChallengeSchema,
    RunnerAuxiliaryWelcomeSchema,
    RunnerAuxiliaryRejectedSchema,
    RunnerAuxiliaryLeaseRenewedSchema,
    HostIntegrationsMacOwnerInputSchema,
    HostIntegrationsMacOwnerInputResetSchema,
    HostIntegrationsDisplayResolveSchema,
    HostIntegrationsDisplayStartSchema,
    HostIntegrationsDisplayDemandSchema,
    HostIntegrationsDisplayStopSchema,
    HostIntegrationsDisplayRefreshSchema,
    HostIntegrationsDisplayInputSchema,
    HostIntegrationsDisplayInputResetSchema,
    HostIntegrationsInvokeSchema,
    HostIntegrationsComputerUseSchema,
    HostIntegrationsComputerAppWindowsSchema,
    HostIntegrationsComputerViewSchema,
    HostIntegrationsComputerUseStopRecordedSchema,
    HostIntegrationsCancelSchema,
    HostIntegrationsComputerAppApprovalsSchema,
    HostIntegrationsComputerAppApprovalOutcomeSchema,
    HostIntegrationsComputerAppApprovalKeyChallengeSchema,
    HostIntegrationsMcpOpenSchema,
    HostIntegrationsMcpMessageSchema,
    HostIntegrationsMcpCloseSchema,
  ])
  .refine(frameFits, `Computer app frame exceeds ${computerAppMaxFrameBytes} bytes`);
export type HostToIntegrationsModuleMessage = z.infer<typeof HostToIntegrationsModuleMessageSchema>;

export const IntegrationsModuleEventSchema = z
  .discriminatedUnion("type", [
    RunnerIntegrationsPasswordSignInResultSchema,
    RunnerIntegrationsPasswordSignInEventSchema,
    RunnerIntegrationsMacOwnerEventSchema,
    RunnerIntegrationsDisplayResolvedSchema,
    RunnerIntegrationsDisplaySourceChangedSchema,
    RunnerIntegrationsDisplayStateSchema,
    RunnerIntegrationsDisplaySourceEndedSchema,
    RunnerIntegrationsDisplayInputResultSchema,
    RunnerIntegrationsDisplayEditingSchema,
    RunnerIntegrationsDisplayClipboardSchema,
    RunnerIntegrationsStatusSchema,
    RunnerIntegrationsComputerAppWindowsResultSchema,
    RunnerIntegrationsComputerViewResultSchema,
    RunnerIntegrationsResultSchema,
    RunnerIntegrationsComputerUseResultSchema,
    RunnerIntegrationsComputerUseEventSchema,
    RunnerIntegrationsComputerAppApprovalAnswerSchema,
    RunnerIntegrationsComputerAppApprovalsSyncSchema,
    RunnerIntegrationsComputerAppApprovalKeyProofSchema,
    RunnerIntegrationsMcpOpenedSchema,
    RunnerIntegrationsMcpMessageSchema,
    RunnerIntegrationsMcpClosedSchema,
  ])
  .refine(frameFits, `Computer app frame exceeds ${computerAppMaxFrameBytes} bytes`);
export type IntegrationsModuleEvent = z.infer<typeof IntegrationsModuleEventSchema>;

/** Whether a frame fits this stream, for a side deciding before it sends one. */
export function computerAppFrameFits(value: unknown): boolean {
  return frameFits(value);
}

function frameFits(value: unknown): boolean {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <= computerAppMaxFrameBytes;
}
