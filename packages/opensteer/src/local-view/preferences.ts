import { pathExists, readJsonFile, writeJsonFileAtomic } from "../internal/filesystem.js";
import { resolveLocalViewPreferencesPath } from "./runtime-dir.js";

export const OPENSTEER_LOCAL_VIEW_PREFERENCES_LAYOUT = "opensteer-local-view-preferences";
export const OPENSTEER_LOCAL_VIEW_PREFERENCES_VERSION = 1;

export type OpensteerLocalViewMode = "auto" | "manual" | "disabled";

export interface PersistedLocalViewPreferences {
  readonly layout: typeof OPENSTEER_LOCAL_VIEW_PREFERENCES_LAYOUT;
  readonly version: typeof OPENSTEER_LOCAL_VIEW_PREFERENCES_VERSION;
  readonly mode: OpensteerLocalViewMode;
  readonly updatedAt: number;
}

export async function resolveLocalViewMode(): Promise<OpensteerLocalViewMode> {
  const environmentMode = parseEnvironmentLocalViewMode(process.env.OPENSTEER_LOCAL_VIEW);
  if (environmentMode !== undefined) {
    return environmentMode;
  }

  const preferences = await readLocalViewPreferences();
  return preferences?.mode ?? "auto";
}

export async function enableLocalViewPreference(): Promise<PersistedLocalViewPreferences> {
  return writeLocalViewPreferences("auto");
}

export async function disableLocalViewPreference(): Promise<PersistedLocalViewPreferences> {
  return writeLocalViewPreferences("disabled");
}

export async function readLocalViewPreferences(): Promise<
  PersistedLocalViewPreferences | undefined
> {
  const preferencesPath = resolveLocalViewPreferencesPath();
  if (!(await pathExists(preferencesPath))) {
    return undefined;
  }

  const parsed = await readJsonFile<Partial<PersistedLocalViewPreferences>>(preferencesPath);
  return isPersistedLocalViewPreferences(parsed) ? parsed : undefined;
}

async function writeLocalViewPreferences(
  mode: OpensteerLocalViewMode,
): Promise<PersistedLocalViewPreferences> {
  const preferences: PersistedLocalViewPreferences = {
    layout: OPENSTEER_LOCAL_VIEW_PREFERENCES_LAYOUT,
    version: OPENSTEER_LOCAL_VIEW_PREFERENCES_VERSION,
    mode,
    updatedAt: Date.now(),
  };
  await writeJsonFileAtomic(resolveLocalViewPreferencesPath(), preferences);
  return preferences;
}

function parseEnvironmentLocalViewMode(
  value: string | undefined,
): OpensteerLocalViewMode | undefined {
  const mode = value?.trim().toLowerCase();
  if (!mode) {
    return undefined;
  }

  if (mode === "manual" || mode === "0" || mode === "false" || mode === "off") {
    return "manual";
  }

  if (mode === "disabled" || mode === "disable" || mode === "none") {
    return "disabled";
  }

  if (mode === "auto" || mode === "1" || mode === "true" || mode === "on" || mode === "enabled") {
    return "auto";
  }

  return undefined;
}

function isPersistedLocalViewPreferences(
  value: Partial<PersistedLocalViewPreferences> | null | undefined,
): value is PersistedLocalViewPreferences {
  return (
    value?.layout === OPENSTEER_LOCAL_VIEW_PREFERENCES_LAYOUT &&
    value.version === OPENSTEER_LOCAL_VIEW_PREFERENCES_VERSION &&
    (value.mode === "auto" || value.mode === "manual" || value.mode === "disabled") &&
    typeof value.updatedAt === "number" &&
    Number.isFinite(value.updatedAt)
  );
}
