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
  "binding.release": z.object({ bindingToken: id }).strict(),
  "session.open": z
    .object({ bindingToken: id, sessionId: id, runId: id, access: z.enum(["observe", "control"]) })
    .strict(),
  "session.close": z.object({ bindingToken: id, sessionId: id }).strict(),
  "phone.forget": z.object({ ...phoneRef, bindingToken: id }).strict(),
  "request.cancel": z.object({ requestId: positive }).strict(),
  shutdown: empty,
} as const;
export const iphoneNativeRequestSchema = z
  .discriminatedUnion("method", [
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
      iphoneNativeHelloSchema,
      iphoneNativeRosterSchema,
      iphoneNativeInspectionSchema,
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
