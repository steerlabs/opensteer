/**
 * Browser-routed fetch — executes HTTP requests through Chrome's native
 * network stack via {@link Page.evaluate} so that TLS fingerprint, HTTP/2
 * behaviour, Sec-Fetch-* headers, and connection reuse are identical to
 * the page's own JavaScript-initiated requests.
 *
 * The script is fully self-contained: it runs inside the page context,
 * performs the fetch, serialises the response, and returns the result in a
 * single evaluate call.  No persistent global state is stored on the page.
 */

import type { Page } from "playwright";
import type { SessionTransportRequest, HeaderEntry, BodyPayload } from "@opensteer/browser-core";
import { createHeaderEntry } from "@opensteer/browser-core";
import { captureBodyPayload } from "./normalize.js";

/** Serialisable request input injected into the page evaluate call. */
interface BrowserFetchInput {
  readonly url: string;
  readonly method: string;
  readonly headers: readonly [string, string][];
  readonly bodyBase64: string | undefined;
  readonly followRedirects: boolean;
  readonly timeoutMs: number | undefined;
}

/** Serialisable response returned from the page evaluate call. */
export interface BrowserFetchResult {
  readonly ok: true;
  readonly url: string;
  readonly status: number;
  readonly statusText: string;
  readonly headers: readonly [string, string][];
  readonly bodyBase64: string;
  readonly redirected: boolean;
}

interface BrowserFetchError {
  readonly ok: false;
  readonly name: string;
  readonly message: string;
}

/**
 * Execute a fetch request inside the browser page context so that the
 * request goes through Chrome's full network stack.
 *
 * Returns the raw serialised result.  Throws on network errors.
 */
export async function executeBrowserFetch(
  page: Page,
  request: SessionTransportRequest,
): Promise<BrowserFetchResult> {
  const input: BrowserFetchInput = {
    url: request.url,
    method: request.method,
    headers: (request.headers ?? []).map((h) => [h.name, h.value]),
    bodyBase64:
      request.body === undefined ? undefined : Buffer.from(request.body.bytes).toString("base64"),
    followRedirects: request.followRedirects !== false,
    timeoutMs: request.timeoutMs,
  };

  const result: BrowserFetchResult | BrowserFetchError = await page.evaluate(
    async (inp: BrowserFetchInput) => {
      // --- everything below runs inside Chrome's page context ---

      const decodeBase64 = (value: string): Uint8Array => {
        const binary = atob(value);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
      };

      const encodeBase64 = (bytes: Uint8Array): string => {
        let binary = "";
        const chunkSize = 0x8000;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          const chunk = bytes.subarray(offset, offset + chunkSize);
          binary += String.fromCharCode(...chunk);
        }
        return btoa(binary);
      };

      const headers = new Headers();
      for (const [name, value] of inp.headers) {
        headers.append(name, value);
      }

      const controller = new AbortController();
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      if (typeof inp.timeoutMs === "number") {
        timeoutId = setTimeout(
          () => controller.abort(new DOMException("Request timed out", "AbortError")),
          inp.timeoutMs,
        );
      }

      try {
        const requestBody = inp.bodyBase64 === undefined ? undefined : decodeBase64(inp.bodyBase64);
        const response = await fetch(inp.url, {
          method: inp.method,
          headers,
          credentials: "include",
          redirect: inp.followRedirects ? "follow" : "manual",
          signal: controller.signal,
          ...(requestBody === undefined ? {} : { body: requestBody }),
        });

        const body = new Uint8Array(await response.arrayBuffer());
        const responseHeaders: [string, string][] = [];
        response.headers.forEach((value: string, name: string) => {
          responseHeaders.push([name, value]);
        });

        return {
          ok: true as const,
          url: response.url,
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
          bodyBase64: encodeBase64(body),
          redirected: response.redirected,
        };
      } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        return {
          ok: false as const,
          name: err.name,
          message: err.message,
        };
      } finally {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
      }
    },
    input,
  );

  if (!result.ok) {
    const error = new Error(result.message);
    error.name = result.name;
    throw error;
  }

  return result;
}

/**
 * Convert a {@link BrowserFetchResult} into header entries and an optional
 * body payload, applying the same truncation and MIME-type parsing as the
 * rest of the engine.
 */
export function parseBrowserFetchResponse(
  result: BrowserFetchResult,
  bodyCaptureLimitBytes: number,
): {
  readonly headers: HeaderEntry[];
  readonly body: BodyPayload | undefined;
} {
  const headers = result.headers.map(([name, value]) => createHeaderEntry(name, value));
  const contentType = headers.find((h) => h.name.toLowerCase() === "content-type")?.value;

  let body: BodyPayload | undefined;
  try {
    const bytes = Buffer.from(result.bodyBase64, "base64");
    body = captureBodyPayload(bytes, contentType, bodyCaptureLimitBytes);
  } catch {
    body = undefined;
  }

  return { headers, body };
}
