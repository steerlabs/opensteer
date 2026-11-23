import type {
  AgentConnectionIdentityAtConsent,
  AgentDirectoryDocument,
} from "@opensteer/control-plane-protocol";

/**
 * Checks whether a previously recorded consent identity is still backed by the current directory:
 * its entry still lists the origin it was verified by. Returns `null` when the directory is
 * unavailable (cannot claim withdrawal without a live directory).
 */
export async function isIdentityStillVerified(
  identity: AgentConnectionIdentityAtConsent,
  directory: AgentDirectoryDocument | null,
): Promise<boolean | null> {
  if (identity.kind === "unverified") return false;
  if (!directory) return null;
  return directory.entries.some(
    (entry) =>
      entry.id === identity.platformDirectoryId && entry.origins.includes(identity.platformOrigin),
  );
}
