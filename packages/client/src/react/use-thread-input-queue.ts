import type { PersonalInputQueue } from "@opensteer/protocol";
import type { HostClient } from "../host/client.js";
import { useThreadTranscript } from "./use-thread-transcript.js";

export function useThreadInputQueue(
  hostClient: HostClient,
  threadId: string | null | undefined,
  observed = true,
): PersonalInputQueue | null {
  return useThreadTranscript(hostClient, threadId, observed).inputQueue;
}
