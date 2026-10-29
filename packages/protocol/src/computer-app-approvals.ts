import {
  ComputerAppApprovalSchema,
  ComputerAppSetupRequestSchema,
} from "@opensteer/integration-core";
import { IsoDateTimeSchema, RunnerIdSchema } from "@opensteer/core";
import { z } from "zod";

/**
 * The approvals a Mac is asked about, as they travel on that Mac's own Runner
 * stream: the Host to the Runner, the Runner to desktop main over the bridge,
 * and the person's answer back the same way.
 *
 * They ride the Runner's authenticated stream rather than the person's session
 * because the Mac must be asked however the person signed in — a Personal
 * loopback session, a cloud session that lapsed overnight, or none at all — and
 * the stream is the one connection that exists exactly while the Mac can be
 * asked. The answer is still the person's: it is signed by the desktop's own
 * approval key, which nothing else on the Mac can read (`docs/computer-use.md`
 * §4, "Approval authority").
 */

/** How many approvals one list names; one Mac rarely has more than a few waiting. */
export const computerAppMaxPendingApprovals = 64;

/** The Host's fingerprint of a registered approval key (`sha256:<base64url>`). */
export const ComputerAppApprovalKeyIdSchema = z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/u);
export type ComputerAppApprovalKeyId = z.infer<typeof ComputerAppApprovalKeyIdSchema>;

/**
 * One waiting approval with everything its panel shows. `request` is the
 * Host's row verbatim, including the Workspace name snapshot the panel shows
 * and the desktop signs. A Runner cannot relabel it for the person.
 */
export const ComputerAppApprovalPromptSchema = z.strictObject({
  request: ComputerAppSetupRequestSchema,
});
export type ComputerAppApprovalPrompt = z.infer<typeof ComputerAppApprovalPromptSchema>;

/**
 * Every approval waiting on one Mac, complete.
 *
 * It is always the whole set, never a delta: an approval that is not in the
 * latest list has ended — declined elsewhere, cancelled, expired, replaced
 * under a new id, or taken back with the app — and the Mac closes its panel.
 * A lost list is repaired by the next one rather than leaving a panel open.
 * `approvalKeyId` is the key the Host will accept this Mac's answers with, or
 * null when none is registered; a desktop holding another key shows nothing.
 */
export const ComputerAppApprovalListSchema = z.strictObject({
  approvalKeyId: ComputerAppApprovalKeyIdSchema.nullable(),
  approvals: z.array(ComputerAppApprovalPromptSchema).max(computerAppMaxPendingApprovals),
});
export type ComputerAppApprovalList = z.infer<typeof ComputerAppApprovalListSchema>;

/** The person's answer on the Mac: a signature over the request, or no. */
export const ComputerAppApprovalAnswerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ approval: ComputerAppApprovalSchema, kind: z.literal("allow") }),
  z.strictObject({ approval: ComputerAppApprovalSchema, kind: z.literal("deny") }),
]);
export type ComputerAppApprovalAnswer = z.infer<typeof ComputerAppApprovalAnswerSchema>;

/**
 * One answer. It is refined by `approvalAnswerNamesItsRequest` wherever it is
 * parsed on its own, and every frame that spreads this shape refines again.
 */
export const ComputerAppApprovalAnswerFrameSchema = z.strictObject({
  answer: ComputerAppApprovalAnswerSchema,
  setupRequestId: z.uuid(),
});
export type ComputerAppApprovalAnswerFrame = z.infer<typeof ComputerAppApprovalAnswerFrameSchema>;

/** A signature over one request can only ever answer that request. */
export function approvalAnswerNamesItsRequest(frame: ComputerAppApprovalAnswerFrame): boolean {
  return frame.answer.approval.requestId === frame.setupRequestId;
}

/**
 * What the Host did with one answer. `refused` means the approval is still
 * waiting and nothing changed — the signature did not verify, no approval key
 * is registered, or the request moved on — and says why in a sentence.
 */
export const ComputerAppApprovalOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("allowed") }),
  z.strictObject({ kind: z.literal("declined") }),
  z.strictObject({ kind: z.literal("refused"), message: z.string().min(1).max(1_000) }),
]);
export type ComputerAppApprovalOutcome = z.infer<typeof ComputerAppApprovalOutcomeSchema>;

export const ComputerAppApprovalOutcomeFrameSchema = z.strictObject({
  outcome: ComputerAppApprovalOutcomeSchema,
  setupRequestId: z.uuid(),
});
export type ComputerAppApprovalOutcomeFrame = z.infer<typeof ComputerAppApprovalOutcomeFrameSchema>;

/** A fresh, single-use Host challenge for enrolling or rotating the desktop's key. */
export const ComputerAppApprovalKeyChallengeSchema = z.strictObject({
  challengeId: z.uuid(),
  expiresAt: IsoDateTimeSchema,
  keyId: ComputerAppApprovalKeyIdSchema,
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  runnerId: RunnerIdSchema,
});
export type ComputerAppApprovalKeyChallenge = z.infer<typeof ComputerAppApprovalKeyChallengeSchema>;

export const ComputerAppApprovalKeyProofSchema = z.strictObject({
  challengeId: z.uuid(),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/u),
});
export type ComputerAppApprovalKeyProof = z.infer<typeof ComputerAppApprovalKeyProofSchema>;
