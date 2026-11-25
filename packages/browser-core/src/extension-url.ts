/**
 * The one test for "this is an extension's address", used wherever a connected agent could be
 * given one: the router, the page-session isolation, the runtime's own tab commands and the
 * Home's tab lists. A URL or origin that parses (per WHATWG URL rules, stripping ASCII
 * tabs/newlines and leading C0 controls) to the `chrome-extension:` scheme, including inside
 * `view-source:`, `blob:` and `filesystem:` wrappers.
 */
export function isExtensionUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "chrome-extension:") return true;
    if (
      parsed.protocol === "view-source:" ||
      parsed.protocol === "blob:" ||
      parsed.protocol === "filesystem:"
    )
      return isExtensionUrl(parsed.pathname);
    return false;
  } catch {
    return false;
  }
}
