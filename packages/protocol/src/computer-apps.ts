import {
  ComputerUseWindowResolveParamsSchema,
  ComputerUseWindowResolveResultSchema,
} from "./computer-use.js";
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
import {
  DeviceIdSchema,
  DeviceDriverGenerationSchema,
  PhoneDisplayDefinitionIdSchema,
  isPhoneDisplayDefinitionId,
  iphoneScreenDefinitionId,
  RunIdSchema,
} from "@opensteer/core";
import {
  DeviceAvailabilitySchema,
  PhoneDisplayActionTypeSchema,
  PhoneDisplayNavigationButtonsSchema,
} from "./devices.js";
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
import { RunFileExecutionSchema, RunFileTransferSchema, runFileMaxPerCall } from "./run-files.js";
import {
  ComputerAppIdentitySchema,
  ComputerUseErrorCodeSchema,
  ComputerUseHelperEventSchema,
  ComputerUseOperationSchema,
  ComputerUseViewWindowsParamsSchema,
  ComputerUseViewWindowsResultSchema,
  ComputerUseSessionIdSchema,
} from "./computer-use.js";
import {
  DisplaySourceSchema,
  type DisplaySource,
  DisplayDemandSchema,
  MacDisplayWarmSchema,
  DisplaySequenceSchema,
  DisplayInputSchema,
  DisplayInputResultSchema,
  DisplayPowerSchema,
  DisplayPowerResultSchema,
  displaySourceKey,
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

export const DeviceDriverTargetSchema = z.strictObject({
  deviceId: DeviceIdSchema,
  driverGeneration: DeviceDriverGenerationSchema,
});
export type DeviceDriverTarget = z.infer<typeof DeviceDriverTargetSchema>;
const routedDeviceFields = DeviceDriverTargetSchema.partial().shape;
function pairedDeviceTarget(value: { deviceId?: unknown; driverGeneration?: unknown }): boolean {
  return (value.deviceId === undefined) === (value.driverGeneration === undefined);
}

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
  passwordSignIn: z.literal(2).optional(),
  apps: z.array(ComputerAppStatusEntrySchema).max(computerAppMaxStatusEntries),
  captureSupported: z.boolean().optional(),
  displayAvailable: z.boolean().optional(),
  ownerViewVersion: z.number().int().positive().max(1000).optional(),
  type: z.literal("runner.integrations.status"),
});
export type RunnerIntegrationsStatus = z.infer<typeof RunnerIntegrationsStatusSchema>;

export const deviceDriverMaxAssignments = 256;
export const DeviceScreenDriverAssignmentSchema = z.strictObject({
  deviceId: DeviceIdSchema,
  role: z.literal("screen"),
  definitionId: z.literal(iphoneScreenDefinitionId),
  generation: DeviceDriverGenerationSchema,
});
export type DeviceScreenDriverAssignment = z.infer<typeof DeviceScreenDriverAssignmentSchema>;
export const HostIntegrationsDeviceDriversSchema = z.strictObject({
  ...integrationsFrameBase,
  type: z.literal("host.integrations.device-drivers"),
  retainedDeviceIds: z.array(DeviceIdSchema).max(deviceDriverMaxAssignments).optional(),
  drivers: z
    .array(DeviceScreenDriverAssignmentSchema)
    .max(deviceDriverMaxAssignments)
    .refine(
      (drivers) => new Set(drivers.map(({ deviceId }) => deviceId)).size === drivers.length,
      "Device assignments must be unique",
    ),
});
export type HostIntegrationsDeviceDrivers = z.infer<typeof HostIntegrationsDeviceDriversSchema>;
const phoneDisplayVersionSchema = z.literal(1).nullable();
export const RunnerIntegrationsDeviceStatusSchema = z
  .strictObject({
    ...integrationsFrameBase,
    ...DeviceDriverTargetSchema.shape,
    type: z.literal("runner.integrations.device-status"),
    definitionId: z.literal(iphoneScreenDefinitionId),
    operations: z.array(ComputerAppOperationStatusSchema).max(4),
    availability: DeviceAvailabilitySchema,
    navigationButtons: PhoneDisplayNavigationButtonsSchema,
    actions: z.array(PhoneDisplayActionTypeSchema).max(11),
    wake: z.boolean(),
    lock: z.boolean().nullable(),
    displayVersion: phoneDisplayVersionSchema,
    ownerViewVersion: phoneDisplayVersionSchema,
    inputVersion: phoneDisplayVersionSchema,
    powerVersion: phoneDisplayVersionSchema,
  })
  .refine(
    (status) => status.operations.every(({ operation }) => phoneDisplayOperations.has(operation)),
    "Device status must name phone display operations",
  );
