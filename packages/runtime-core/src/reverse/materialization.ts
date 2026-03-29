import type { BodyPayload, HeaderEntry } from "@opensteer/browser-core";
import type { TransportKind } from "@opensteer/protocol";

import { isValidHttpHeaderName, normalizeHeaderName } from "../requests/shared.js";

const ALWAYS_OMIT_HEADER_NAMES = new Set(["content-length", "host", "priority"]);

const BROWSER_OWNED_HEADER_PREFIXES = ["sec-"];

export interface MaterializedTransportRequest {
  readonly method: string;
  readonly url: string;
  readonly headers?: readonly HeaderEntry[];
  readonly body?: BodyPayload;
  readonly followRedirects?: boolean;
}

export function isManagedRequestHeaderName(name: string, transport?: TransportKind): boolean {
  const normalized = normalizeHeaderName(name);
  if (!isValidHttpHeaderName(name)) {
    return true;
  }
  if (normalized.startsWith(":")) {
    return true;
  }
  if (ALWAYS_OMIT_HEADER_NAMES.has(normalized)) {
    return true;
  }
  if (transport !== undefined && (transport === "page-http" || transport === "session-http")) {
    if (BROWSER_OWNED_HEADER_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
      return true;
    }
  }
  return false;
}

export function stripManagedRequestHeaders(
  headers: readonly HeaderEntry[] | undefined,
  transport?: TransportKind,
): HeaderEntry[] | undefined {
  if (headers === undefined || headers.length === 0) {
    return undefined;
  }

  const filtered = headers.filter((header) => !isManagedRequestHeaderName(header.name, transport));
  return filtered.length === 0 ? undefined : filtered.map((header) => ({ ...header }));
}

export function finalizeMaterializedTransportRequest(
  request: MaterializedTransportRequest,
  transport: TransportKind,
): MaterializedTransportRequest {
  const headers = stripManagedRequestHeaders(request.headers, transport);
  return {
    ...request,
    ...(headers === undefined ? {} : { headers }),
  };
}
