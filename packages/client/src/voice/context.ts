import { voiceContextMaxLength } from "@opensteer/protocol/voice";
import type { HostSnapshot } from "../host/client.js";
import { placeList } from "../host/places.js";
import { heldThread, taskList } from "../host/task-list.js";
import { nativeViewerSource, type WorkspaceSurfaceDestination } from "../host/surfaces.js";
import type { VoiceTarget } from "./contract.js";

export type VoiceView = {
  readonly threadId?: string | undefined;
  readonly destination?: WorkspaceSurfaceDestination | undefined;
  readonly title?: string | undefined;
};
const identity = (d: WorkspaceSurfaceDestination) => {
  const source = d.kind === "browser" ? null : nativeViewerSource(d);
  return JSON.stringify(
    d.kind === "browser"
      ? [d.kind, d.sessionId, d.tabId]
      : [
          d.kind,
          d.machineId,
          d.kind === "app" ? d.appKey : (d.display ?? "main"),
          d.kind === "app" ? d.windowId : null,
          source?.kind === "owner-view"
            ? [source.kind, source.viewId, source.generation]
            : [source?.kind, source?.sessionId],
        ],
  );
};
const label = (text: string) => JSON.stringify(text.slice(0, 180));

/** References belong to one call and retain the exact offered destination. */
export class VoiceContextLinks {
  readonly #refs = new Map<string, WorkspaceSurfaceDestination>();
  #next = 0;
  build(snapshot: HostSnapshot, view?: VoiceView): string {
    const places = placeList(snapshot);
    const place =
      view?.destination &&
      places.find((p) => identity(p.destination) === identity(view.destination!));
    const thread = view?.threadId && heldThread(snapshot, view.threadId);
    const lines = [
      `Visible now: ${label(place ? place.title : thread ? thread.title : (view?.title ?? "Chat"))}`,
      "Chat: opensteer://chat",
      "Back: opensteer://back",
      "Tasks:",
    ];
    const tasks = taskList(snapshot);
    for (const task of [...tasks.working, ...tasks.ready, ...tasks.done].slice(0, 25))
      lines.push(
        `${label(task.title)} | ${task.done ? "done" : task.tone} | opensteer://thread/${encodeURIComponent(task.threadId)}`,
      );
    lines.push("Places:");
    for (const place of [...places]
      .sort((a, b) => {
        const openedAt = (p: typeof a) =>
          p.ownerView?.openedAt ??
          p.workspaceTab?.createdAt ??
          (p.browser
            ? snapshot.browserSessions.find((s) => s.id === p.browser!.sessionId)?.createdAt
            : snapshot.machines
                .find((m) => p.destination.kind !== "browser" && m.id === p.destination.machineId)
                ?.computerUse?.sessions.find(
                  (s) =>
                    p.destination.kind !== "browser" &&
                    s.sessionId === p.destination.computerSessionId,
                )?.openedAt) ??
          "";
        return openedAt(b).localeCompare(openedAt(a));
      })
      .slice(0, 25)) {
      let ref = [...this.#refs].find(([, d]) => identity(d) === identity(place.destination))?.[0];
      if (!ref) {
        ref = String(++this.#next);
        this.#refs.set(ref, place.destination);
      }
      lines.push(
        `${label(place.title)} | ${place.kind}${place.site ? ` ${label(place.site)}` : ""} | opensteer://place/${encodeURIComponent(ref)}`,
      );
    }
    let text = "";
    for (const line of lines) {
      if (text.length + line.length + 1 > voiceContextMaxLength) break;
      text += `${text ? "\n" : ""}${line}`;
    }
    return text;
  }
  resolve(link: string, snapshot: HostSnapshot): { target: VoiceTarget; title: string } | null {
    if (link === "opensteer://chat") return { target: { kind: "chat" }, title: "Chat" };
    if (link === "opensteer://back")
      return { target: { kind: "back" }, title: "the previous screen" };
    try {
      const thread = /^opensteer:\/\/thread\/([^/?#]+)$/.exec(link);
      if (thread) {
        const found = heldThread(snapshot, decodeURIComponent(thread[1]!));
        return found
          ? { target: { kind: "thread", threadId: found.id }, title: found.title }
          : null;
      }
      const match = /^opensteer:\/\/place\/([^/?#]+)$/.exec(link);
      const destination = match && this.#refs.get(decodeURIComponent(match[1]!));
      const found =
        destination &&
        placeList(snapshot).find((p) => identity(p.destination) === identity(destination));
      return found
        ? { target: { kind: "place", destination: found.destination }, title: found.title }
        : null;
    } catch {
      return null;
    }
  }
}
