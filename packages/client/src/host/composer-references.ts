import {
  formatReferenceLink,
  ReferenceSchema,
  teamPageUrl,
  type TeamPageTarget,
} from "@opensteer/core";
import type { DurableWindow, TeamMember } from "@opensteer/protocol";
import { markdownLink } from "@opensteer/shared/markdownLinks";
import type { HostSnapshot, ThreadAutomation } from "./client.js";
import { heldThread } from "./task-list.js";
import { placeList, type PlaceItem } from "./places.js";
import { referenceTitle, type HeldTeamReferences } from "../references/local.js";

export type ComposerCandidate =
  | {
      readonly kind: "link";
      readonly key: string;
      readonly label: string;
      readonly markdown: string;
      readonly category: "Recent tasks" | "Automations" | "Computers" | "Channels" | "Knowledge";
    }
  | {
      readonly kind: "place";
      readonly key: string;
      readonly label: string;
      readonly place: PlaceItem;
      readonly category: "Include context";
    }
  | {
      readonly kind: "mention";
      readonly key: string;
      readonly label: string;
      readonly handle: string;
      readonly actor: "human" | "agent";
      readonly category: "People";
    }
  | {
      readonly kind: "more";
      readonly key: string;
      readonly label: "More";
      readonly category: "Recent tasks";
      readonly list: "recent" | "done";
      readonly before: DurableWindow["nextBefore"];
    };
export type ComposerReferenceSource =
  | {
      readonly kind: "personal";
      readonly snapshot: HostSnapshot;
      readonly places?: readonly PlaceItem[];
      readonly automations?: readonly ThreadAutomation[];
    }
  | {
      readonly kind: "team";
      readonly snapshot: HeldTeamReferences;
      readonly people?: readonly Pick<TeamMember, "userId" | "displayName" | "handle" | "state">[];
      readonly agents?: readonly {
        readonly key: string;
        readonly label: string;
        readonly handle: string;
      }[];
    };

export function composerReferenceCandidates(
  source: HostSnapshot | ComposerReferenceSource,
  query: string,
): readonly ComposerCandidate[] {
  const scope: ComposerReferenceSource =
    "kind" in source ? source : { kind: "personal", snapshot: source };
  const candidates: ComposerCandidate[] = [];
  const seen = new Set<string>();
  const add = (candidate: ComposerCandidate) => {
    if (!seen.has(candidate.key)) {
      seen.add(candidate.key);
      candidates.push(candidate);
    }
  };
  if (scope.kind === "personal") {
    const snapshot = scope.snapshot;
    const threads = [
      ...snapshot.threads,
      ...snapshot.activeTasks.map(({ thread }) => thread),
      ...(snapshot.tasks?.entries ?? []).map(({ thread }) => thread),
      ...Object.values(snapshot.doneTasks).flatMap(({ entries }) =>
        entries.map(({ thread }) => thread),
      ),
    ];
    threads.sort((a, b) => b.askedAt.localeCompare(a.askedAt));
    const personal = (
      kind: "task" | "automation" | "computer",
      id: string,
      title: string,
      category: "Recent tasks" | "Automations" | "Computers",
    ) => {
      const ref = ReferenceSchema.safeParse({ kind, id });
      if (!ref.success) return;
      const label = referenceTitle(
        title,
        kind === "task" ? "Task" : kind === "automation" ? "Automation" : "Computer",
      );
      add({
        kind: "link",
        key: ref.data.id,
        label,
        markdown: formatReferenceLink(ref.data.id, label),
        category,
      });
    };
    for (const thread of threads)
      if (thread.purpose === "task")
        personal(
          "task",
          thread.id,
          heldThread(snapshot, thread.id)?.title ?? thread.title,
          "Recent tasks",
        );
    for (const automation of [
      ...Object.values(snapshot.threadAutomations).flat(),
      ...(scope.automations ?? []),
    ])
      personal("automation", automation.id, automation.name, "Automations");
    for (const machine of snapshot.machines)
      personal("computer", machine.id, machine.name, "Computers");
    for (const place of scope.places ?? placeList(snapshot))
      add({
        kind: "place",
        key: `place:${place.key}`,
        label: place.title,
        place,
        category: "Include context",
      });
    if (snapshot.tasks?.window.hasMore)
      add({
        kind: "more",
        key: "more:recent",
        label: "More",
        category: "Recent tasks",
        list: "recent",
        before: snapshot.tasks.window.nextBefore,
      });
    for (const [key, list] of Object.entries(snapshot.doneTasks))
      if (list.window.hasMore)
        add({
          kind: "more",
          key: `more:done:${key}`,
          label: "More",
          category: "Recent tasks",
          list: "done",
          before: list.window.nextBefore,
        });
  } else {
    const snapshot = scope.snapshot;
    const team = (target: TeamPageTarget, title: string, category: "Channels" | "Knowledge") => {
      const href = teamPageUrl({ origin: snapshot.origin, target });
      const label = referenceTitle(title, target.kind === "channel" ? "Channel" : "Knowledge");
      add({ kind: "link", key: href, label, markdown: markdownLink(label, href), category });
    };
    for (const { channel } of snapshot.sidebar?.channels ?? [])
      team({ kind: "channel", channelId: channel.id }, channel.name, "Channels");
    for (const topic of snapshot.topics ?? [])
      team({ kind: "knowledge-topic", topicId: topic.id }, topic.name, "Knowledge");
    for (const note of snapshot.notes ?? [])
      if (!("deleted" in note && note.deleted))
        team(
          { kind: "knowledge-note", topicId: note.topicId, noteId: note.id },
          note.title,
          "Knowledge",
        );
    for (const person of scope.people ?? [])
      if (person.state === "active")
        add({
          kind: "mention",
          key: `person:${person.userId}`,
          label: person.displayName,
          handle: person.handle,
          actor: "human",
          category: "People",
        });
    for (const agent of scope.agents ?? [])
      add({
        kind: "mention",
        key: `agent:${agent.key}`,
        label: agent.label,
        handle: agent.handle,
        actor: "agent",
        category: "People",
      });
  }
  const words = query.trim().toLocaleLowerCase();
  return candidates.filter(
    (candidate) =>
      candidate.kind === "more" ||
      !words ||
      candidate.label.toLocaleLowerCase().includes(words) ||
      (candidate.kind === "mention" && candidate.handle.toLocaleLowerCase().includes(words)),
  );
}
