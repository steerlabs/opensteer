/**
 * Frozen while wire-4 extensions are supported (docs/browser-sessions.md#chrome-sign-ins):
 * exactly what a wire-4 peer strictly accepts. The Host checks every frame it
 * sends a wire-4 peer against these; never change a shape or a bound here.
 */
import { z } from "zod";
import { BrowserSourceIdSchema } from "../frozen/primitives.js";
import {
  BrowserSiteSchema,
  BrowserSourceSnapshotSchema,
  maxBrowserSourceSnapshotBytes,
} from "../site.js";
import { BrowserSourceChallengeSchema, BrowserSourceDestinationSchema } from "./challenge.js";

export const maxBrowserSourceFrameBytes = maxBrowserSourceSnapshotBytes + 64 * 1_024;
export const BrowserSourceNameSchema = z.string().trim().min(1).max(120);

/**
 * What a connected Chrome reports about one site.
 * - `no-state`: this Chrome profile has no sign-in cookies for the site.
 * - `stopped`: the person chose Stop sharing for this site in the extension.
 * - `chrome-blocked`: Chrome's site access for the extension excludes the site.
 * - `limit`: the extension's daily budget of newly shared sites is spent.
 */
export const BrowserSourceStatusSchema = z.enum([
  "available",
  "no-state",
  "stopped",
  "chrome-blocked",
  "limit",
  "unsupported",
  "too-large",
]);
export type BrowserSourceStatus = z.infer<typeof BrowserSourceStatusSchema>;
export type BrowserSourceExportProblem = Exclude<BrowserSourceStatus, "available">;
export const BrowserSourceExportProblemSchema = BrowserSourceStatusSchema.exclude(["available"]);

export const BrowserSourcePairInputSchema = BrowserSourceDestinationSchema.extend({
  code: z.string().min(32).max(128),
  name: BrowserSourceNameSchema,
  /**
   * Reconnecting the same Chrome profile retires its previous connection
   * atomically, so grants that preferred it follow the new one.
   */
  replaces: z
    .strictObject({ sourceId: BrowserSourceIdSchema, token: z.string().min(32).max(256) })
    .nullable(),
  version: z.number().int().positive(),
});
/** `POST /internal/v1/browser-sources/pair/challenge`, answered before any secret is sent. */
export const BrowserSourcePairChallengeResultSchema = z.strictObject({
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/u),
});
export const BrowserSourcePairResultSchema = z.object({
  sourceId: BrowserSourceIdSchema,
  token: z.string().min(32).max(256),
});

const operationFields = { operationId: z.uuid(), site: BrowserSiteSchema };
export const BrowserSourceHostMessageV4Schema = z.discriminatedUnion("type", [
  z.discriminatedUnion("code", [
    z.strictObject({
      type: z.literal("source.error"),
      code: z.literal("unsupported-version"),
      supportedVersion: z.number().int().positive(),
    }),
    z.strictObject({
      type: z.literal("source.error"),
      code: z.literal("route-changed"),
      /**
       * Present when sent before the connection proof: a Host signature over
       * the source's challenge (`browserSourceRouteChangedBytes`). The
       * extension ignores an unsigned pre-proof notice.
       */
      signature: z
        .string()
        .regex(/^[A-Za-z0-9_-]{86}$/u)
        .optional(),
    }),
    z.strictObject({
      type: z.literal("source.error"),
      code: z.literal("source-unauthorized"),
    }),
  ]),
  z.strictObject({
    nonce: z.uuid(),
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/u),
    type: z.literal("source.proof"),
  }),
  z.strictObject({ type: z.literal("source.ready"), sourceId: BrowserSourceIdSchema }),
  z.strictObject({ ...operationFields, type: z.literal("source.inspect") }),
  z.strictObject({ ...operationFields, type: z.literal("source.export") }),
  z.strictObject({ nonce: z.uuid(), type: z.literal("ping") }),
]);
export type BrowserSourceHostMessageV4 = z.infer<typeof BrowserSourceHostMessageV4Schema>;
export const BrowserSourceClientMessageV4Schema = z.discriminatedUnion("type", [
  BrowserSourceChallengeSchema.extend({
    type: z.literal("source.challenge"),
  }),
  z.strictObject({
    sourceId: BrowserSourceIdSchema,
    token: z.string().min(32).max(256),
    type: z.literal("source.hello"),
    version: z.number().int().positive(),
  }),
  z.strictObject({
    operationId: z.uuid(),
    status: BrowserSourceStatusSchema,
    type: z.literal("source.inspect.result"),
  }),
  z.strictObject({
    operationId: z.uuid(),
    result: z.discriminatedUnion("status", [
      z.strictObject({ snapshot: BrowserSourceSnapshotSchema, status: z.literal("exported") }),
      z.strictObject({ status: BrowserSourceExportProblemSchema }),
    ]),
    type: z.literal("source.export.result"),
  }),
  z.strictObject({ nonce: z.uuid(), type: z.literal("pong") }),
  /**
   * The person chose Disconnect in Chrome. The Host revokes this source exactly
   * as the owner's Disconnect in Opensteer does, then closes the socket.
   */
  z.strictObject({ type: z.literal("source.disconnect") }),
]);
export type BrowserSourceClientMessageV4 = z.infer<typeof BrowserSourceClientMessageV4Schema>;
