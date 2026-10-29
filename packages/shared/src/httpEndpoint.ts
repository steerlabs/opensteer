/** A base address for an HTTP API whose paths are appended by its caller. */
export function parseHttpEndpointBaseUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    const authority = /^https?:\/\/([^/?#]*)/iu.exec(value)?.[1];
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !url.hostname ||
      !authority ||
      authority.includes("@") ||
      /[?#\\\s]/u.test(value)
    )
      return null;
    return url;
  } catch {
    return null;
  }
}
