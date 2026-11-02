import type { PersonShowMessage } from "@opensteer/protocol";
import type { HostSnapshot } from "./client.js";
import { placeList } from "./places.js";
import { heldThread } from "./task-list.js";
import type { VoiceTarget } from "../voice/contract.js";

/** The platform reports the conversation actually visible now; covered routes name none. */
export interface PersonShowView {
  readonly foreground: boolean;
  readonly threadId: string | null;
}

export function handlePersonShow(
  snapshot: HostSnapshot,
  message: PersonShowMessage,
  view: PersonShowView,
  navigate: (target: VoiceTarget) => void | boolean,
): boolean {
  if (!view.foreground || view.threadId !== message.threadId) return false;
  const source = heldThread(snapshot, message.threadId);
  if (!source || source.workspaceId !== message.workspaceId) return false;
  const target = message.target;
  if ("threadId" in target) {
    if (!heldThread(snapshot, target.threadId)) return false;
    return (
      navigate(
        target.threadId === snapshot.homeThreadId
          ? { kind: "chat" }
          : { kind: "thread", threadId: target.threadId },
      ) !== false
    );
  }
  const place = placeList(snapshot).find(
    (place) => place.destination.kind === "browser" && place.destination.tabId === target.tabId,
  );
  if (!place || place.availability === "unavailable") return false;
  return navigate({ kind: "place", destination: place.destination }) !== false;
}
