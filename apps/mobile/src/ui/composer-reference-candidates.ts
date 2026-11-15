import type { HostSnapshot } from "@opensteer/client/host";
import { formatReferenceLink, type ReferenceId } from "@opensteer/core";

/** One reference the picker can insert, as Markdown. Plan B's `link` candidate. */
export interface ComposerLinkCandidate {
  readonly kind: "link";
  readonly key: string;
  readonly label: string;
  readonly markdown: string;
}

/**
 * Personal picker candidates: recent tasks, automations and computers the Host
 * already sent, filtered locally by `query`. No request is made per keystroke.
 *
 * Integrator: this is S2's `composerReferenceCandidates(snapshot, query)` from
 * `@opensteer/client/host`; bind it here and delete this projection
 * (see wiring/U4.diff). Its place candidates are not offered on mobile, which
 * has no place picker to extend.
 */
export function composerReferenceCandidates(
  snapshot: HostSnapshot,
  query: string,
): readonly ComposerLinkCandidate[] {
  const wanted = query.trim().toLowerCase();
  const seen = new Set<string>();
  const out: ComposerLinkCandidate[] = [];
  const add = (id: string, label: string): void => {
    if (seen.has(id) || (wanted !== "" && !label.toLowerCase().includes(wanted))) return;
    seen.add(id);
    try {
      out.push({
        kind: "link",
        key: id,
        label,
        markdown: formatReferenceLink(id as ReferenceId, label),
      });
    } catch {
      // Not an id a reference can carry.
    }
  };
  for (const entry of [...snapshot.activeTasks, ...(snapshot.tasks?.entries ?? [])])
    add(entry.thread.id, entry.thread.title || "Untitled task");
  for (const automation of Object.values(snapshot.threadAutomations).flat())
    add(automation.id, automation.name);
  for (const machine of snapshot.machines) add(machine.id, machine.name);
  return out;
}
