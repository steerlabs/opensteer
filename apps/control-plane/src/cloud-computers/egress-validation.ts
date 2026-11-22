/**
 * Egress upstream validation and normalisation mirroring
 * `packages/browser-runtime-core/src/browser-egress-upstream.ts` so the Account service stores and
 * serves only canonical `https://host:port` endpoints that the browser egress proxy and pool host's
 * `fetchSlotEgress` accept.
 */

export const MAXIMUM_EGRESS_URL_LENGTH = 1024;
export const MAXIMUM_EGRESS_CREDENTIAL_LENGTH = 1024;

const STRICT_HTTPS_HOST_PORT_RE = /^https:\/\/(?:\[[^\]]+\]|[^:/?#@\\\s]+):[0-9]+$/iu;
const AUTHORITY_WITH_OPTIONAL_PORT_RE = /^(\[[^\]]+\]|[^:/?#@\\\s]+)(?::([0-9]*))?$/u;

export type EgressValidationResult =
  { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: string };

export interface NormalizedEgressEndpoint {
  readonly url: string;
  readonly username: string;
  readonly password: string;
}

export type EgressEndpointNormalizationResult =
  | { readonly ok: true; readonly value: NormalizedEgressEndpoint }
  | { readonly ok: false; readonly reason: string };

export function validateEgressUpstreamUrl(value: string): EgressValidationResult {
  const text = value.trim();
  if (!text) {
    return { ok: false, reason: "The egress address must not be blank." };
  }
  if (!/^https:\/\//iu.test(text)) {
    return { ok: false, reason: "The egress address must use https://." };
  }
  if (text.includes("@")) {
    return { ok: false, reason: "The egress address must not include user info." };
  }
  if (text.includes("?") || text.includes("#")) {
    return { ok: false, reason: "The egress address must not include a query or fragment." };
  }
  if (text.includes("\\")) {
    return { ok: false, reason: "The egress address must not include a path or backslash." };
  }

  let authority = text.slice("https://".length);
  // Y6: strip at most one trailing '/' (e.g. https://proxy.example:8443/ -> https://proxy.example:8443).
  if (authority.endsWith("/")) {
    authority = authority.slice(0, -1);
  }
  if (!authority) {
    return { ok: false, reason: "The egress address is not a valid URL." };
  }
  if (authority.includes("/")) {
    return { ok: false, reason: "The egress address must not include a path." };
  }

  const authorityMatch = AUTHORITY_WITH_OPTIONAL_PORT_RE.exec(authority);
  if (!authorityMatch) {
    return {
      ok: false,
      reason:
        "The egress address must be https://host:port with a non-zero port and no path, query, fragment, or user info.",
    };
  }
  const hostPart = authorityMatch[1]!;
  const portPart = authorityMatch[2];
  let canonicalPort: string;
  if (portPart === undefined) {
    // Y6: fill explicit default HTTPS port so stored and served URLs match parseBrowserEgressUpstreamUrl.
    canonicalPort = "443";
  } else {
    if (!portPart) {
      return { ok: false, reason: "The egress address port must be between 1 and 65535." };
    }
    const portNum = Number(portPart);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65_535) {
      return { ok: false, reason: "The egress address port must be between 1 and 65535." };
    }
    canonicalPort = portPart;
  }

  const canonical = `https://${hostPart}:${canonicalPort}`;
  if (canonical.length > MAXIMUM_EGRESS_URL_LENGTH) {
    return {
      ok: false,
      reason: `The egress address must be at most ${MAXIMUM_EGRESS_URL_LENGTH} characters.`,
    };
  }
  const parsed = URL.parse(canonical);
  if (
    !parsed ||
    parsed.port === "0" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    return { ok: false, reason: "The egress address is not a valid URL." };
  }
  if (!STRICT_HTTPS_HOST_PORT_RE.test(canonical)) {
    return {
      ok: false,
      reason:
        "The egress address must be https://host:port with an explicit non-zero port and no path, query, fragment, or user info.",
    };
  }
  return { ok: true, value: canonical };
}

export function validateEgressCredential(
  value: string,
  kind: "username" | "password",
): EgressValidationResult {
  if (!value.trim()) {
    return { ok: false, reason: `The egress ${kind} must not be blank.` };
  }
  if (kind === "username" && value.includes(":")) {
    return { ok: false, reason: "The egress username must not contain ':'." };
  }
  if (value.length > MAXIMUM_EGRESS_CREDENTIAL_LENGTH) {
    return {
      ok: false,
      reason: `The egress ${kind} must be at most ${MAXIMUM_EGRESS_CREDENTIAL_LENGTH} characters.`,
    };
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      return { ok: false, reason: `The egress ${kind} must not contain control characters.` };
    }
  }
  return { ok: true, value };
}

export function normalizeEgressEndpoint(endpoint: {
  readonly url: string;
  readonly username: string;
  readonly password: string;
}): EgressEndpointNormalizationResult {
  const url = validateEgressUpstreamUrl(endpoint.url);
  if (!url.ok) return url;
  const username = validateEgressCredential(endpoint.username, "username");
  if (!username.ok) return username;
  const password = validateEgressCredential(endpoint.password, "password");
  if (!password.ok) return password;
  return {
    ok: true,
    value: {
      url: url.value,
      username: username.value,
      password: password.value,
    },
  };
}

export function egressEndpointInvalidReason(endpoint: {
  readonly url: string;
  readonly username: string;
  readonly password: string;
}): string | undefined {
  const normalized = normalizeEgressEndpoint(endpoint);
  return normalized.ok ? undefined : normalized.reason;
}
