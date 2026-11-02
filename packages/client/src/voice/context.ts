import { placeIdentityKey } from "@opensteer/core";
import { voiceAnswerMaxLength, voiceContextMaxLength } from "@opensteer/protocol/voice";
import type { HostSnapshot, PlaceEntry, ThreadSummary, TranscriptEntry } from "../host/client.js";
import { placeList, placeSearchFields, type PlaceItem } from "../host/places.js";
import { heldThread, taskAttention, taskList } from "../host/task-list.js";
import { nativeViewerSource, type WorkspaceSurfaceDestination } from "../host/surfaces.js";
import { browserTabStrip } from "../host/browser-tab-strip.js";
import { matchSearch, searchQuery, type SearchField } from "../host/search.js";
import { threadSearchFields } from "../host/thread-list-model.js";
import { threadStopTarget } from "../host/thread-activity.js";
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
const label = (text: string, max = 180) => JSON.stringify(text.slice(0, max));

export type VoiceWorkingPlace = Pick<PlaceEntry, "place" | "title" | "site">;
export interface VoiceContextOptions {
  readonly find?: boolean;
  /** The working Run's place, from the per-Run store rather than the loaded transcript window. */
  readonly runPlace: (runId: string) => VoiceWorkingPlace | null;
}

const matchesPlace = (place: PlaceItem, working: VoiceWorkingPlace) => {
  const target = working.place;
  const destination = place.destination;
  if (target.kind === "browser")
    return (
      destination.kind === "browser" &&
      destination.tabId === target.surfaceId &&
      destination.sessionId === target.sessionId
    );
  return (
    destination.kind === target.kind &&
    destination.machineId === target.machineId &&
    (target.kind === "app"
      ? destination.kind === "app" && destination.appKey === target.appKey
      : destination.kind === "phone" && (destination.display ?? "main") === target.display)
  );
};

