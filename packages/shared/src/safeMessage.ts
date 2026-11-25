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
  const secrets = options.secrets ?? networkCredentialSecrets(process.env);
  let message = error instanceof Error && error.message ? error.message : options.fallback;
  message = redactNetworkCredentials(message, secrets);
  if (options.singleLine) message = message.replace(/[\r\n\0]+/gu, " ");
  for (const { pattern, replacement } of options.redactions ?? []) {
    message = message.replace(pattern, replacement);
  }
  return message.slice(0, maximumLength) || redactNetworkCredentials(options.fallback, secrets);
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

const proxyAddressNameSet: ReadonlySet<string> = new Set(proxyAddressNames);
const networkEnvironmentNameSet: ReadonlySet<string> = new Set(networkEnvironmentNames);

/** Names of environment variables whose values may appear in engine diagnostics. */
export const credentialNamePattern =
  /(?:AUTHORIZATION|COOKIE|TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|ACCESS_KEY|CREDENTIAL|PRIVATE_KEY|PROXY)/iu;

const opaqueCredentialNamePattern =
  /(?:AUTHORIZATION|COOKIE|TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|ACCESS_KEY|CREDENTIAL|PRIVATE_KEY)/iu;

const proxyAddressLikeNamePattern = /(?:^|_)PROXY$/iu;
const proxyBypassOrHostNamePattern = /^(?:NO_PROXY|(?:.*_)?PROXY_HOST)$/iu;

function isOpaqueNamedSecretVariable(name: string): boolean {
  if (networkEnvironmentNameSet.has(name) || proxyBypassOrHostNamePattern.test(name)) return false;
  return opaqueCredentialNamePattern.test(name);
}

export function networkCredentialSecrets(
  environment: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  const secrets = new Set<string>();
  function addSecret(secret: string, minimumLength = 1): void {
    if (secret.length < minimumLength) return;
    secrets.add(secret);
    try {
      const decoded = decodeURIComponent(secret);
      if (decoded.length >= minimumLength) secrets.add(decoded);
    } catch {
      // Invalid percent escapes can still appear literally in diagnostics.
    }
  }

  for (const [name, proxy] of Object.entries(environment)) {
    if (!proxy) continue;
    if (
      !proxyAddressNameSet.has(name) &&
      (proxyBypassOrHostNamePattern.test(name) || !proxyAddressLikeNamePattern.test(name))
    ) {
      continue;
    }
    const address = proxy.replace(/^[a-z][a-z0-9+.-]*:\/\//iu, "");
    const separator = address.lastIndexOf("@");
    if (separator <= 0) continue;
    const userinfo = address.slice(0, separator);
    const colon = userinfo.indexOf(":");
    if (colon < 0) continue;
    addSecret(userinfo);
    addSecret(userinfo.slice(colon + 1), 4);
  }

  return [...secrets].sort((left, right) => right.length - left.length);
}

export function engineDiagnosticSecrets(
  environment: Readonly<Record<string, string | undefined>>,
  minimumLength = 8,
): readonly string[] {
  const namedValues = Object.entries(environment)
    .filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" &&
        entry[1].length >= minimumLength &&
        isOpaqueNamedSecretVariable(entry[0]),
    )
    .map(([, value]) => value)
    .sort((left, right) => right.length - left.length);
  // Mask proxy userinfo first so diagnostics can still show the proxy endpoint.
  return [...new Set([...networkCredentialSecrets(environment), ...namedValues])];
}

/**
 * Non-empty opaque named credential values shorter than `minimumLength`
 * characters (too short to redact safely by literal substring replacement).
 * Network settings such as `NO_PROXY` and proxy hosts are never included.
 */
export function shortNamedSecrets(
  environment: Readonly<Record<string, string | undefined>>,
  minimumLength = 4,
): readonly string[] {
  return [
    ...new Set(
      Object.entries(environment)
        .filter(
          (entry): entry is [string, string] =>
            typeof entry[1] === "string" &&
            entry[1].length > 0 &&
            entry[1].length < minimumLength &&
            isOpaqueNamedSecretVariable(entry[0]),
        )
        .map(([, value]) => value),
    ),
  ].sort((left, right) => right.length - left.length);
}

// Both parts are bounded, so a long run of letters cannot make it backtrack
// for every position of a long message.
export const urlCredentialRedaction = Object.freeze({
  pattern: /([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/?#]{1,1024}@/giu,
  replacement: "$1[REDACTED]@",
});

export function redactNetworkCredentials(
  text: string,
  secrets: readonly string[] = networkCredentialSecrets(process.env),
): string {
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join("[REDACTED]");
  }
  return text.replace(urlCredentialRedaction.pattern, urlCredentialRedaction.replacement);
}

export function redactUrlCredentials(text: string): string {
  return redactNetworkCredentials(text, []);
}
