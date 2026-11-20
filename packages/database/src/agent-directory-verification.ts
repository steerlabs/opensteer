import type {
  AgentConnectionIdentityAtConsent,
  AgentDirectoryDocument,
  AgentDirectoryPublicJwk,
} from "@opensteer/control-plane-protocol";

// RFC 7638 uses only the required public members in lexicographic order.
export async function agentDirectoryKeyThumbprint(key: AgentDirectoryPublicJwk): Promise<string> {
  const members =
    key.kty === "EC"
      ? { crv: key.crv, kty: key.kty, x: key.x, y: key.y }
      : { crv: key.crv, kty: key.kty, x: key.x };
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(members)),
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

/**
 * Checks whether a previously recorded consent identity is still backed by the current directory.
 * Returns `null` when the directory is unavailable (cannot claim withdrawal without a live directory).
 */
export async function isIdentityStillVerified(
  identity: AgentConnectionIdentityAtConsent,
  directory: AgentDirectoryDocument | null,
): Promise<boolean | null> {
  if (identity.kind === "unverified") return false;
  if (!directory) return null;
  const platform = directory.entries.find(
    (entry) =>
      entry.id === identity.platformDirectoryId && entry.origins.includes(identity.platformOrigin),
  );
  if (!platform) return false;
  if (identity.kind === "platform") return true;
  const embedder = directory.entries.find(
    (entry) =>
      entry.id === identity.embedderDirectoryId && entry.origins.includes(identity.embedderOrigin),
  );
  if (!embedder?.embedsVia?.includes(platform.id)) return false;
  for (const key of embedder.keys?.keys ?? []) {
    if ((await agentDirectoryKeyThumbprint(key)) === identity.keyThumbprint) return true;
  }
  return false;
}
