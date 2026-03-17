import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { resolveCloudConfig } from "../cloud/config.js";
import { OpensteerCloudClient } from "../cloud/client.js";
import { createBrowserProfileSnapshot } from "../local-browser/profile-clone.js";

const execFile = promisify(execFileCallback);
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_POLL_TIMEOUT_MS = 5 * 60_000;

export interface ProfileUploadCliDeps {
  readonly writeStdout: (message: string) => void;
  readonly writeStderr: (message: string) => void;
}

export type ParsedProfileUploadArgs =
  | { readonly mode: "help" }
  | { readonly mode: "error"; readonly error: string }
  | {
      readonly mode: "upload";
      readonly json: boolean;
      readonly profileId: string;
      readonly fromUserDataDir: string;
      readonly profileDirectory?: string;
    };

const HELP_TEXT = `Usage: opensteer profile upload [options]

Snapshot a local Chrome profile and upload it into an existing OpenSteer cloud browser profile.

Options:
  --profile-id <id>                 Destination cloud browser profile ID
  --from-user-data-dir <path>       Source Chrome user-data root
  --profile-directory <name>        Source Chrome profile directory (for example "Default")
  --json                            JSON output
  -h, --help                        Show this help
`;

export function parseOpensteerProfileUploadArgs(
  argv: readonly string[],
): ParsedProfileUploadArgs {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    return { mode: "help" };
  }

  if (command !== "upload") {
    return {
      mode: "error",
      error: `Unsupported profile command "${command}".`,
    };
  }

  let json = false;
  let profileId: string | undefined;
  let fromUserDataDir: string | undefined;
  let profileDirectory: string | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!;
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return { mode: "help" };
    }
    if (argument === "--profile-id") {
      const value = rest[index + 1];
      if (!value) {
        return { mode: "error", error: "--profile-id requires a value." };
      }
      profileId = value;
      index += 1;
      continue;
    }
    if (argument === "--from-user-data-dir") {
      const value = rest[index + 1];
      if (!value) {
        return { mode: "error", error: "--from-user-data-dir requires a path value." };
      }
      fromUserDataDir = value;
      index += 1;
      continue;
    }
    if (argument === "--profile-directory") {
      const value = rest[index + 1];
      if (!value) {
        return { mode: "error", error: "--profile-directory requires a value." };
      }
      profileDirectory = value;
      index += 1;
      continue;
    }

    return {
      mode: "error",
      error: `Unsupported option "${argument}" for "opensteer profile upload".`,
    };
  }

  if (!profileId) {
    return { mode: "error", error: "--profile-id is required." };
  }
  if (!fromUserDataDir) {
    return { mode: "error", error: "--from-user-data-dir is required." };
  }

  return {
    mode: "upload",
    json,
    profileId,
    fromUserDataDir,
    ...(profileDirectory === undefined ? {} : { profileDirectory }),
  };
}

export async function runOpensteerProfileUploadCli(
  argv: readonly string[],
  overrides: Partial<ProfileUploadCliDeps> = {},
): Promise<number> {
  const deps: ProfileUploadCliDeps = {
    writeStdout: (message) => process.stdout.write(message),
    writeStderr: (message) => process.stderr.write(message),
    ...overrides,
  };
  const parsed = parseOpensteerProfileUploadArgs(argv);
  if (parsed.mode === "help") {
    deps.writeStdout(HELP_TEXT);
    return 0;
  }
  if (parsed.mode === "error") {
    deps.writeStderr(`${parsed.error}\n`);
    return 1;
  }

  const cloud = resolveCloudConfig({
    enabled: true,
    mode: "cloud",
  });
  if (!cloud) {
    deps.writeStderr("Cloud mode is required for profile upload.\n");
    return 1;
  }

  const client = new OpensteerCloudClient(cloud);
  const workDir = await mkdtemp(path.join(tmpdir(), "opensteer-profile-upload-"));
  const snapshotDir = path.join(workDir, "snapshot");
  const archivePath = path.join(workDir, "profile.tar.gz");

  try {
    await createBrowserProfileSnapshot({
      sourceUserDataDir: parsed.fromUserDataDir,
      targetUserDataDir: snapshotDir,
      ...(parsed.profileDirectory === undefined
        ? {}
        : { profileDirectory: parsed.profileDirectory }),
    });
    await execFile("tar", ["-czf", archivePath, "-C", snapshotDir, "."]);
    const archiveStat = await stat(archivePath);

    const created = await client.createBrowserProfileImport({
      profileId: parsed.profileId,
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
    const result =
      finalized.status === "ready"
        ? finalized
        : await waitForBrowserProfileImport(client, created.importId);

    if (parsed.json) {
      deps.writeStdout(JSON.stringify(result, null, 2));
      return 0;
    }

    deps.writeStdout(
      `Uploaded ${parsed.profileId} revision ${String(result.revision ?? "unknown")} from ${parsed.fromUserDataDir}.\n`,
    );
    return 0;
  } catch (error) {
    deps.writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
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
