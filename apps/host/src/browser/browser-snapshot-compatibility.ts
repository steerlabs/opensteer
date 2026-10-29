import { browserProfileSnapshotVersion } from "@opensteer/browser-profile/snapshot";

export function browserSnapshotCompatibilityReason(version: number | undefined): string | null {
  if (version === browserProfileSnapshotVersion) return null;
  if (version !== undefined && version > browserProfileSnapshotVersion) {
    return `Update this Opensteer Host; the Browser Runtime uses browser profile snapshot version ${version}, but this Host supports version ${browserProfileSnapshotVersion}.`;
  }
  return `Update the Browser Runtime on this computer; this Host requires browser profile snapshot version ${browserProfileSnapshotVersion}.`;
}