export type RunnerIntegrationsDeviceStatus = z.infer<typeof RunnerIntegrationsDeviceStatusSchema>;

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

/**
 * How an operation that moves files reaches its Run. `run`: the Run is on this
 * Runner, so bytes never leave the computer. `transfers`: it is elsewhere, and
 * they go through the Host, one per file, in `arguments.files` order on a send.
 */
export const ComputerAppFilesSchema = z.union([
  z.strictObject({ run: RunFileExecutionSchema }),
  z.strictObject({ transfers: z.array(RunFileTransferSchema).min(1).max(runFileMaxPerCall) }),
]);
export type ComputerAppFiles = z.infer<typeof ComputerAppFilesSchema>;

export const HostIntegrationsInvokeSchema = z.strictObject({
  ...integrationsFrameBase,
  access: IntegrationAccessSchema,
  arguments: JsonObjectSchema,
  contract: contractSchema,
  definitionId: IntegrationDefinitionIdSchema,
  files: ComputerAppFilesSchema.optional(),
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
    ...routedDeviceFields,
    access: IntegrationAccessSchema.nullable(),
    app: ComputerAppIdentitySchema.nullable(),
    definitionId: PhoneDisplayDefinitionIdSchema.optional(),
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
    if (frame.definitionId === iphoneScreenDefinitionId && frame.deviceId === undefined) {
      context.addIssue({
        code: "custom",
        message: "An iPhone screen requires an external device route",
        path: ["deviceId"],
      });
    }
    if (frame.definitionId !== iphoneScreenDefinitionId && frame.deviceId !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Self routes omit the device target",
        path: ["deviceId"],
      });
    }
    if (isPhoneDisplayDefinitionId(frame.definitionId)) {
      // A phone's connection is its whole display: there is no app to name,
      // and nothing to pick or resolve before operating it.
      if (frame.app !== null) {
        context.addIssue({
          code: "custom",
          message: "A phone display operation names no app",
          path: ["app"],
        });
      }
      if (!phoneDisplayOperations.has(frame.operation)) {
        context.addIssue({
          code: "custom",
          message: `A phone display has no ${frame.operation} operation`,
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
  })
  .refine(pairedDeviceTarget, "Device ID and driver generation must travel together");
export type HostIntegrationsComputerUse = z.infer<typeof HostIntegrationsComputerUseSchema>;

/**
 * The computer-use operations an Android phone answers. `close` is how a
 * session lets go of it; `installed_apps` lists what `launch` can open, for
 * its owner, without touching any session.
 */
const phoneDisplayOperations: ReadonlySet<string> = new Set([
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
export const HostIntegrationsComputerUseStopRecordedSchema = z
  .strictObject({
    ...integrationsFrameBase,
    ...routedDeviceFields,
    runId: RunIdSchema,
    sessionId: ComputerUseSessionIdSchema,
    type: z.literal("host.integrations.computer-use-stop-recorded"),
  })
  .refine(pairedDeviceTarget, "Device ID and driver generation must travel together");
export type HostIntegrationsComputerUseStopRecorded = z.infer<
  typeof HostIntegrationsComputerUseStopRecordedSchema
>;

export const HostIntegrationsCancelSchema = z
  .strictObject({
    ...integrationsFrameBase,
    ...routedDeviceFields,
    requestId: RunnerAuxiliaryRequestIdSchema,
    type: z.literal("host.integrations.cancel"),
  })
  .refine(pairedDeviceTarget, "Device ID and driver generation must travel together");
export type HostIntegrationsCancel = z.infer<typeof HostIntegrationsCancelSchema>;

/**
 * One session with an MCP server this computer runs for its Deployment.
 * The Host is the
 * server's MCP client; the Runner starts the launch its owner approved on
 * this computer — or reaches its loopback — and carries JSON-RPC messages
 * both ways without reading them. A session ends when either side closes it
 * or the stream ends, and a program the Runner started ends with it.
 */
export const computerMcpMaxSessions = 16;
/**
 * Begins the end of what a stopped server wrote, in why its session closed.
 * It is cut just after this label, which is where the Host looks for a
 * secret the cut split.
 */
export const computerMcpLastOutputLabel = "Its last output: ";
const McpSessionIdSchema = z.uuid();

export const HostIntegrationsMcpOpenSchema = z.strictObject({
  packageSource: z.strictObject({ url: z.url(), token: z.string().max(4096) }).optional(),
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
  | HostIntegrationsDeviceDrivers
  | HostIntegrationsWindowResolve
  | HostIntegrationsPluginDataRemove
  | HostIntegrationsPasswordSignIn
  | z.infer<typeof HostIntegrationsDisplayResolveSchema>
  | HostIntegrationsComputerAppWindows
  | HostIntegrationsComputerView
  | HostIntegrationsInvoke
  | HostIntegrationsComputerUse
  | HostIntegrationsComputerUseStopRecorded
  | HostIntegrationsCancel
  | HostIntegrationsMcpOpen
  | HostIntegrationsMcpMessage
  | HostIntegrationsMcpClose
  | HostIntegrationsDisplayStart
  | z.infer<typeof HostIntegrationsDisplayDemandSchema>
  | HostIntegrationsDisplayStop
  | HostIntegrationsDisplayRefresh
  | HostIntegrationsDisplayInput
  | HostIntegrationsDisplayInputReset
  | z.infer<typeof HostIntegrationsDisplayPowerSchema>
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

export const RunnerIntegrationsComputerUseResultSchema = z
  .strictObject({
    ...integrationsFrameBase,
    ...routedDeviceFields,
    requestId: RunnerAuxiliaryRequestIdSchema,
    result: ComputerUseFrameResultSchema,
    type: z.literal("runner.integrations.computer-use-result"),
  })
  .refine(pairedDeviceTarget, "Device ID and driver generation must travel together");
export type RunnerIntegrationsComputerUseResult = z.infer<
  typeof RunnerIntegrationsComputerUseResultSchema
>;

export const RunnerIntegrationsComputerUseEventSchema = z
  .strictObject({
    ...integrationsFrameBase,
    ...routedDeviceFields,
    event: ComputerUseHelperEventSchema,
    type: z.literal("runner.integrations.computer-use-event"),
  })
  .refine(pairedDeviceTarget, "Device ID and driver generation must travel together");
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

const PluginDataIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/u);
/**
 * A plugin was removed: end its sessions here and delete what its servers kept
 * on this computer, such as a device's pairing. Sent only to a Runner that
 * advertises `pluginDataRemoval`, and again until it confirms.
 */
export const HostIntegrationsPluginDataRemoveSchema = z.strictObject({
  ...integrationsFrameBase,
  pluginId: PluginDataIdSchema,
  type: z.literal("host.integrations.plugin-data.remove"),
});
export type HostIntegrationsPluginDataRemove = z.infer<
  typeof HostIntegrationsPluginDataRemoveSchema
>;
/** The removed plugin's data is gone from this computer, or was never here. */
export const RunnerIntegrationsPluginDataRemovedSchema = z.strictObject({
  ...integrationsFrameBase,
  pluginId: PluginDataIdSchema,
  type: z.literal("runner.integrations.plugin-data.removed"),
});

/** Independent owner authority, bound to this authenticated auxiliary connection; never a Run. */
export const HostIntegrationsComputerViewSchema = z
  .strictObject({
    ...integrationsFrameBase,
    ...routedDeviceFields,
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
  )
  .refine(
    (frame) => frame.deviceId === undefined || frame.target.kind === "phone",
    "External screen owner views target a phone",
  )
  .refine(pairedDeviceTarget, "Device ID and driver generation must travel together");
export type HostIntegrationsComputerView = z.infer<typeof HostIntegrationsComputerViewSchema>;
export const RunnerIntegrationsComputerViewResultSchema = z
  .strictObject({
    ...integrationsFrameBase,
    ...routedDeviceFields,
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
  })
  .refine(pairedDeviceTarget, "Device ID and driver generation must travel together");
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
    ...routedDeviceFields,
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
    phoneOwnerControl: z.literal(1).optional(),
    displayProfile: z.literal(1).optional(),
    maxBitrate: z.number().int().min(150_000).max(20_000_000).nullable().optional(),
    inputSources: DisplayDemandSchema.optional(),
    /** Remaining resolution-through-first-keyframe budget; Mac only. */
    timeoutMs: z.number().int().positive().max(30_000).optional(),
  })
  .refine(
    (start) =>
      start.target === undefined ? start.timeoutMs === undefined : start.timeoutMs !== undefined,
    {
      message: "Mac starts require the remaining startup duration; phone starts do not carry it.",
    },
  )
  .refine(
    (start) =>
      (start.phoneOwnerControl === 1) === (start.inputSources !== undefined) &&
      inputSourcesSubset(start),
    "Phone input sources require negotiation and must belong to demand",
  )
  .refine(
    (start) => (start.displayProfile === 1) === (start.maxBitrate !== undefined),
    "Bitrate cap requires profile negotiation",
  )
  .refine(
    (frame) => frame.deviceId === undefined || frame.target === undefined,
    "External phone streams carry no Mac window target",
  )
  .refine(pairedDeviceTarget, "Device ID and driver generation must travel together");
export type HostIntegrationsDisplayStart = z.infer<typeof HostIntegrationsDisplayStartSchema>;
export const HostIntegrationsDisplayStopSchema = z
  .strictObject({
    ...integrationsFrameBase,
    ...routedDeviceFields,
    type: z.literal("host.integrations.display.stop"),
    display: z.literal("main"),
    streamId: DisplayStreamIdSchema,
  })
  .refine(pairedDeviceTarget, "Device ID and driver generation must travel together");
export type HostIntegrationsDisplayStop = z.infer<typeof HostIntegrationsDisplayStopSchema>;
export const HostIntegrationsDisplayRefreshSchema = z
  .strictObject({
    ...integrationsFrameBase,
    ...routedDeviceFields,
    type: z.literal("host.integrations.display.refresh"),
    display: z.literal("main"),
    streamId: DisplayStreamIdSchema,
  })
  .refine(pairedDeviceTarget, "Device ID and driver generation must travel together");
export type HostIntegrationsDisplayRefresh = z.infer<typeof HostIntegrationsDisplayRefreshSchema>;
/** One batch of the stream's person lane; sent only after display.start carried sharedInput. */
const displayInputAddress = {
  sessionId: ComputerUseSessionIdSchema.optional(),
  source: DisplaySourceSchema.optional(),
};
function oneDisplayInputAddress(value: { sessionId?: unknown; source?: unknown }): boolean {
  return (value.sessionId !== undefined) !== (value.source !== undefined);
}
function inputSourcesSubset(value: {
  sources: DisplaySource[];
  inputSources?: DisplaySource[] | undefined;
}): boolean {
  return (
    value.inputSources?.every((source) =>
      value.sources.some((item) => displaySourceKey(item) === displaySourceKey(source)),
    ) ?? true
  );
}
export const HostIntegrationsDisplayInputSchema = z
  .strictObject({
    ...integrationsFrameBase,
    ...routedDeviceFields,
    type: z.literal("host.integrations.display.input"),
    ...displayInputAddress,
    streamId: DisplayStreamIdSchema,
    ...DisplayInputSchema.shape,
  })
  .refine(oneDisplayInputAddress, "Exactly one input address is required")
  .refine(pairedDeviceTarget, "Device ID and driver generation must travel together");
export type HostIntegrationsDisplayInput = z.infer<typeof HostIntegrationsDisplayInputSchema>;
/** The viewer holding the person lane left mid-gesture: end the stroke, release held keys, drop queued input. */
export const HostIntegrationsDisplayInputResetSchema = z
  .strictObject({
    ...integrationsFrameBase,
    ...routedDeviceFields,
    type: z.literal("host.integrations.display.input-reset"),
    ...displayInputAddress,
    streamId: DisplayStreamIdSchema,
  })
  .refine(oneDisplayInputAddress, "Exactly one input address is required")
  .refine(pairedDeviceTarget, "Device ID and driver generation must travel together");
export type HostIntegrationsDisplayInputReset = z.infer<
  typeof HostIntegrationsDisplayInputResetSchema
>;
export const HostIntegrationsDisplayPowerSchema = z
  .strictObject({
    ...integrationsFrameBase,
    ...routedDeviceFields,
    ...DisplayPowerSchema.omit({ type: true }).shape,
    type: z.literal("host.integrations.display.power"),
    streamId: DisplayStreamIdSchema,
    source: DisplaySourceSchema,
  })
  .refine(pairedDeviceTarget, "Device ID and driver generation must travel together");
export const RunnerIntegrationsDisplayPowerResultSchema = z
  .strictObject({
    ...integrationsFrameBase,
    ...routedDeviceFields,
    ...DisplayPowerResultSchema.omit({ type: true }).shape,
    type: z.literal("runner.integrations.display.power-result"),
    streamId: DisplayStreamIdSchema,
    source: DisplaySourceSchema,
  })
  .refine(pairedDeviceTarget, "Device ID and driver generation must travel together");
export const RunnerIntegrationsDisplayStateSchema = z
  .strictObject({
    ...integrationsFrameBase,
    ...routedDeviceFields,
    type: z.literal("runner.integrations.display.state"),
    display: z.literal("main"),
    streamId: DisplayStreamIdSchema,
    state: DisplayStreamStateSchema,
    reason: DisplayStreamReasonSchema.optional(),
    generation: DisplayViewerStateSchema.shape.generation,
    width: DisplayViewerStateSchema.shape.width,
    height: DisplayViewerStateSchema.shape.height,
    rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  })
  .refine(pairedDeviceTarget, "Device ID and driver generation must travel together");
export type RunnerIntegrationsDisplayState = z.infer<typeof RunnerIntegrationsDisplayStateSchema>;
/** Editing replies name the stream's person lane and the picture fence of their input. */
const displayEditingReplyBase = {
  ...integrationsFrameBase,
  ...displayInputAddress,
  streamId: DisplayStreamIdSchema,
  geometry: DisplayInputSchema.shape.geometry,
};
export const RunnerIntegrationsDisplayInputResultSchema = z
  .strictObject({
    ...DisplayInputResultSchema.omit({ type: true }).shape,
    ...displayEditingReplyBase,
    ...routedDeviceFields,
    type: z.literal("runner.integrations.display.input-result"),
  })
  .refine(oneDisplayInputAddress, "Exactly one input address is required")
  .refine(pairedDeviceTarget, "Device ID and driver generation must travel together");
export const RunnerIntegrationsDisplayEditingSchema = z
  .strictObject({
    ...DisplayEditingSchema.omit({ type: true, generation: true }).shape,
    ...displayEditingReplyBase,
    ...routedDeviceFields,
    type: z.literal("runner.integrations.display.editing"),
  })
  .refine(oneDisplayInputAddress, "Exactly one input address is required")
  .refine(pairedDeviceTarget, "Device ID and driver generation must travel together");
export const RunnerIntegrationsDisplayClipboardSchema = z
  .strictObject({
    ...DisplayClipboardSchema.omit({ type: true }).shape,
    ...displayEditingReplyBase,
    ...routedDeviceFields,
    type: z.literal("runner.integrations.display.clipboard"),
  })
  .refine(oneDisplayInputAddress, "Exactly one input address is required")
  .refine(pairedDeviceTarget, "Device ID and driver generation must travel together");

export const HostIntegrationsDisplayDemandSchema = z
  .strictObject({
    ...integrationsFrameBase,
    ...routedDeviceFields,
    type: z.literal("host.integrations.display.demand"),
    display: z.literal("main"),
    streamId: DisplayStreamIdSchema,
    revision: DisplaySequenceSchema,
    sources: DisplayDemandSchema,
    inputSources: DisplayDemandSchema.optional(),
    maxBitrate: z.number().int().min(150_000).max(20_000_000).nullable().optional(),
    warm: MacDisplayWarmSchema.optional(),
    maxLongSide: DisplayMaxLongSideSchema.optional(),
  })
  .refine(inputSourcesSubset, "Input sources must belong to demand")
  .refine(pairedDeviceTarget, "Device ID and driver generation must travel together");
export const RunnerIntegrationsDisplaySourceEndedSchema = z
  .strictObject({
    ...integrationsFrameBase,
    ...routedDeviceFields,
    type: z.literal("runner.integrations.display.source-ended"),
    display: z.literal("main"),
    streamId: DisplayStreamIdSchema,
    source: DisplaySourceSchema,
    reason: z.enum(["session-ended", "owner-ended", "owner-expired", "owner-revoked"]),
  })
  .refine(pairedDeviceTarget, "Device ID and driver generation must travel together");

export const HostIntegrationsWindowResolveSchema = z.strictObject({
  ...integrationsFrameBase,
  type: z.literal("host.integrations.window-resolve"),
  target: ComputerUseWindowResolveParamsSchema,
  requestId: RunnerAuxiliaryRequestIdSchema,
  timeoutMs: z.number().int().min(1).max(30000),
});
export type HostIntegrationsWindowResolve = z.infer<typeof HostIntegrationsWindowResolveSchema>;
export const RunnerIntegrationsWindowResolvedSchema = z.strictObject({
  ...integrationsFrameBase,
  type: z.literal("runner.integrations.window-resolved"),
  requestId: RunnerAuxiliaryRequestIdSchema,
  result: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("ok"), value: ComputerUseWindowResolveResultSchema }),
    z.strictObject({
      kind: z.literal("error"),
      code: ComputerUseErrorCodeSchema,
      message: z.string().min(1).max(1000),
    }),
  ]),
});
export type RunnerIntegrationsWindowResolved = z.infer<
  typeof RunnerIntegrationsWindowResolvedSchema
