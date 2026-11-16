import { z } from "zod";

export const iphoneBridgeProtocolVersion = 1;
export const iphoneBridgeBounds = {
  requestBytes: 256 * 1024,
  responseBytes: 2 * 1024 * 1024,
  eventBytes: 64 * 1024,
  pendingRequests: 64,
  roster: 64,
  boundPhones: 8,
  timeoutMs: 120_000,
} as const;

export const iphoneNativeReasonSchema = z.enum([
  "native-service-failed",
  "cancelled",
  "deadline-exceeded",
  "candidate-gone",
  "identity-mismatch",
  "usbmux-unavailable",
  "trust-required",
  "trust-pending",
  "trust-denied",
  "phone-locked",
  "pairing-revoked",
  "pairing-failed",
  "developer-mode-required",
  "developer-mode-status-unknown",
  "developer-image-missing",
  "developer-image-incompatible",
  "developer-image-mount-failed",
  "personalization-network-unavailable",
  "personalization-rejected",
  "tunnel-failed",
  "native-service-missing",
  "protocol-unsupported",
  "unsupported-ios",
  "qualification-required",
  "phone-in-use",
  "input-media-session-required",
  "input-media-conflict",
  "phone-disconnected",
  "owned-by-another-deployment",
  "stale-native-epoch",
  "no-session",
  "not-initialized",
  "unsupported",
  // N2 native screen reasons.
  "stale-observation",
  "outcome-unknown",
  "display-configuration-unsupported",
  "geometry-unavailable",
  "accessibility-unavailable",
  "unsupported-text",
  "unsupported-clear",
  "lock-state-unknown",
  "wake-on-phone-required",
  "app-not-launchable",
  "native-limit-exceeded",
  // Same-LAN transport availability.
  "wifi-not-enabled",
  "local-network-permission-required",
  "wifi-phone-not-found",
  "wifi-pairing-required",
  "wifi-transport-unsupported",
  "wifi-identity-mismatch",
]);
export type IphoneNativeReason = z.infer<typeof iphoneNativeReasonSchema>;
const id = z.string().min(1).max(128);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = integer.min(1);
const empty = z.object({}).strict();
export const iphoneNativePhoneRefSchema = z
  .object({ localPhoneId: id, nativeEpoch: positive })
  .strict();
export const iphoneNativeFailureSchema = z
  .object({
    code: iphoneNativeReasonSchema,
    effect: z.enum(["not-started", "submitted", "unknown"]),
    completedSteps: integer,
  })
  .strict();
// N2 native screen contracts. Network setup contracts are kept separately.
const screenRef = { bindingToken: id, sessionId: id, nativeEpoch: positive };
export const iphoneNativePointSchema = z
  .object({ x: z.number().finite().min(0).max(1440), y: z.number().finite().min(0).max(1440) })
  .strict();
const target = z.union([
  z.object({ point: iphoneNativePointSchema }).strict(),
  z.object({ nodeId: id }).strict(),
]);
export const iphoneNativeActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tap"), target }).strict(),
  z.object({ kind: z.literal("longPress"), target, durationMs: positive.max(10000) }).strict(),
  z
    .object({
      kind: z.literal("swipe"),
      target,
      to: iphoneNativePointSchema,
      durationMs: positive.max(10000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("drag"),
      target,
      to: iphoneNativePointSchema,
      durationMs: positive.max(10000),
      holdMs: integer.max(2000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("type"),
      target: target.optional(),
      text: z
        .string()
        .max(16000)
        .refine((value) => new TextEncoder().encode(value).length <= 16000),
      submit: z.boolean().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("clear"), target: target.optional() }).strict(),
  z
    .object({
      kind: z.literal("navigate"),
      button: z.enum(["home", "lock", "volumeUp", "volumeDown"]),
    })
    .strict(),
  z.object({ kind: z.literal("launch"), appId: id }).strict(),
  z.object({ kind: z.literal("wake") }).strict(),
  z.object({ kind: z.literal("wait"), durationMs: positive.max(10000) }).strict(),
]);
export type IphoneNativeAction = z.infer<typeof iphoneNativeActionSchema>;
const rotation = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).nullable();
export const iphoneNativeDeviceStateSchema = z
  .object({
    lock: z.enum(["locked", "unlocked", "unknown"]),
    display: z.enum(["on", "off", "unknown"]),
    rotation,
    displayId: integer,
  })
  .strict();
