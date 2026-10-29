import { z } from "zod";

const PresentationUnavailableReasonSchema = z.enum([
  "not-local",
  "not-admitted",
  "renderer-gone",
  "page-unavailable",
]);

export const BrowserPresentationResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), value: z.unknown().optional() }),
  z.strictObject({
    ok: z.literal(false),
    reason: PresentationUnavailableReasonSchema,
  }),
]);

export type PresentationUnavailableReason = z.infer<typeof PresentationUnavailableReasonSchema>;
export class BrowserPresentationUnavailable extends Error {
  readonly reason: PresentationUnavailableReason;
  constructor(reason: PresentationUnavailableReason) {
    super(`Native browser presentation unavailable: ${reason}`);
    this.reason = reason;
  }
}
