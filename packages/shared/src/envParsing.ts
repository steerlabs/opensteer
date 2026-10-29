/** Environment-value normalization. */

export function optionalEnvironmentValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

export function requiredEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  message = `${name} is required.`,
): string {
  const value = optionalEnvironmentValue(environment[name]);
  if (!value) throw new Error(message);
  return value;
}

export function requiredStringValue(
  value: string | undefined,
  label: string,
  message = `${label} is required.`,
): string {
  const normalized = optionalEnvironmentValue(value);
  if (!normalized) throw new Error(message);
  return normalized;
}
