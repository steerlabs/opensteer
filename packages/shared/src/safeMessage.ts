/** Bounded error-message presentation. */

interface SafeMessageOptions {
  readonly fallback: string;
  readonly maximumLength?: number;
  readonly redactions?: readonly Readonly<{ pattern: RegExp; replacement: string }>[];
  readonly singleLine?: boolean;
}

export function safeMessage(error: unknown, options: SafeMessageOptions): string {
  const maximumLength = options.maximumLength ?? 2_000;
  let message = error instanceof Error && error.message ? error.message : options.fallback;
  if (options.singleLine) message = message.replace(/[\r\n\0]+/gu, " ");
  for (const { pattern, replacement } of options.redactions ?? []) {
    message = message.replace(pattern, replacement);
  }
  return message.slice(0, maximumLength) || options.fallback;
}

/**
 * The names that tell an engine how to reach the network: a proxy and the
 * certificates it trusts. They come from the person's login shell so an engine
 * works behind a company proxy as it does in their own terminal.
 */
export const networkEnvironmentNames = [
  "ALL_PROXY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
] as const;

/**
 * A URL's user and password, which a proxy address can carry. Every message an
 * engine's error, a log line or a Run's failure can show passes this first.
 */
// Both parts are bounded, so a long run of letters cannot make it backtrack
// for every position of a long message.
export const urlCredentialRedaction = Object.freeze({
  pattern: /([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@]{1,1024}@/giu,
  replacement: "$1[REDACTED]@",
});

export function redactUrlCredentials(text: string): string {
  return text.replace(urlCredentialRedaction.pattern, urlCredentialRedaction.replacement);
}
