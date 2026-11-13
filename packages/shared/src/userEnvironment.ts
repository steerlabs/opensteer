/**
 * The Windows variables every environment boundary keeps: without them a
 * child cannot find the shell, system DLLs, temporary space, its profile or
 * the person's package-manager installs. Installation locations only; never
 * credentials or loader settings.
 */
export const windowsBaselineVariableNames = [
  "SystemRoot",
  "SystemDrive",
  "WINDIR",
  "ComSpec",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "USERNAME",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "ProgramData",
  "PNPM_HOME",
  "VOLTA_HOME",
  "PATH",
] as const;

/**
 * The named variables that are set in `source`, plus the Windows baseline on
 * win32. Windows names match case-insensitively and come out spelled as named.
 */
export function selectEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  names: Iterable<string>,
  platform: NodeJS.Platform,
): Record<string, string> {
  const selected: Record<string, string> = {};
  if (platform !== "win32") {
    for (const name of names) {
      const value = source[name];
      if (value) selected[name] = value;
    }
    return selected;
  }
  const values = caseInsensitiveValues(source);
  const chosen = new Map<string, string>();
  for (const name of [...names, ...windowsBaselineVariableNames]) {
    if (!chosen.has(name.toUpperCase())) chosen.set(name.toUpperCase(), name);
  }
  for (const [key, name] of chosen) {
    const value = values.get(key);
    if (value) selected[name] = value;
  }
  return selected;
}

/**
 * `overrides` laid over `base`. On win32 a name is one variable whatever its
 * case, so exactly one spelling survives: the override's, else the last one.
 */
export function mergeEnvironment(
  base: Readonly<Record<string, string>>,
  overrides: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
): Record<string, string> {
  if (platform !== "win32") return { ...base, ...overrides };
  const merged = new Map<string, readonly [string, string]>();
  for (const entry of [...Object.entries(base), ...Object.entries(overrides)]) {
    merged.set(entry[0].toUpperCase(), entry);
  }
  return Object.fromEntries(merged.values());
}

function caseInsensitiveValues(
  source: Readonly<Record<string, string | undefined>>,
): Map<string, string> {
  const values = new Map<string, string>();
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined) values.set(name.toUpperCase(), value);
  }
  return values;
}
