import { z } from "zod";
import {
  BrowserSurfaceIdSchema,
  EnvironmentIdSchema,
  HarnessInstanceIdSchema,
  RunIdSchema,
  ThreadAccessModeSchema,
  ThreadIdSchema,
  WorkspaceIdSchema,
} from "@opensteer/core";

/**
 * Voice: the person's client holds a realtime call whose audio goes straight
 * to the voice vendor. Each call is one Run on the person's permanent Voice
 * Thread, executed by the Runner that holds the voice account; that Runner
 * creates the call, so the vendor credential never leaves its computer.
 * Session descriptions travel only on these synchronous calls, never on a
 * durable path.
 */

/** Client-chosen, so a client can stop a call whose start answer it lost. */
export const VoiceSessionIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
export type VoiceSessionId = z.infer<typeof VoiceSessionIdSchema>;

/** A WebRTC session description. Never logged or stored: it carries local addresses. */
export const VoiceSdpSchema = z.string().min(1).max(64_000);

/** What the voice is asked to say; long replies are shortened before this. */
export const voiceSayMaxLength = 4_000;
export const VoiceSayTextSchema = z.string().trim().min(1).max(voiceSayMaxLength);
/**
 * Names what is spoken, such as a Chat message or a Request, so the call says
 * each thing once however often a client sends it.
 */
export const VoiceSayIdSchema = z.string().min(1).max(128);

/** A call ends unless its client renews it within this long. */
export const voiceLeaseMs = 60_000;
export const voiceRenewIntervalMs = 20_000;
/** No call lives longer than this after its Run was admitted, whatever its client does. */
export const voiceMaxCallMs = 2 * 60 * 60_000;

/**
 * What the person is looking at, in ids the call's agent can act on with its
 * tools. Titles are left out: the agent reads them through tools, where page
 * text is ordinary untrusted data.
 */
export const VoiceViewSchema = z.strictObject({
  threadId: ThreadIdSchema.nullable(),
  tabId: BrowserSurfaceIdSchema.nullable(),
});
export type VoiceView = z.infer<typeof VoiceViewSchema>;

/** Every call after start is addressed by its session id alone; the Host knows the rest. */
const voiceSession = { sessionId: VoiceSessionIdSchema };

export const VoiceStartInputSchema = z.strictObject({
  ...voiceSession,
  /** The computer and Codex account that carry the call and run its agent. */
  environmentId: EnvironmentIdSchema,
  harnessInstanceId: HarnessInstanceIdSchema,
  offer: VoiceSdpSchema,
});
export const VoiceStartResultSchema = z.object({
  answer: VoiceSdpSchema,
  /** The Voice Thread and this call's Run: `host.show` from this Run is meant for this device. */
  threadId: ThreadIdSchema,
  runId: RunIdSchema,
  workspaceId: WorkspaceIdSchema,
});
/** Creates the person's Voice Thread if it does not exist yet, without starting a call. */
export const VoiceOpenInputSchema = z.strictObject({
  environmentId: EnvironmentIdSchema,
  harnessInstanceId: HarnessInstanceIdSchema,
  accessMode: ThreadAccessModeSchema.optional(),
});
export const VoiceOpenResultSchema = z.object({
  threadId: ThreadIdSchema,
  /** The computer and Codex account the Thread is on, which carry its calls. */
  environmentId: EnvironmentIdSchema,
  harnessInstanceId: HarnessInstanceIdSchema,
});
export const VoiceRenewInputSchema = z.strictObject(voiceSession);
export const VoiceSayInputSchema = z.strictObject({
  ...voiceSession,
  id: VoiceSayIdSchema,
  text: VoiceSayTextSchema,
});
/** Replaces what the call's agent knows the person is looking at. */
export const VoiceContextInputSchema = z.strictObject({
  ...voiceSession,
  view: VoiceViewSchema,
});
export const VoiceStopInputSchema = z.strictObject(voiceSession);
export const VoiceEmptyResultSchema = z.object({});

export type VoiceStartInput = z.infer<typeof VoiceStartInputSchema>;
export type VoiceStartResult = z.infer<typeof VoiceStartResultSchema>;
export type VoiceOpenInput = z.infer<typeof VoiceOpenInputSchema>;
export type VoiceOpenResult = z.infer<typeof VoiceOpenResultSchema>;
export type VoiceRenewInput = z.infer<typeof VoiceRenewInputSchema>;
export type VoiceSayInput = z.infer<typeof VoiceSayInputSchema>;
export type VoiceContextInput = z.infer<typeof VoiceContextInputSchema>;
export type VoiceStopInput = z.infer<typeof VoiceStopInputSchema>;

/**
 * Why a voice call could not start or continue, carried as the error's
 * `reason` so a client says which side to fix without matching prose.
 */
export const VoiceRefusalReasonSchema = z.enum([
  /** The computer's Opensteer predates voice calls with an agent. */
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
