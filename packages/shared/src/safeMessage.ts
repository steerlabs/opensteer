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