export const iphoneNativeGeometrySchema = z
  .object({
    width: positive.max(1440),
    height: positive.max(1440),
    captureWidth: positive.max(16000000),
    captureHeight: positive.max(16000000),
    displayId: integer,
    rotation,
  })
  .strict()
  .refine(
    (value) =>
      value.width * value.height <= 1150000 && value.captureWidth * value.captureHeight <= 32000000,
  );
const nativeNode = z
  .object({
    nodeId: id,
    parent: id.nullable(),
    depth: integer.max(63),
    role: z.enum([
      "application",
      "button",
      "text",
      "textField",
      "switch",
      "link",
      "adjustable",
      "key",
      "searchField",
      "other",
    ]),
    label: z.string().max(400),
    frame: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().finite().positive(),
        height: z.number().finite().positive(),
      })
      .strict()
      .nullable(),
    enabled: z.boolean().nullable(),
    focused: z.boolean().nullable(),
    selected: z.boolean().nullable(),
    editable: z.literal("unknown"),
    secure: z.literal("unknown"),
  })
  .strict();
export const iphoneNativeObservationSchema = z
  .object({
    observationToken: id,
    nativeEpoch: positive,
    geometryRevision: positive,
    geometry: iphoneNativeGeometrySchema,
    state: iphoneNativeDeviceStateSchema,
    nodes: z.array(nativeNode).max(1500),
    coverage: z
      .object({
        coordinateSpace: z.literal("unqualified"),
        status: z.enum(["partial", "unavailable"]),
        reason: z.enum([
          "accessibility-unavailable",
          "quiet-window",
          "capture-deadline",
          "message-limit",
          "byte-limit",
          "transport-ended",
        ]),
        received: integer.max(5000),
        returned: integer.max(1500),
        missingFrames: integer.max(1500),
        missingChildren: integer,
        unreturned: integer.max(5000),
        cycles: integer,
        truncated: z.boolean(),
      })
      .strict(),
    foreground: z
      .object({ appId: id, label: z.string().max(400) })
      .strict()
      .nullable(),
    buttons: z.array(z.enum(["home", "lock", "volumeUp", "volumeDown"])).max(4),
    textReason: z.literal("unsupported-text"),
    clearReason: z.literal("unsupported-clear"),
    screenshot: z
      .object({
        mimeType: z.literal("image/jpeg"),
        base64: z.string().max(600000),
        width: positive.max(1440),
        height: positive.max(1440),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.screenshot &&
      (value.screenshot.width !== value.geometry.width ||
        value.screenshot.height !== value.geometry.height)
    )
      ctx.addIssue({
        code: "custom",
        path: ["screenshot"],
        message: "Screenshot geometry must match delivered image",
      });
    if (new TextEncoder().encode(JSON.stringify(value.nodes)).length > 32000)
      ctx.addIssue({ code: "custom", path: ["nodes"], message: "AX byte limit exceeded" });
  });
export type IphoneNativeObservation = z.infer<typeof iphoneNativeObservationSchema>;
export const iphoneNativePerformResultSchema = z
  .object({
    effect: z.enum(["not-started", "submitted"]),
    completedSteps: integer.max(32),
    observationRequired: z.literal(true),
  })
  .strict();
export const iphoneNativeInstalledAppsSchema = z
  .object({
    apps: z.array(z.object({ appId: id, label: z.string().max(400) }).strict()).max(100),
    total: integer.max(10000),
    offset: integer.max(10000),
  })
  .strict();
const requestBase = {
  kind: z.literal("request"),
  protocolVersion: z.literal(1),
  id: positive,
};
const phoneRef = iphoneNativePhoneRefSchema.shape;
const paramsByMethod = {
  hello: empty,
  init: z
    .object({
      privateRoot: z.string().min(1).max(4096),
      imageRoots: z.array(z.string().min(1).max(4096)).max(8),
    })
    .strict(),
  "roster.get": empty,
  "roster.subscribe": empty,
  "setup.inspect": iphoneNativePhoneRefSchema,
  "setup.pair": iphoneNativePhoneRefSchema,
  "setup.prepareDeveloperServices": z.object({ ...phoneRef, imageHandle: id }).strict(),
  "binding.acquire": z
    .object({
      ...phoneRef,
      deploymentId: id,
      hostInstanceId: id,
      runnerId: id,
      deviceId: id,
      driverGeneration: positive,
    })
    .strict(),
  "binding.release": z.object({ bindingToken: id, forget: z.boolean().optional() }).strict(),
  "session.open": z
    .object({ bindingToken: id, sessionId: id, runId: id, access: z.enum(["observe", "control"]) })
    .strict(),
  "session.close": z.object({ bindingToken: id, sessionId: id }).strict(),
  // N2 screen operations.
  "phone.observe": z.object({ ...screenRef, includeScreenshot: z.boolean() }).strict(),
  "phone.perform": z
    .object({
      ...screenRef,
      observationToken: id,
      geometryRevision: positive,
      actions: z.array(iphoneNativeActionSchema).min(1).max(32),
    })
    .strict(),
  "phone.installedApps": z
    .object({
      bindingToken: id,
      nativeEpoch: positive,
      filter: z.string().max(200).optional(),
      limit: positive.max(100),
      offset: integer.max(10000),
    })
    .strict(),
  "phone.forget": z.object({ ...phoneRef, bindingToken: id }).strict(),
  "request.cancel": z.object({ requestId: positive }).strict(),
  shutdown: empty,
} as const;
const iphoneNativeBaseRequestSchema = z
  .discriminatedUnion("method", [
    z
      .object({
        ...requestBase,
        method: z.literal("phone.observe"),
        timeoutMs: positive.max(30000),
        params: paramsByMethod["phone.observe"],
      })
      .strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("phone.perform"),
        timeoutMs: positive.max(30000),
        params: paramsByMethod["phone.perform"],
      })
      .strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("phone.installedApps"),
        timeoutMs: positive.max(30000),
        params: paramsByMethod["phone.installedApps"],
      })
      .strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("hello"),
        timeoutMs: positive.max(30000),
        params: paramsByMethod["hello"],
      })
      .strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("init"),
        timeoutMs: positive.max(30000),
        params: paramsByMethod["init"],
      })
      .strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("roster.get"),
        timeoutMs: positive.max(30000),
        params: paramsByMethod["roster.get"],
      })
      .strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("roster.subscribe"),
        timeoutMs: positive.max(30000),
        params: paramsByMethod["roster.subscribe"],
      })
      .strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("setup.inspect"),
        timeoutMs: positive.max(30000),
        params: paramsByMethod["setup.inspect"],
      })
      .strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("setup.pair"),
        timeoutMs: positive.max(30000),
        params: paramsByMethod["setup.pair"],
      })
      .strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("setup.prepareDeveloperServices"),
        timeoutMs: positive.max(120000),
        params: paramsByMethod["setup.prepareDeveloperServices"],
      })
      .strict(),
    // Explicit same-LAN setup; no endpoints or pairing material cross this pipe.
    z
      .object({
        ...requestBase,
        method: z.literal("setup.enableWifi"),
        timeoutMs: positive.max(30000),
        params: iphoneNativePhoneRefSchema,
      })
      .strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("setup.disableWifi"),
        timeoutMs: positive.max(30000),
        params: iphoneNativePhoneRefSchema,
      })
      .strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("setup.pairWifi"),
        timeoutMs: positive.max(30000),
        params: iphoneNativePhoneRefSchema,
      })
      .strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("binding.acquire"),
        timeoutMs: positive.max(30000),
        params: paramsByMethod["binding.acquire"],
      })
      .strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("binding.release"),
        timeoutMs: positive.max(30000),
        params: paramsByMethod["binding.release"],
      })
      .strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("session.open"),
        timeoutMs: positive.max(30000),
        params: paramsByMethod["session.open"],
      })
      .strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("session.close"),
        timeoutMs: positive.max(30000),
        params: paramsByMethod["session.close"],
      })
      .strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("phone.forget"),
        timeoutMs: positive.max(30000),
        params: paramsByMethod["phone.forget"],
      })
      .strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("request.cancel"),
        timeoutMs: positive.max(30000),
        params: paramsByMethod["request.cancel"],
      })
      .strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("shutdown"),
        timeoutMs: positive.max(30000),
        params: paramsByMethod["shutdown"],
      })
      .strict(),
  ])
  .superRefine((request, ctx) => {
    if (request.method === "request.cancel" && request.params.requestId >= request.id) {
      ctx.addIssue({
        code: "custom",
        path: ["params", "requestId"],
        message: "Cancellation must name an earlier request",
      });
    }
  });
