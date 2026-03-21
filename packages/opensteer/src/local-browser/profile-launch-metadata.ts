import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  CURRENT_PROCESS_OWNER,
  getProcessLiveness,
  parseProcessOwner,
  processOwnersEqual,
  type ProcessOwner,
} from "./process-owner.js";
import { withDirLock } from "./dir-lock.js";
import type { LaunchMetadataRecord } from "./types.js";

export async function readProfileLaunchMetadata(
  userDataDir: string,
): Promise<LaunchMetadataRecord | null> {
  try {
    const raw = JSON.parse(
      await readFile(getProfileLaunchMetadataPath(userDataDir), "utf8"),
    ) as Partial<LaunchMetadataRecord>;
    const owner = parseProcessOwner(raw.owner);
    return {
      args: Array.isArray(raw.args)
        ? raw.args.filter((entry): entry is string => typeof entry === "string")
        : [],
      executablePath: typeof raw.executablePath === "string" ? raw.executablePath : "",
      headless: raw.headless === true,
      owner: owner ?? undefined,
      ...(typeof raw.profileDirectory === "string"
        ? { profileDirectory: raw.profileDirectory }
        : {}),
      userDataDir: typeof raw.userDataDir === "string" ? raw.userDataDir : resolve(userDataDir),
    };
  } catch {
    return null;
  }
}

export async function readLiveProfileLaunchMetadata(userDataDir: string): Promise<
  | {
      readonly launchMetadata: LaunchMetadataRecord;
      readonly owner: ProcessOwner | undefined;
    }
  | undefined
> {
  const launchMetadata = await readProfileLaunchMetadata(userDataDir);
  if (!launchMetadata?.owner) {
    return undefined;
  }

  if ((await getProcessLiveness(launchMetadata.owner)) !== "live") {
    return undefined;
  }

  return {
    launchMetadata,
    owner: launchMetadata.owner,
  };
}

export async function registerProfileLaunch(
  input: Omit<LaunchMetadataRecord, "owner">,
): Promise<() => Promise<void>> {
  await withProfileLaunchLock(input.userDataDir, async () => {
    await mkdir(getProfileLaunchMetadataDir(input.userDataDir), { recursive: true });
    await writeFile(
      getProfileLaunchMetadataPath(input.userDataDir),
      JSON.stringify({
        ...input,
        owner: CURRENT_PROCESS_OWNER,
      } satisfies LaunchMetadataRecord),
    );
  });

  return async () => {
    await withProfileLaunchLock(input.userDataDir, async () => {
      const metadata = await readProfileLaunchMetadata(input.userDataDir);
      if (!metadata?.owner || !processOwnersEqual(metadata.owner, CURRENT_PROCESS_OWNER)) {
        return;
      }
      await rm(getProfileLaunchMetadataPath(input.userDataDir), { force: true }).catch(
        () => undefined,
      );
    });
  };
}

export async function withProfileLaunchLock<T>(
  userDataDir: string,
  action: () => Promise<T>,
): Promise<T> {
  return withDirLock(getProfileLaunchLockPath(userDataDir), action);
}

export function getProfileLaunchMetadataDir(userDataDir: string): string {
  return join(
    homedir(),
    ".opensteer",
    "local-browser",
    "launches",
    buildProfileLaunchKey(userDataDir),
  );
}

export function getProfileLaunchMetadataPath(userDataDir: string): string {
  return join(getProfileLaunchMetadataDir(userDataDir), "launch.json");
}

function getProfileLaunchLockPath(userDataDir: string): string {
  return join(getProfileLaunchMetadataDir(userDataDir), "lock");
}

function buildProfileLaunchKey(userDataDir: string): string {
  return createHash("sha256").update(resolve(userDataDir)).digest("hex").slice(0, 16);
}
