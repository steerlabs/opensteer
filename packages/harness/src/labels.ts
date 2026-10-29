/** Sentence case for a provider word a driver hands straight to a reader. */
export function titleCase(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase()}${value.slice(1)}`;
}

/**
 * The protocol rejects a connection label longer than 200 characters, which
 * would otherwise degrade the whole profile to an error.
 */
export function clampConnectionLabel(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 200) : undefined;
}

/**
 * How a reasoning effort reads in the picker. `xhigh` is a compound word the
 * product spells out; every other effort is one word.
 */
export function reasoningEffortLabel(value: string): string {
  return value === "xhigh" ? "Extra high" : titleCase(value);
}