export const iphoneNativeRequestSchema = z.union([
  iphoneNativeBaseRequestSchema,
  z.strictObject({
    ...requestBase,
    method: z.literal("phone.identity"),
    timeoutMs: positive.max(30000),
    params: z.strictObject({ candidateId: id }),
  }),
  z.strictObject({
    ...requestBase,
    method: z.literal("binding.forget"),
    timeoutMs: positive.max(30000),
    params: z.strictObject({
      udid: id,
      deploymentId: id,
      hostInstanceId: id,
      runnerId: id,
      deviceId: id,
      driverGeneration: positive,
    }),
  }),
]);
export type IphoneNativeRequest = z.infer<typeof iphoneNativeRequestSchema>;
export const iphoneNativeHelloSchema = z
  .object({
    bridge: z.literal("opensteer-iphone-bridge"),
    version: z.literal("0.1.0"),
    protocolVersion: z.literal(1),
    bootId: id,
    bounds: z
      .object({
        requestBytes: z.literal(262144),
        responseBytes: z.literal(2097152),
        eventBytes: z.literal(65536),
        pendingRequests: z.literal(64),
        roster: z.literal(64),
        boundPhones: z.literal(8),
        timeoutMs: z.literal(120000),
      })
      .strict(),
  })
  .strict();
