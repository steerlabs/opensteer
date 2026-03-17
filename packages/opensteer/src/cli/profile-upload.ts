import { resolveCloudConfig } from "../cloud/config.js";
import { OpensteerCloudClient } from "../cloud/client.js";

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

  try {
    const result = await client.uploadLocalBrowserProfile({
      profileId: parsed.profileId,
      fromUserDataDir: parsed.fromUserDataDir,
      ...(parsed.profileDirectory === undefined
        ? {}
        : { profileDirectory: parsed.profileDirectory }),
    });

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
  }
}
