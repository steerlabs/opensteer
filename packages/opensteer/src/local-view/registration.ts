import type { PersistedLocalBrowserSessionRecord } from "../live-session.js";
import { resolveLocalViewMode } from "./preferences.js";
import { ensureLocalViewServiceRunning } from "./service.js";
import {
  createLocalViewSessionManifest,
  deleteLocalViewSessionManifest,
  type PersistedLocalViewSessionManifest,
  writeLocalViewSessionManifest,
} from "./session-manifest.js";

export async function bestEffortRegisterLocalViewSession(input: {
  readonly rootPath: string;
  readonly workspace?: string;
  readonly live: PersistedLocalBrowserSessionRecord;
  readonly ownership: "owned" | "attached" | "managed";
}): Promise<PersistedLocalViewSessionManifest | undefined> {
  try {
    const manifest = createLocalViewSessionManifest(input);
    await writeLocalViewSessionManifest(manifest);
    if ((await resolveLocalViewMode()) === "auto") {
      void ensureLocalViewServiceRunning().catch(() => undefined);
    }
    return manifest;
  } catch {
    return undefined;
  }
}

export async function bestEffortUnregisterLocalViewSession(
  sessionId: string | undefined,
): Promise<void> {
  if (!sessionId) {
    return;
  }
  await deleteLocalViewSessionManifest(sessionId).catch(() => undefined);
}
