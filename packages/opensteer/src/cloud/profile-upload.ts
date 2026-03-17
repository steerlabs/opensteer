import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { createBrowserProfileSnapshot } from "../local-browser/profile-clone.js";
import type { OpensteerCloudClient } from "./client.js";

const execFile = promisify(execFileCallback);
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_POLL_TIMEOUT_MS = 5 * 60_000;

export interface UploadLocalBrowserProfileInput {
  readonly profileId: string;
  readonly fromUserDataDir: string;
  readonly profileDirectory?: string;
}

export async function uploadLocalBrowserProfile(
  client: OpensteerCloudClient,
  input: UploadLocalBrowserProfileInput,
): Promise<Awaited<ReturnType<OpensteerCloudClient["getBrowserProfileImport"]>>> {
  const workDir = await mkdtemp(path.join(tmpdir(), "opensteer-profile-upload-"));
  const snapshotDir = path.join(workDir, "snapshot");
  const archivePath = path.join(workDir, "profile.tar.gz");

  try {
    await createBrowserProfileSnapshot({
      sourceUserDataDir: input.fromUserDataDir,
      targetUserDataDir: snapshotDir,
      ...(input.profileDirectory === undefined
        ? {}
        : { profileDirectory: input.profileDirectory }),
    });
    await execFile("tar", ["-czf", archivePath, "-C", snapshotDir, "."]);
    const archiveStat = await stat(archivePath);

    const created = await client.createBrowserProfileImport({
      profileId: input.profileId,
      archiveFormat: "tar.gz",
    });
    if (archiveStat.size > created.maxUploadBytes) {
      throw new Error(
        `Snapshot archive is ${String(archiveStat.size)} bytes, exceeding the ${String(created.maxUploadBytes)} byte upload limit.`,
      );
    }

    const archivePayload = await readFile(archivePath);
    const upload = await client.uploadBrowserProfileImportPayload({
      uploadUrl: created.uploadUrl,
      payload: archivePayload,
    });
    const finalized = await client.finalizeBrowserProfileImport(created.importId, {
      storageId: upload.storageId,
    });

    return finalized.status === "ready"
      ? finalized
      : waitForBrowserProfileImport(client, created.importId);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function waitForBrowserProfileImport(
  client: OpensteerCloudClient,
  importId: string,
): Promise<Awaited<ReturnType<OpensteerCloudClient["getBrowserProfileImport"]>>> {
  const deadline = Date.now() + DEFAULT_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = await client.getBrowserProfileImport(importId);
    if (current.status === "ready") {
      return current;
    }
    if (current.status === "failed") {
      throw new Error(current.error ?? "Browser profile import failed.");
    }
    await sleep(DEFAULT_POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for browser profile import "${importId}" to finish.`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

