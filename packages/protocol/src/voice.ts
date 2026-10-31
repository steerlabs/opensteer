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
  harnessInstanceId: HarnessInstanceIdSchema,
  environmentId: EnvironmentIdSchema,
  sessionId: VoiceSessionIdSchema,
};

export const VoiceStartInputSchema = z.strictObject({
  ...voiceCall,
  offer: VoiceSdpSchema,
  /**
   * Asks for the call's own agent, which acts through `voice.next`. Sent only
   * to a Host advertising `voice-agent-v1`; without it the call is legacy and
   * the client sends every finished utterance to Chat itself.
   */
  agent: z.literal(true).optional(),
});
export const VoiceStartResultSchema = z.object({
  answer: VoiceSdpSchema,
  /** True when the call's agent runs; absent or false means a legacy call. */
  agent: z.boolean().optional(),
});
export const VoiceRenewInputSchema = z.strictObject(voiceCall);

/** How long a Runner holds `voice.next` open, inside the Host's relay deadline. */
export const voiceNextHoldMs = 6_000;
/** A tool call the device has not answered by then fails with an unknown outcome. */
export const voiceToolCallTimeoutMs = 15_000;
export const voiceToolCallIdSchema = z.string().min(1).max(128);
export const voiceAnswerMaxLength = 4_000;
export const voiceContextMaxLength = 16_000;

/**
 * Something the call's agent asks this device to do. `tool` stays an open
 * name so an older client can refuse a tool it does not know.
 */
export const VoiceToolCallSchema = z.object({
  id: voiceToolCallIdSchema,
  tool: z.string().min(1).max(64),
  input: z.record(z.string(), z.unknown()),
});
export const VoiceNextInputSchema = z.strictObject(voiceCall);
export const VoiceNextResultSchema = z.object({ call: VoiceToolCallSchema.nullable() });
export const VoiceAnswerInputSchema = z.strictObject({
  ...voiceCall,
  callId: voiceToolCallIdSchema,
  ok: z.boolean(),
  text: z.string().trim().min(1).max(voiceAnswerMaxLength),
});
/** What the person sees and can open now, as the agent reads it. Replaces the last one. */
export const VoiceContextInputSchema = z.strictObject({
  ...voiceCall,
  text: z.string().trim().min(1).max(voiceContextMaxLength),
});
export const VoiceSayInputSchema = z.strictObject({ ...voiceCall, text: VoiceSayTextSchema });
export const VoiceStopInputSchema = z.strictObject(voiceCall);
export const VoiceEmptyResultSchema = z.object({});

export type VoiceStartInput = z.infer<typeof VoiceStartInputSchema>;
export type VoiceStartResult = z.infer<typeof VoiceStartResultSchema>;
export type VoiceRenewInput = z.infer<typeof VoiceRenewInputSchema>;
export type VoiceToolCall = z.infer<typeof VoiceToolCallSchema>;
export type VoiceNextInput = z.infer<typeof VoiceNextInputSchema>;
export type VoiceNextResult = z.infer<typeof VoiceNextResultSchema>;
export type VoiceAnswerInput = z.infer<typeof VoiceAnswerInputSchema>;
export type VoiceContextInput = z.infer<typeof VoiceContextInputSchema>;
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
