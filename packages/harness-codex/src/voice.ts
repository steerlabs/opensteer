import { OpensteerError } from "@opensteer/core";
import type { HarnessVoiceCall } from "@opensteer/harness";
import type { VoiceRefusalReason } from "@opensteer/protocol";
import { withTimeout } from "@opensteer/shared/withTimeout";
import type { CodexStdioClient } from "./process.js";

export function voiceError(reason: VoiceRefusalReason): OpensteerError {
  return new OpensteerError({
    code: "conflict",
    reason,
    message: "This voice call could not continue.",
  });
}

export async function startRealtime(
  client: CodexStdioClient,
  threadId: string,
  call: HarnessVoiceCall,
  timeoutMs: number,
): Promise<void> {
  const offer = await withTimeout(call.offer, timeoutMs, {
    signal: call.signal,
    timeoutError: () => voiceError("voice-ended"),
  });
  // Codex retains a TRACE SQLite log in the account's state home; it cannot be disabled.
  // Keep Codex's built-in realtime prompt and explicitly select V3 (WebRTC defaults to V1).
  await client.request(
    "thread/realtime/start",
    {
      threadId,
      transport: { type: "webrtc", sdp: offer },
      version: "v3",
      clientManagedHandoffs: true,
      includeStartupContext: false,
      outputModality: "audio",
    },
    timeoutMs,
  );
}
