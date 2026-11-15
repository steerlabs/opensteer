import {
  formatReferenceLink,
  ReferenceSchema,
  teamPageUrl,
  type TeamPageTarget,
} from "@opensteer/core";
import type { TeamChannelSummary, TeamNotePreview, TeamTopic } from "@opensteer/protocol";
import { markdownLink } from "@opensteer/shared/markdownLinks";
import type { HostSnapshot } from "./client.js";
import { heldThread } from "./task-list.js";
import { referenceTitle } from "../references/local.js";

/** Something the `@` list can write into the words: a Markdown link the Host or team built. */
export interface ComposerLinkCandidate {
  readonly key: string;
  readonly label: string;
  readonly markdown: string;
  readonly category: "Recent tasks" | "Automations" | "Computers" | "Channels" | "Knowledge";
}

/** Recent tasks, automations and computers for an `@` query, from what this Host already holds. */
export function composerReferenceCandidates(
  snapshot: HostSnapshot,
  query: string,
): readonly ComposerLinkCandidate[] {
  const candidates = new Map<string, ComposerLinkCandidate>();
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
    if (!ref.success || candidates.has(ref.data.id)) return;
    const label = referenceTitle(
      title,
      kind === "task" ? "Task" : kind === "automation" ? "Automation" : "Computer",
    );
    candidates.set(ref.data.id, {
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
  for (const automation of Object.values(snapshot.threadAutomations).flat())
    personal("automation", automation.id, automation.name, "Automations");
  for (const machine of snapshot.machines)
    personal("computer", machine.id, machine.name, "Computers");
  return matching([...candidates.values()], query);
}

/**
 * Team pages for an `@` query: the channels the reader holds, and the knowledge topics and
 * notes the team listed for this reader. `notes` already answer the query (the team searches
 * them), so only channels and topics are narrowed here.
 */
export function teamReferenceCandidates(
  team: {
    readonly origin: string;
    readonly channels: readonly Pick<TeamChannelSummary, "id" | "kind" | "name" | "archivedAt">[];
    readonly topics: readonly Pick<TeamTopic, "id" | "name" | "archivedAt">[];
    readonly notes: readonly Pick<TeamNotePreview, "id" | "topicId" | "title">[];
  },
  query: string,
): readonly ComposerLinkCandidate[] {
  const link = (target: TeamPageTarget, title: string, category: "Channels" | "Knowledge") => {
    const href = teamPageUrl({ origin: team.origin, target });
    const label = referenceTitle(title, target.kind === "channel" ? "Channel" : "Knowledge");
    return { key: href, label, markdown: markdownLink(label, href), category };
  };
  return [
    ...matching(
      [
        ...team.channels
          .filter((channel) => channel.kind !== "dm" && channel.kind !== "group_dm")
          .filter((channel) => channel.archivedAt === null)
          .map((channel) =>
            link({ kind: "channel", channelId: channel.id }, channel.name, "Channels"),
          ),
        ...team.topics
          .filter((topic) => topic.archivedAt === null)
          .map((topic) =>
            link({ kind: "knowledge-topic", topicId: topic.id }, topic.name, "Knowledge"),
          ),
      ],
      query,
    ),
    ...team.notes.map((note) =>
      link(
        { kind: "knowledge-note", topicId: note.topicId, noteId: note.id },
        note.title,
        "Knowledge",
      ),
    ),
  ];
}

function matching(
  candidates: readonly ComposerLinkCandidate[],
  query: string,
): readonly ComposerLinkCandidate[] {
  const words = query.trim().toLocaleLowerCase();
  return words
    ? candidates.filter((candidate) => candidate.label.toLocaleLowerCase().includes(words))
    : candidates;
}
