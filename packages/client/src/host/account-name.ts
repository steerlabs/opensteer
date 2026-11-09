export function nextAccountName(engineName: string, takenNames: readonly string[]): string {
  const taken = new Set(takenNames);
  if (!taken.has(engineName)) return engineName;
  for (let index = 2; ; index += 1) {
    const candidate = `${engineName} ${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function accountDisplayName(input: {
  readonly name: string;
  readonly engineName: string;
  readonly accountLabel?: string | undefined;
}): string {
  const suffix = input.name.slice(input.engineName.length);
  return input.accountLabel !== undefined &&
    (input.name === input.engineName ||
      (input.name.startsWith(input.engineName) && /^ [0-9]+$/u.test(suffix)))
    ? input.accountLabel
    : input.name;
}