export const iphoneNativeRosterSchema = z
  .object({
    revision: integer,
    candidates: z
      .array(
        z
          .object({
            ...phoneRef,
            name: z.string().max(160),
            model: z.string().max(160),
            osVersion: z.string().max(160),
            build: z.string().max(160),
            transport: z.enum(["usb", "wifi"]),
            reason: iphoneNativeReasonSchema,
          })
          .strict(),
      )
      .max(64),
  })
  .strict();
export const iphoneNativeInspectionSchema = z
  .object({
    pairing: z.enum(["unknown", "paired"]),
    developerMode: z.enum(["unknown", "enabled", "disabled"]),
    name: z.string().max(160),
    model: z.string().max(160),
    osVersion: z.string().max(160),
    build: z.string().max(160),
    image: z.enum(["unknown", "mounted"]),
    tunnel: z.enum(["unknown", "ready"]),
    lock: z.literal("unknown"),
    reason: iphoneNativeReasonSchema,
  })
  .strict();
export const iphoneNativeResponseSchema = z
  .object({
    kind: z.literal("response"),
    id: positive,
    result: z.union([
      z.object({ error: iphoneNativeFailureSchema }).strict(),
      z.strictObject({ udid: id }),
      iphoneNativeHelloSchema,
      iphoneNativeRosterSchema,
      iphoneNativeInspectionSchema,
      // N2 screen results.
      iphoneNativeObservationSchema,
      iphoneNativePerformResultSchema,
      iphoneNativeInstalledAppsSchema,
      iphoneNativePhoneRefSchema,
      z.object({ bindingToken: id }).strict(),
      z
        .object({
          images: z.array(z.object({ handle: id, build: z.string().max(160) }).strict()).max(8),
        })
        .strict(),
      empty,
    ]),
  })
  .strict();
export const iphoneNativeEventSchema = z
  .object({
    kind: z.literal("event"),
    bootId: id,
    sequence: positive,
    event: z.literal("roster.changed"),
    roster: iphoneNativeRosterSchema,
  })
  .strict();
export const iphoneNativeMessageSchema = z.union([
  iphoneNativeResponseSchema,
  iphoneNativeEventSchema,
]);
export type IphoneNativeMessage = z.infer<typeof iphoneNativeMessageSchema>;

export type IphoneNativeGeometry = z.infer<typeof iphoneNativeGeometrySchema>;
export type IphoneNativeDeviceState = z.infer<typeof iphoneNativeDeviceStateSchema>;
export type IphoneNativePerformResult = z.infer<typeof iphoneNativePerformResultSchema>;
export type IphoneNativeInstalledApps = z.infer<typeof iphoneNativeInstalledAppsSchema>;

// Main-only identity seam. Never included in a renderer or Runner schema.
export const iphonePrivateIdentityParamsSchema = z.strictObject({ candidateId: id });
export const iphonePrivateIdentityResultSchema = z.strictObject({ udid: id });
export const iphonePrivateForgetBindingParamsSchema = z.strictObject({
  udid: id,
  deploymentId: id,
  hostInstanceId: id,
  runnerId: id,
  deviceId: id,
  driverGeneration: positive,
});

