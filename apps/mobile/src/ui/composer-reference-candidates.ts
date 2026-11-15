import {
  composerReferenceCandidates as hostCandidates,
  type ComposerCandidate,
  type HostSnapshot,
} from "@opensteer/client/host";

/** One reference the picker can insert, as Markdown. */
export type ComposerLinkCandidate = Extract<ComposerCandidate, { readonly kind: "link" }>;

/**
 * Personal picker candidates from held Host state. Mobile has no place picker
 * to extend, so only link candidates are offered.
 */
export function composerReferenceCandidates(
  snapshot: HostSnapshot,
  query: string,
): readonly ComposerLinkCandidate[] {
  return hostCandidates(snapshot, query).filter(
    (candidate): candidate is ComposerLinkCandidate => candidate.kind === "link",
  );
}
