import type { AgentEvent, RunId, UserId } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import type { PersonShowMessage } from "@opensteer/protocol";

/**
 * A call has no reply to read, so the person's screen follows its agent without
 * a model step: to each place it works in, to each Request it needs them to
 * answer, and back to its place once they have. Only the device holding the
 * call acts on these.
 */
export function createVoiceFollow(dependencies: {
  readonly store: Pick<OpensteerStore, "voiceCallForRun" | "latestRunPlace">;
  readonly show: (userId: UserId, message: PersonShowMessage) => Promise<number>;
  readonly onError: (error: unknown) => void;
}): (event: AgentEvent) => void {
  const target = async (
    event: AgentEvent,
    runId: RunId,
  ): Promise<PersonShowMessage["target"] | null> => {
    if (event.type === "place.entered") return { place: event.data.place };
    if (event.type === "request.opened") return { threadId: event.threadId };
    const place = await dependencies.store.latestRunPlace(runId);
    return place ? { place: place.data.place } : null;
  };
  // One lane per Run: a slow read must not let an older place cover a newer Request.
  const tails = new Map<RunId, Promise<void>>();
  return (event) => {
    if (!["place.entered", "request.opened", "request.resolved"].includes(event.type)) return;
    const { runId, threadId, workspaceId } = event;
    if (!runId) return;
    const tail = (tails.get(runId) ?? Promise.resolve())
      .then(async () => {
        const call = await dependencies.store.voiceCallForRun(runId);
        if (!call) return;
        const shown = await target(event, runId);
        if (shown)
          await dependencies.show(call.ownerId, {
            type: "host.show",
            workspaceId,
            threadId,
            runId,
            target: shown,
          });
      })
      .catch(dependencies.onError);
    tails.set(runId, tail);
    void tail.finally(() => {
      if (tails.get(runId) === tail) tails.delete(runId);
    });
  };
}