// Desktop main ↔ Mac Runner, negotiated on the existing computer-use socket.
export const iphoneRunnerBridgeHeader = "x-opensteer-iphone-screen";
export const iphoneRunnerMethodSchema = z.enum([
  "iphone.targets",
  "iphone.session.open",
  "iphone.observe",
  "iphone.perform",
  "iphone.session.close",
  "iphone.installedApps",
  "iphone.cancel",
  "iphone.media",
]);
export type IphoneRunnerMethod = z.infer<typeof iphoneRunnerMethodSchema>;
const driverRef = { deviceId: id, driverGeneration: positive };
const sessionRef = { ...driverRef, sessionId: id, runId: id };
export const iphoneRunnerAssignmentSchema = z.strictObject({
  deviceId: id,
  generation: positive,
  role: z.literal("screen"),
  definitionId: z.literal("iphone-screen"),
});
export const iphoneRunnerOwnerSchema = z.strictObject({
  deploymentId: id,
  hostInstanceId: id,
  runnerId: id,
});
export type IphoneRunnerOwner = z.infer<typeof iphoneRunnerOwnerSchema>;
export const iphoneRunnerTargetSchema = z.strictObject({
  ...driverRef,
  nativeEpoch: integer,
  ready: z.boolean(),
  reason: iphoneNativeReasonSchema.nullable(),
});
export const iphoneScreenNativeActionSchema = iphoneNativeActionSchema;
export const iphoneScreenNativeObservationSchema = iphoneNativeObservationSchema;
export const iphoneScreenNativeReceiptSchema = iphoneNativePerformResultSchema;
export const iphoneScreenNativeInstalledAppsSchema = iphoneNativeInstalledAppsSchema;
export const iphoneRunnerParams = {
  "iphone.targets": iphoneRunnerOwnerSchema.extend({
    assignments: z.array(iphoneRunnerAssignmentSchema).max(256),
  }),
  "iphone.session.open": z.strictObject({ ...sessionRef, access: z.enum(["observe", "control"]) }),
  "iphone.observe": z.strictObject({ ...sessionRef, includeScreenshot: z.boolean() }),
  "iphone.perform": z.strictObject({
    ...sessionRef,
    nativeEpoch: positive,
    geometryRevision: positive,
    observationToken: id,
    actions: z.array(iphoneScreenNativeActionSchema).min(1).max(32),
  }),
  "iphone.session.close": z.strictObject(sessionRef),
  "iphone.installedApps": z.strictObject({
    ...driverRef,
    filter: z.string().max(200).optional(),
    limit: positive.max(100),
    offset: integer.max(10000),
  }),
  "iphone.cancel": z.strictObject(sessionRef),
  "iphone.media": z.strictObject(driverRef),
} as const;
export const iphoneRunnerResults = {
  "iphone.targets": z.strictObject({ targets: z.array(iphoneRunnerTargetSchema).max(8) }),
  "iphone.session.open": z.strictObject({ nativeEpoch: positive }),
  "iphone.observe": iphoneScreenNativeObservationSchema,
  "iphone.perform": z.union([
    iphoneScreenNativeReceiptSchema,
    z.strictObject({ error: iphoneNativeFailureSchema }),
  ]),
  "iphone.session.close": empty,
  "iphone.installedApps": iphoneScreenNativeInstalledAppsSchema,
  "iphone.cancel": empty,
  "iphone.media": z.strictObject({ available: z.literal(false), reason: z.literal("unsupported") }),
} as const;
export type IphoneRunnerParams<M extends IphoneRunnerMethod> = z.infer<
  (typeof iphoneRunnerParams)[M]
>;
export type IphoneRunnerResult<M extends IphoneRunnerMethod> = z.infer<
  (typeof iphoneRunnerResults)[M]
>;
export const iphoneRunnerEventSchema = z.discriminatedUnion("event", [
  z.strictObject({
    kind: z.literal("event"),
    event: z.literal("iphone.targetsChanged"),
    params: iphoneRunnerTargetSchema,
  }),
  z.strictObject({
    kind: z.literal("event"),
    event: z.literal("iphone.sessionEnded"),
    params: z.strictObject({
      ...sessionRef,
      nativeEpoch: integer,
      reason: iphoneNativeReasonSchema,
    }),
  }),
]);
export type IphoneRunnerEvent = z.infer<typeof iphoneRunnerEventSchema>;
export interface IphoneRunnerConnection {
  request<M extends IphoneRunnerMethod>(
    method: M,
    params: IphoneRunnerParams<M>,
    options: { deadline: number; signal?: AbortSignal },
  ): Promise<IphoneRunnerResult<M>>;
  close(): void;
}
export interface IphoneRunnerPort {
  connect(emit: (event: IphoneRunnerEvent) => void): IphoneRunnerConnection;
}
