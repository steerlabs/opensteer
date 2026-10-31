import { z } from "zod";
import {
  BrowserCdpCommandSchema,
  BrowserProfileAccessSchema,
  BrowserSessionIdSchema,
  BrowserSurfaceIdSchema,
} from "@opensteer/protocol/browser";
import {
  RunnerAuxiliaryFrameFenceSchema,
  RunnerAuxiliaryWelcomeSchema,
  PasswordSignInRequesterSchema,
  PasswordSignInCodeSchema,
  PasswordSignInCancelReasonSchema,
} from "@opensteer/protocol";
import {
  BrowserCapabilityReferenceSchema,
  BrowserChannelIdSchema,
  HostToBrowserRelayMessageSchema,
} from "@opensteer/protocol/browser-relay";
import {
  BrowserProfileIdSchema,
  BrowserSiteSchema,
  IsoDateTimeSchema,
  WorkspaceIdSchema,
} from "@opensteer/core";
import { BrowserCookieSchema } from "@opensteer/browser-profile/snapshot";
import { maxBrowserSourceCookies } from "@opensteer/browser-profile/source-state";

// Relay schemas frozen from bfecdc8ee587ee9b901ee53b0e6ac08e20e59c87; current variants would hide version skew.
// Identity uses the mandatory proof-v2 baseline; pre-v2 Runners are deliberately refused.
const browserBase = {} as const;
const browserRequestBase = { ...browserBase, requestId: z.uuid() } as const;
const BrowserViewportDimensionSchema = z.number().finite().positive().max(16_384);
const browserFrameLimits = { maxHeight: 4_320, maxWidth: 7_680 };
function browserViewportFits(width: number, height: number): boolean {
  return width * height <= 16_777_216;
}

export const ReleasedBrowserAttachTicketClaimsSchema = z.strictObject({
  access: BrowserProfileAccessSchema,
  audience: z.literal("opensteer-browser-runtime"),
  expiresAt: IsoDateTimeSchema,
  identity: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("fresh") }),
    z.strictObject({
      kind: z.literal("profile"),
      profileId: BrowserProfileIdSchema,
      profileLeaseToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      profileStateUrl: z.url().max(8_192),
    }),
  ]),
  issuedAt: IsoDateTimeSchema,
  nonce: z.string().min(16).max(255),
  runtimeId: z.string().min(1).max(255),
  sessionId: BrowserSessionIdSchema,
  subject: z.string().min(1).max(255),
});

export const ReleasedBrowserClientMessageSchema = z
  .discriminatedUnion("type", [
    z.strictObject({ ...browserBase, type: z.literal("stream.subscribe") }),
    z.strictObject({ ...browserBase, type: z.literal("stream.unsubscribe") }),
    /** Watch-only credit for the exact frame delivered on this subscription. */
    z.strictObject({ ...browserBase, type: z.literal("stream.ack"), token: z.uuid() }),
    z.strictObject({
      ...browserBase,
      height: z.number().int().positive().max(browserFrameLimits.maxHeight),
      type: z.literal("viewport.set"),
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
    z.strictObject({
      ...browserBase,
      type: z.literal("surface.open"),
      url: z.url().optional(),
    }),
    z.strictObject({ ...browserBase, type: z.literal("navigation.go"), url: z.url() }),
    z.strictObject({ ...browserBase, type: z.literal("navigation.back") }),
    z.strictObject({ ...browserBase, type: z.literal("navigation.forward") }),
    z.strictObject({ ...browserBase, type: z.literal("navigation.reload") }),
    z.strictObject({
      ...browserBase,
      type: z.literal("input.pointer"),
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
      type: z.literal("input.key"),
      action: z.enum(["down", "up"]),
      code: z.string().max(100),
      key: z.string().max(100),
      modifiers: z.array(z.enum(["alt", "control", "meta", "shift"])).max(4),
      surfaceId: BrowserSurfaceIdSchema,
      text: z.string().max(10_000).optional(),
    }),
    z.strictObject({
      ...browserBase,
      type: z.literal("dialog.respond"),
      accept: z.boolean(),
      promptText: z.string().max(10_000).optional(),
    }),
    z.strictObject({
      ...browserBase,
      type: z.literal("clipboard.paste"),
      surfaceId: BrowserSurfaceIdSchema,
      text: z.string().max(1_000_000),
    }),
    z.strictObject({
      ...browserRequestBase,
      command: BrowserCdpCommandSchema,
      type: z.literal("cdp.command"),
    }),
    /**
     * Requires `full-control` access. Returns the live context state through the
     * same exporter the durable profile checkpoint uses; failures arrive as
     * `browser.error`.
     */
    z.strictObject({ ...browserBase, type: z.literal("state.export") }),
    // The released Passwords wire predates explicit page targeting.
    z.strictObject({
      ...browserBase,
      type: z.literal("signin.probe"),
      probeId: z.uuid(),
      site: BrowserSiteSchema,
    }),
    z.strictObject({
      ...browserBase,
      type: z.literal("signin.start"),
      expiresAt: z.iso.datetime({ offset: true }),
      operationId: z.uuid(),
      requester: PasswordSignInRequesterSchema,
      site: BrowserSiteSchema,
      workspaceId: WorkspaceIdSchema,
    }),
    z.strictObject({
      ...browserBase,
      type: z.literal("signin.code"),
      operationId: z.uuid(),
      code: PasswordSignInCodeSchema,
    }),
    z.strictObject({
      ...browserBase,
      type: z.literal("signin.cancel"),
      operationId: z.uuid(),
      reason: PasswordSignInCancelReasonSchema,
    }),

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
  ])
  .superRefine((message, context) => {
    if (message.type === "viewport.set" && !browserViewportFits(message.width, message.height)) {
      context.addIssue({
        code: "custom",
        message: "The browser viewport exceeds the browser frame resource limit.",
      });
    }
  });
export type ReleasedBrowserClientMessage = z.infer<typeof ReleasedBrowserClientMessageSchema>;

export const ReleasedHostToBrowserRelayMessageSchema = z.union([
  z.strictObject({
    ...RunnerAuxiliaryFrameFenceSchema.shape,
    capability: BrowserCapabilityReferenceSchema,
    channelId: BrowserChannelIdSchema,
    message: ReleasedBrowserClientMessageSchema,
    type: z.literal("browser.client-message"),
  }),
  RunnerAuxiliaryWelcomeSchema.omit({ localProfiles: true, initialNavigationVersion: true }),
  z.union(
    HostToBrowserRelayMessageSchema.options.filter(
      (variant) =>
        !["browser.client-message", "browser.profile.delete", "host.auxiliary.welcome"].includes(
          variant.shape.type.value,
        ),
    ),
  ),
]);
