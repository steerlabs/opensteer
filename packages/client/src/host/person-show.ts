import type { PersonShowMessage } from "@opensteer/protocol";
import type { HostSnapshot } from "./client.js";
import { placeList } from "./places.js";
import { heldThread } from "./task-list.js";
import { runPlaceDestination } from "./run-place.js";
import type { VoiceCallIdentity, VoiceTarget } from "../voice/contract.js";

/** The platform reports the conversation on screen or beneath a place; other routes name none. */
export interface PersonShowView {
  readonly foreground: boolean;
  readonly threadId: string | null;
  /**
   * The voice call this device holds. Its agent's Thread is hidden, and the
   * person may be on any screen while they talk, so its Run may change the
   * screen whatever is showing.
   */
  readonly call?: VoiceCallIdentity | null;
}

/** Whether a `host.show` came from this device's live voice call, not one it replaced. */
export function personShowFromCall(
  message: PersonShowMessage,
  call: VoiceCallIdentity | null | undefined,
): boolean {
  return !!call && message.runId === call.runId && message.threadId === call.threadId;
}

/**
 * Acts on a Run's `host.show` when this device is where the person sees that
 * Run: its conversation, or the voice call they are talking to.
 */
export function handlePersonShow(
  snapshot: HostSnapshot,
  message: PersonShowMessage,
  view: PersonShowView,
  navigate: (target: VoiceTarget) => void | boolean,
): boolean {
  if (!view.foreground) return false;
  if (!personShowFromCall(message, view.call)) {
    if (view.threadId !== message.threadId) return false;
    const source = heldThread(snapshot, message.threadId);
    if (!source) return false;
  }
  const target = message.target;
  if ("threadId" in target) {
    return navigate({ kind: "thread", threadId: target.threadId }) !== false;
  }
  if ("place" in target) {
    const destination = runPlaceDestination({ runId: target.runId, data: target }, snapshot);
    return destination !== null && navigate({ kind: "place", destination }) !== false;
  }
  const place = placeList(snapshot).find(
    (place) => place.destination.kind === "browser" && place.destination.tabId === target.tabId,
  );
  if (!place || place.availability === "unavailable") return false;
  return navigate({ kind: "place", destination: place.destination }) !== false;
}
