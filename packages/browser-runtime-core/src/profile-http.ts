import { isIP } from "node:net";
import { readBoundedJson } from "@opensteer/shared/boundedJson";
import { maxBrowserProfileSnapshotBytes } from "@opensteer/browser-profile/snapshot";
export function safeProfileStateUrl(value: string, trustedHttpOrigin: string | undefined): URL {
  const url = new URL(value);
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    (isIP(url.hostname) === 6 && url.hostname.toLowerCase() === "0:0:0:0:0:0:0:1");
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && (loopback || url.origin === trustedHttpOrigin))) ||
    url.username ||
    url.password
  ) {
    throw new Error("Browser profile state URL is not a secure HTTP endpoint.");
  }
  return url;
}

export function safeTrustedHttpOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("The trusted browser profile state origin is invalid.");
  }
  return url.origin;
}

export function readProfileStateJson(response: Response): Promise<unknown> {
  return readBoundedJson(response, {
    invalidJsonError: (cause) =>
      new Error("Browser profile state response is not valid JSON.", { cause }),
    maximumBytes: maxBrowserProfileSnapshotBytes + 64 * 1_024,
    sizeError: () => new Error("Browser profile state response exceeds its byte limit."),
  });
}
