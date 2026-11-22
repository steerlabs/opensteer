/**
 * Egress upstream validation mirroring `packages/browser-runtime-core/src/browser-egress-upstream.ts`
 * so the Account service never accepts or stores an endpoint that the browser egress proxy or
 * pool host's `fetchSlotEgress` would refuse.
 */

export const MAXIMUM_EGRESS_URL_LENGTH = 1024;
export const MAXIMUM_EGRESS_CREDENTIAL_LENGTH = 1024;

const STRICT_HTTPS_HOST_PORT_RE = /^https:\/\/(?:\[[^\]]+\]|[^:/?#@\\\s]+):[0-9]+$/iu;

export type EgressValidationResult =
  { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: string };

export function validateEgressUpstreamUrl(value: string): EgressValidationResult {
  const text = value.trim();
  if (!text) {
    return { ok: false, reason: "The egress address must not be blank." };
  }
  if (text.length > MAXIMUM_EGRESS_URL_LENGTH) {
    return {
      ok: false,
      reason: `The egress address must be at most ${MAXIMUM_EGRESS_URL_LENGTH} characters.`,
    };
  }
  if (!/^https:\/\//iu.test(text)) {
    return { ok: false, reason: "The egress address must use https://." };
  }
  const parsed = URL.parse(text);
  if (!parsed) {
    return { ok: false, reason: "The egress address is not a valid URL." };
  }
  if (parsed.username || parsed.password || text.includes("@")) {
    return { ok: false, reason: "The egress address must not include user info." };
  }
  if (parsed.search || parsed.hash || text.includes("?") || text.includes("#")) {
    return { ok: false, reason: "The egress address must not include a query or fragment." };
  }
  const afterScheme = text.slice("https://".length);
  if (afterScheme.includes("/") || afterScheme.includes("\\")) {
    return { ok: false, reason: "The egress address must not include a path or trailing slash." };
  }
  if (!/:[0-9]+$/u.test(afterScheme)) {
    return {
      ok: false,
      reason: "The egress address needs an explicit port (for example https://proxy.example:8443).",
    };
  }
  if (parsed.port === "0") {
    return { ok: false, reason: "The egress address port must be between 1 and 65535." };
  }
  if (!STRICT_HTTPS_HOST_PORT_RE.test(text)) {
    return {
      ok: false,
      reason:
        "The egress address must be https://host:port with an explicit non-zero port and no path, query, fragment, or user info.",
    };
  }
  return { ok: true, value: text };
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

export function egressEndpointInvalidReason(endpoint: {
  readonly url: string;
  readonly username: string;
  readonly password: string;
}): string | undefined {
  const url = validateEgressUpstreamUrl(endpoint.url);
  if (!url.ok) return url.reason;
  const username = validateEgressCredential(endpoint.username, "username");
  if (!username.ok) return username.reason;
  const password = validateEgressCredential(endpoint.password, "password");
  if (!password.ok) return password.reason;
  return undefined;
}
