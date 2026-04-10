import { readPersistedLocalBrowserSessionRecord } from "../live-session.js";
import { OpensteerBrowserManager } from "../browser-manager.js";
import {
  deleteLocalViewSessionManifest,
  readLocalViewSessionManifest,
} from "./session-manifest.js";

export class LocalViewSessionCloseError extends Error {
  constructor(
    message: string,
    readonly statusCode: 404 | 409,
  ) {
    super(message);
    this.name = "LocalViewSessionCloseError";
  }
}

export async function closeLocalViewSessionBrowser(sessionId: string): Promise<void> {
  const manifest = await readLocalViewSessionManifest(sessionId);
  if (!manifest) {
    throw new LocalViewSessionCloseError("Session not found.", 404);
  }

  if (manifest.ownership !== "owned") {
    throw new LocalViewSessionCloseError(
      "Only Opensteer-owned local browsers can be closed from the local view.",
      409,
    );
  }

  const record = await readPersistedLocalBrowserSessionRecord(manifest.rootPath);
  if (
    !record ||
    record.pid !== manifest.pid ||
    record.startedAt !== manifest.startedAt ||
    record.engine !== manifest.engine
  ) {
    await deleteLocalViewSessionManifest(sessionId).catch(() => undefined);
    throw new LocalViewSessionCloseError("Session not found.", 404);
  }

  const manager = new OpensteerBrowserManager({
    rootPath: manifest.rootPath,
    ...(manifest.workspace === undefined ? {} : { workspace: manifest.workspace }),
    engineName: record.engine,
    browser: "persistent",
  });
  await manager.close();
}