/** References belong to one call and retain the exact offered destination. */
export class VoiceContextLinks {
  readonly #refs = new Map<string, WorkspaceSurfaceDestination>();
  readonly #threads = new Set<string>();
  readonly #seen = new Map<string, string>();
  readonly #historyRecency = new WeakMap<readonly TranscriptEntry[], ReadonlyMap<string, string>>();
  readonly #canShow: (destination: WorkspaceSurfaceDestination) => boolean;
  #visible: string | undefined;
  #next = 0;
  constructor(canShow: (destination: WorkspaceSurfaceDestination) => boolean = () => true) {
    this.#canShow = canShow;
  }
  #places(snapshot: HostSnapshot) {
    return placeList(snapshot).filter((place) => this.#canShow(place.destination));
  }
  #link(place: PlaceItem): string {
    let ref = [...this.#refs].find(([, d]) => identity(d) === identity(place.destination))?.[0];
    if (!ref) {
      ref = String(++this.#next);
      this.#refs.set(ref, place.destination);
    }
    return `opensteer://place/${ref}`;
  }
  #threadLink(id: string): string {
    this.#threads.add(id);
    return `opensteer://thread/${encodeURIComponent(id)}`;
  }
  #line(place: PlaceItem, max = 180): string {
    return `${label(place.title, max)} | ${place.kind}${place.site ? ` ${label(place.site, max)}` : ""}${place.identity ? ` | ${label(place.identity.name, max)}` : ""}${place.device ? ` | ${label(place.device.name, max)}` : ""} | ${this.#link(place)}`;
  }
  #recency(snapshot: HostSnapshot, places: readonly PlaceItem[]): Map<string, string> {
    const activity = new Map<string, string>();
    const remember = (key: string, at: string) => {
      if (at > (activity.get(key) ?? "")) activity.set(key, at);
    };
    for (const entries of Object.values(snapshot.transcripts)) {
      let recent = this.#historyRecency.get(entries);
      if (!recent) {
        const indexed = new Map<string, string>();
        for (const entry of entries) {
          if (entry.kind !== "place") continue;
          const key = placeIdentityKey(entry.place);
          if (entry.createdAt > (indexed.get(key) ?? "")) indexed.set(key, entry.createdAt);
        }
        recent = indexed;
        this.#historyRecency.set(entries, recent);
      }
      for (const [key, at] of recent) remember(key, at);
    }
    for (const session of snapshot.browserSessions)
      for (const use of session.uses ?? [])
        if (use.tabId) remember(`browser:${session.id}:${use.tabId}`, use.lastUsedAt);
    return new Map(
      places.map((place) => {
        const d = place.destination;
        const key =
          d.kind === "browser"
            ? `browser:${d.sessionId}:${d.tabId}`
            : `${d.kind}:${d.machineId}:${d.kind === "app" ? d.appKey : (d.display ?? "main")}`;
        const times = [
          activity.get(key) ?? "",
          this.#seen.get(identity(d)) ?? "",
          ...place.occupants.map((o) => o.lastActiveAt),
        ];
        if (d.kind !== "browser") {
          times.push(place.ownerView?.openedAt ?? "");
          times.push(
            snapshot.machines
              .find((m) => m.id === d.machineId)
              ?.computerUse?.sessions.find((s) => s.sessionId === d.computerSessionId)?.openedAt ??
              "",
          );
        }
        return [place.key, times.reduce((a, b) => (a > b ? a : b), "")];
      }),
    );
  }
  build(snapshot: HostSnapshot, view: VoiceView | undefined, options: VoiceContextOptions): string {
    const places = this.#places(snapshot);
    const visible = view?.destination ? identity(view.destination) : undefined;
    if (visible && visible !== this.#visible) this.#seen.set(visible, new Date().toISOString());
    this.#visible = visible;
    const place = places.find((p) => identity(p.destination) === visible);
    const thread = view?.threadId && heldThread(snapshot, view.threadId);
    const lines = [
      `Visible now: ${label(place ? place.title : thread ? thread.title : (view?.title ?? "Chat"))}${place ? ` | ${this.#link(place)}` : ""}`,
      "Chat: opensteer://chat",
      "Back: opensteer://back",
    ];
    const home = snapshot.homeThreadId ? heldThread(snapshot, snapshot.homeThreadId) : null;
    const run = home && threadStopTarget({ thread: home, runQueue: snapshot.runQueue });
    const working = run && options.runPlace(run.id);
    let current: PlaceItem | undefined;
    if (working) {
      current = places.find((place) => {
        if (!matchesPlace(place, working)) return false;
        const destination = place.destination;
        if (destination.kind === "browser") return true;
        return snapshot.machines
          .find((machine) => machine.id === destination.machineId)
          ?.computerUse?.sessions.some(
            (session) =>
              session.runId === run.id && session.sessionId === destination.computerSessionId,
          );
      });
      lines.push(
        `Chat is working in: ${label(working.title)}${current ? ` | ${this.#link(current)}` : " | not available on this device"}`,
      );
    }
    lines.push(options.find ? "Tasks (partial; use find for more):" : "Tasks:");
    const tasks = taskList(snapshot);
    for (const task of [...tasks.working, ...tasks.ready, ...tasks.done].slice(
      0,
      options.find ? 8 : 25,
    ))
      lines.push(
        `${label(task.title)} | ${task.done ? "done" : task.tone} | ${this.#threadLink(task.threadId)}`,
      );
    lines.push(options.find ? "Places (partial; use find for more):" : "Places:");
    const recent = this.#recency(snapshot, places);
    for (const place of [...places]
      .filter((place) => place !== current)
      .sort(
        (a, b) =>
          recent.get(b.key)!.localeCompare(recent.get(a.key)!) || a.key.localeCompare(b.key),
      )
      .slice(0, options.find ? 8 : 25))
      lines.push(this.#line(place));
    let text = "";
    for (const line of lines) {
      if (text.length + line.length + 1 > voiceContextMaxLength) break;
      text += `${text ? "\n" : ""}${line}`;
    }
    return text;
  }
  find(
    snapshot: HostSnapshot,
    query: string,
    offset = 0,
  ): { text: string; total: number; nextOffset: number | null } {
    const words = searchQuery(query);
    const places = this.#places(snapshot);
    const groupTitles = new Map<string, string>();
    for (const row of browserTabStrip(places, snapshot.browserTabGroups).web)
      if (row.kind === "group")
        for (const place of row.places) groupTitles.set(place.key, row.group.title);
    const threads = new Map<string, ThreadSummary>();
    for (const thread of [
      ...snapshot.threads,
      ...snapshot.activeTasks.map(({ thread }) => thread),
      ...(snapshot.tasks?.entries ?? []).map(({ thread }) => thread),
      ...Object.values(snapshot.workspaceTasks).flatMap(({ entries }) =>
        entries.map(({ thread }) => thread),
      ),
    ])
      if (!threads.has(thread.id)) threads.set(thread.id, thread);
    const recent = this.#recency(snapshot, places);
    const asks = new Map(taskAttention(snapshot).map((ask) => [ask.threadId, ask.title]));
    const found: { score: number; at: string; key: string; line: () => string }[] = [];
    const add = (fields: SearchField[], at: string, key: string, line: () => string) => {
      const match = words.length ? matchSearch(fields, words) : { score: 0 };
      if (match) found.push({ score: match.score, at, key, line });
    };
    for (const place of places)
      add(
        placeSearchFields(place, groupTitles.get(place.key) ?? null),
        recent.get(place.key)!,
        place.key,
        () => this.#line(place, 80),
      );
    for (const thread of threads.values())
      add(
        threadSearchFields(
          thread,
          snapshot.workspaces.find((w) => w.id === thread.workspaceId)?.name ?? null,
          asks.get(thread.id) ?? null,
        ),
        thread.updatedAt > thread.askedAt ? thread.updatedAt : thread.askedAt,
        thread.id,
        () => `${label(thread.title)} | thread ${thread.status} | ${this.#threadLink(thread.id)}`,
      );
    found.sort(
      (a, b) => b.score - a.score || b.at.localeCompare(a.at) || a.key.localeCompare(b.key),
    );
    // Bound each answer, never the searchable inventory. Offsets can reach every match.
    const page: string[] = [];
    let length = 100;
    for (const item of found.slice(offset, offset + 5)) {
      const line = item.line();
      if (length + line.length + 1 > voiceAnswerMaxLength) break;
      page.push(line);
      length += line.length + 1;
    }
    const nextOffset = offset + page.length < found.length ? offset + page.length : null;
    const text =
      found.length === 0
        ? "No match on this device."
        : `${found.length} matches on this device; offset ${offset}; next offset ${nextOffset ?? "none"}.\n${page.length ? page.join("\n") : "No more matches on this device."}`;
    return { text, total: found.length, nextOffset };
  }
  resolve(link: string, snapshot: HostSnapshot): { target: VoiceTarget; title: string } | null {
    if (link === "opensteer://chat") return { target: { kind: "chat" }, title: "Chat" };
    if (link === "opensteer://back")
      return { target: { kind: "back" }, title: "the previous screen" };
    try {
      const thread = /^opensteer:\/\/thread\/([^/?#]+)$/.exec(link);
      if (thread) {
        const id = decodeURIComponent(thread[1]!);
        const found = this.#threads.has(id) && heldThread(snapshot, id);
        return found
          ? { target: { kind: "thread", threadId: found.id }, title: found.title }
          : null;
      }
      const match = /^opensteer:\/\/place\/([^/?#]+)$/.exec(link);
      const destination = match && this.#refs.get(decodeURIComponent(match[1]!));
      const found =
        destination &&
        this.#places(snapshot).find((p) => identity(p.destination) === identity(destination));
      return found
        ? { target: { kind: "place", destination: found.destination }, title: found.title }
        : null;
    } catch {
      return null;
    }
  }
}