>;
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
    HostIntegrationsDisplayPowerSchema,
    HostIntegrationsDeviceDriversSchema,
    HostIntegrationsInvokeSchema,
    HostIntegrationsComputerUseSchema,
    HostIntegrationsComputerAppWindowsSchema,
    HostIntegrationsWindowResolveSchema,
    HostIntegrationsComputerViewSchema,
    HostIntegrationsComputerUseStopRecordedSchema,
    HostIntegrationsCancelSchema,
    HostIntegrationsMcpOpenSchema,
    HostIntegrationsMcpMessageSchema,
    HostIntegrationsMcpCloseSchema,
    HostIntegrationsPluginDataRemoveSchema,
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
    RunnerIntegrationsDisplayPowerResultSchema,
    RunnerIntegrationsDisplayEditingSchema,
    RunnerIntegrationsDisplayClipboardSchema,
    RunnerIntegrationsDeviceStatusSchema,
    RunnerIntegrationsStatusSchema,
    RunnerIntegrationsComputerAppWindowsResultSchema,
    RunnerIntegrationsWindowResolvedSchema,
    RunnerIntegrationsComputerViewResultSchema,
    RunnerIntegrationsResultSchema,
    RunnerIntegrationsComputerUseResultSchema,
    RunnerIntegrationsComputerUseEventSchema,
    RunnerIntegrationsMcpOpenedSchema,
    RunnerIntegrationsMcpMessageSchema,
    RunnerIntegrationsMcpClosedSchema,
    RunnerIntegrationsPluginDataRemovedSchema,
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

export type HostIntegrationsDisplayDemand = z.infer<typeof HostIntegrationsDisplayDemandSchema>;
export type HostIntegrationsDisplayPower = z.infer<typeof HostIntegrationsDisplayPowerSchema>;
export type RunnerIntegrationsDisplayPowerResult = z.infer<
  typeof RunnerIntegrationsDisplayPowerResultSchema
>;
export type RunnerIntegrationsDisplayInputResult = z.infer<
  typeof RunnerIntegrationsDisplayInputResultSchema
>;
export type RunnerIntegrationsDisplayEditing = z.infer<
  typeof RunnerIntegrationsDisplayEditingSchema
>;
export type RunnerIntegrationsDisplayClipboard = z.infer<
  typeof RunnerIntegrationsDisplayClipboardSchema
>;
export type RunnerIntegrationsDisplaySourceEnded = z.infer<
  typeof RunnerIntegrationsDisplaySourceEndedSchema
>;
