import { pathExists, readJsonFile, writeJsonFileAtomic } from "../internal/filesystem.js";
import { isProcessRunning } from "../local-browser/process-owner.js";
import { resolveLocalViewServiceStatePath } from "./runtime-dir.js";

export const OPENSTEER_LOCAL_VIEW_SERVICE_LAYOUT = "opensteer-local-view-service";
export const OPENSTEER_LOCAL_VIEW_SERVICE_VERSION = 1;

export interface PersistedLocalViewServiceState {
  readonly layout: typeof OPENSTEER_LOCAL_VIEW_SERVICE_LAYOUT;
  readonly version: typeof OPENSTEER_LOCAL_VIEW_SERVICE_VERSION;
  readonly pid: number;
  readonly startedAt: number;
  readonly port: number;
  readonly token: string;
  readonly url: string;
}

export async function readLocalViewServiceState(): Promise<
  PersistedLocalViewServiceState | undefined
> {
  const statePath = resolveLocalViewServiceStatePath();
  if (!(await pathExists(statePath))) {
    return undefined;
  }

  const parsed = await readJsonFile<Partial<PersistedLocalViewServiceState>>(statePath);
  if (!isPersistedLocalViewServiceState(parsed)) {
    return undefined;
  }

  return parsed;
}

export async function writeLocalViewServiceState(
  state: PersistedLocalViewServiceState,
): Promise<void> {
  await writeJsonFileAtomic(resolveLocalViewServiceStatePath(), state);
}

export function isLocalViewServiceStateLive(
  state: PersistedLocalViewServiceState | undefined,
): state is PersistedLocalViewServiceState {
  return state !== undefined && isProcessRunning(state.pid);
}

function isPersistedLocalViewServiceState(
  value: Partial<PersistedLocalViewServiceState> | null | undefined,
): value is PersistedLocalViewServiceState {
  return (
    value?.layout === OPENSTEER_LOCAL_VIEW_SERVICE_LAYOUT &&
    value.version === OPENSTEER_LOCAL_VIEW_SERVICE_VERSION &&
    typeof value.pid === "number" &&
    Number.isFinite(value.pid) &&
    typeof value.startedAt === "number" &&
    Number.isFinite(value.startedAt) &&
    typeof value.port === "number" &&
    Number.isFinite(value.port) &&
    typeof value.token === "string" &&
    value.token.length > 0 &&
    typeof value.url === "string" &&
    value.url.length > 0
  );
}
