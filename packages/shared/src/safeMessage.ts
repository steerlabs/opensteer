/** Bounded error-message presentation. */

interface SafeMessageOptions {
  readonly fallback: string;
  readonly maximumLength?: number;
  readonly redactions?: readonly Readonly<{ pattern: RegExp; replacement: string }>[];
  readonly secrets?: readonly string[];
  readonly singleLine?: boolean;
}

export function safeMessage(error: unknown, options: SafeMessageOptions): string {
  const maximumLength = options.maximumLength ?? 2_000;
  let message = error instanceof Error && error.message ? error.message : options.fallback;
  if (options.secrets) message = redactNetworkCredentials(message, options.secrets);
  if (options.singleLine) message = message.replace(/[\r\n\0]+/gu, " ");
  for (const { pattern, replacement } of options.redactions ?? []) {
    message = message.replace(pattern, replacement);
  }
  return (
    message.slice(0, maximumLength) ||
    (options.secrets ? redactNetworkCredentials(options.fallback, options.secrets) : options.fallback)
  );
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
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;

const proxyAddressNames = [
  "ALL_PROXY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "all_proxy",
  "https_proxy",
  "http_proxy",
] as const;

export function networkCredentialSecrets(
  environment: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  const secrets = new Set<string>();
  function addSecret(secret: string): void {
    secrets.add(secret);
    try {
      secrets.add(decodeURIComponent(secret));
    } catch {
      // Invalid percent escapes can still appear literally in diagnostics.
    }
  }

  for (const name of proxyAddressNames) {
    const proxy = environment[name];
    if (!proxy) continue;
    const address = proxy.replace(/^[a-z][a-z0-9+.-]*:\/\//iu, "");
    const separator = address.lastIndexOf("@");
    if (separator <= 0) continue;
    const userinfo = address.slice(0, separator);
    addSecret(userinfo);
    const colon = userinfo.indexOf(":");
    if (colon >= 0) {
      const password = userinfo.slice(colon + 1);
      if (password.length >= 4) addSecret(password);
    }
  }

  return [...secrets].sort((left, right) => right.length - left.length);
}

// Both parts are bounded, so a long run of letters cannot make it backtrack
// for every position of a long message.
export const urlCredentialRedaction = Object.freeze({
  pattern: /([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/?#]{1,1024}@/giu,
  replacement: "$1[REDACTED]@",
});

export function redactNetworkCredentials(text: string, secrets: readonly string[]): string {
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join("[REDACTED]");
  }
  return text.replace(urlCredentialRedaction.pattern, urlCredentialRedaction.replacement);
}

export function redactUrlCredentials(text: string): string {
  return redactNetworkCredentials(text, []);
}
