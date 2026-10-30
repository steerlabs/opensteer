import { z } from "zod";
import { EnvironmentIdSchema, HarnessInstanceIdSchema } from "@opensteer/core";

/**
 * Voice: the person's client holds a realtime call whose audio goes straight
 * to the voice vendor. Nothing here is durable. A Runner creates the call
 * with an account it holds, so the vendor credential never leaves that
 * computer; these shapes only carry the call's setup and its spoken text.
 */

/** Client-chosen, so a client can stop a call whose start answer it lost. */
export const VoiceSessionIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
export type VoiceSessionId = z.infer<typeof VoiceSessionIdSchema>;

/** A WebRTC session description. Never logged: it carries local addresses. */
export const VoiceSdpSchema = z.string().min(1).max(64_000);

/** What the voice is asked to say; long replies are shortened before this. */
export const voiceSayMaxLength = 4_000;
export const VoiceSayTextSchema = z.string().trim().min(1).max(voiceSayMaxLength);

/** A call ends unless its client renews it within this long. */
export const voiceLeaseMs = 60_000;
export const voiceRenewIntervalMs = 20_000;
/** No call lives longer than this, whatever its client does. */
export const voiceMaxCallMs = 2 * 60 * 60_000;

const voiceCall = {
  environmentId: EnvironmentIdSchema,
  sessionId: VoiceSessionIdSchema,
};

export const VoiceStartInputSchema = z.strictObject({
  ...voiceCall,
  harnessInstanceId: HarnessInstanceIdSchema,
  offer: VoiceSdpSchema,
});
export const VoiceStartResultSchema = z.object({ answer: VoiceSdpSchema });
export const VoiceRenewInputSchema = z.strictObject(voiceCall);
export const VoiceSayInputSchema = z.strictObject({ ...voiceCall, text: VoiceSayTextSchema });
export const VoiceStopInputSchema = z.strictObject(voiceCall);
export const VoiceEmptyResultSchema = z.object({});

export type VoiceStartInput = z.infer<typeof VoiceStartInputSchema>;
export type VoiceStartResult = z.infer<typeof VoiceStartResultSchema>;
export type VoiceRenewInput = z.infer<typeof VoiceRenewInputSchema>;
export type VoiceSayInput = z.infer<typeof VoiceSayInputSchema>;
export type VoiceStopInput = z.infer<typeof VoiceStopInputSchema>;

/**
 * Why a voice call could not start or continue, carried as the error's
 * `reason` so a client says which side to fix without matching prose.
 */
export const VoiceRefusalReasonSchema = z.enum([
  /** The computer's Opensteer predates voice. */
  "voice-runner-unsupported",
  /** The account's Codex lacks the realtime voice this release drives. */
  "voice-engine-unsupported",
  /** Not this person's usable, signed-in ChatGPT account on that computer. */
  "voice-account-unavailable",
  /** The vendor refused the call, e.g. the plan has no voice. */
  "voice-refused",
  /** The call is over: stopped, expired, replaced by a newer call, or failed. */
  "voice-ended",
]);
export type VoiceRefusalReason = z.infer<typeof VoiceRefusalReasonSchema>;
