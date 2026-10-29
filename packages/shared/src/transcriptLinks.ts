const documentProtocols = new Set(["http:", "https:", "mailto:"]);

/**
 * The destination of a link an agent wrote, when it may be opened at all.
 * Transcript text may open a document outside the app, never navigate the app,
 * reach a local file or carry credentials, so only an absolute web or mail
 * address is returned. A path names a file on the agent's computer, not
 * anything the reader's app can open, and a relative address would resolve
 * against the app's own origin.
 */
export function transcriptLinkUrl(href: string): URL | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!documentProtocols.has(url.protocol) || url.username || url.password) return null;
  return url;
}
