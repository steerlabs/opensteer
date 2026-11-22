import { formatReferenceLink, ReferenceSchema } from "@opensteer/core";
import type { HostSnapshot } from "./client.js";
import { heldThread } from "./task-list.js";
import { referenceTitle } from "../references/local.js";

/** Something the `@` list can write into the words: a Markdown link the Host built. */
export interface ComposerLinkCandidate {
  readonly key: string;
  readonly label: string;
  readonly markdown: string;
  readonly category: "Recent tasks" | "Automations" | "Computers";
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
    if (!ref.success || ref.data.kind === "tab" || candidates.has(ref.data.id)) return;
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

function matching(
  candidates: readonly ComposerLinkCandidate[],
  query: string,
): readonly ComposerLinkCandidate[] {
  const words = query.trim().toLocaleLowerCase();
  return words
    ? candidates.filter((candidate) => candidate.label.toLocaleLowerCase().includes(words))
    : candidates;
}
