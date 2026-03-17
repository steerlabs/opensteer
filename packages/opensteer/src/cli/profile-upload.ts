import { resolveCloudConfig } from "../cloud/config.js";
import { OpensteerCloudClient } from "../cloud/client.js";
import { parseCliArguments, profileCliSchema, renderHelp } from "./schema.js";

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

export function parseOpensteerProfileUploadArgs(argv: readonly string[]): ParsedProfileUploadArgs {
  try {
    const parsed = parseCliArguments({
      schema: profileCliSchema,
      programName: "opensteer profile",
      argv,
    });

    if (parsed.kind === "help") {
      return { mode: "help" };
    }

    if (parsed.invocation.commandId !== "profile.upload") {
      return {
        mode: "error",
        error: `Unsupported profile command "${parsed.invocation.commandId}".`,
      };
    }

    const options = parsed.invocation.options as {
      readonly json?: boolean;
      readonly profileId?: string;
      readonly fromUserDataDir?: string;
      readonly profileDirectory?: string;
    };

    if (!options.profileId) {
      return { mode: "error", error: "--profile-id is required." };
    }
    if (!options.fromUserDataDir) {
      return { mode: "error", error: "--from-user-data-dir is required." };
    }

    return {
      mode: "upload",
      json: options.json === true,
      profileId: options.profileId,
      fromUserDataDir: options.fromUserDataDir,
      ...(options.profileDirectory === undefined
        ? {}
        : { profileDirectory: options.profileDirectory }),
    };
  } catch (error) {
    return {
      mode: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
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
    deps.writeStdout(
      renderHelp({
        schema: profileCliSchema,
        programName: "opensteer profile",
      }),
    );
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
