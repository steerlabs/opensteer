import { pathExists, readJsonFile, writeJsonFileAtomic } from "../internal/filesystem.js";
import { resolveLocalViewPreferencesPath } from "./runtime-dir.js";

export const OPENSTEER_LOCAL_VIEW_PREFERENCES_LAYOUT = "opensteer-local-view-preferences";
export const OPENSTEER_LOCAL_VIEW_PREFERENCES_VERSION = 1;

export type OpensteerLocalViewMode = "auto" | "manual";

export interface PersistedLocalViewPreferences {
  readonly layout: typeof OPENSTEER_LOCAL_VIEW_PREFERENCES_LAYOUT;
  readonly version: typeof OPENSTEER_LOCAL_VIEW_PREFERENCES_VERSION;
  readonly mode: OpensteerLocalViewMode;
  readonly updatedAt: number;
}

export async function resolveLocalViewMode(): Promise<OpensteerLocalViewMode> {
  const preferences = await readLocalViewPreferences();
  return preferences?.mode ?? "auto";
}

export async function setLocalViewMode(
  mode: OpensteerLocalViewMode,
): Promise<PersistedLocalViewPreferences> {
  return writeLocalViewPreferences(mode);
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

function isPersistedLocalViewPreferences(
  value: Partial<PersistedLocalViewPreferences> | null | undefined,
): value is PersistedLocalViewPreferences {
  return (
    value?.layout === OPENSTEER_LOCAL_VIEW_PREFERENCES_LAYOUT &&
    value.version === OPENSTEER_LOCAL_VIEW_PREFERENCES_VERSION &&
    (value.mode === "auto" || value.mode === "manual") &&
    typeof value.updatedAt === "number" &&
    Number.isFinite(value.updatedAt)
  );
}
