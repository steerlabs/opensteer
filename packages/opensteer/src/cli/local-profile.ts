import { listLocalChromeProfiles } from "../local-browser/chrome-discovery.js";
import {
  inspectLocalBrowserProfile,
  OpensteerLocalProfileUnavailableError,
  unlockLocalBrowserProfile,
} from "../local-browser/profile-inspection.js";
import { localProfileCliSchema, parseCliArguments, renderHelp } from "./schema.js";

export interface LocalProfileCliDeps {
  readonly inspectProfile: typeof inspectLocalBrowserProfile;
  readonly listProfiles: typeof listLocalChromeProfiles;
  readonly unlockProfile: typeof unlockLocalBrowserProfile;
  readonly writeStdout: (message: string) => void;
  readonly writeStderr: (message: string) => void;
}

export type ParsedLocalProfileArgs =
  | { readonly mode: "help" }
  | { readonly mode: "error"; readonly error: string }
  | {
      readonly mode: "list";
      readonly json: boolean;
      readonly userDataDir?: string;
    }
  | {
      readonly mode: "inspect";
      readonly userDataDir?: string;
    }
  | {
      readonly mode: "unlock";
      readonly userDataDir: string;
    };

export function parseOpensteerLocalProfileArgs(argv: readonly string[]): ParsedLocalProfileArgs {
  try {
    const parsed = parseCliArguments({
      schema: localProfileCliSchema,
      programName: "opensteer local-profile",
      argv,
    });

    if (parsed.kind === "help") {
      return { mode: "help" };
    }

    const options = parsed.invocation.options as {
      readonly json?: boolean;
      readonly userDataDir?: string;
    };

    switch (parsed.invocation.commandId) {
      case "local-profile.list":
        return {
          mode: "list",
          json: options.json === true,
          ...(options.userDataDir === undefined ? {} : { userDataDir: options.userDataDir }),
        };
      case "local-profile.inspect":
        return {
          mode: "inspect",
          ...(options.userDataDir === undefined ? {} : { userDataDir: options.userDataDir }),
        };
      case "local-profile.unlock":
        if (options.userDataDir === undefined) {
          return {
            mode: "error",
            error: "--user-data-dir is required for unlock.",
          };
        }
        return {
          mode: "unlock",
          userDataDir: options.userDataDir,
        };
      default:
        return {
          mode: "error",
          error: `Unsupported local-profile command "${parsed.invocation.commandId}".`,
        };
    }
  } catch (error) {
    return {
      mode: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runOpensteerLocalProfileCli(
  argv: readonly string[],
  overrides: Partial<LocalProfileCliDeps> = {},
): Promise<number> {
  const deps: LocalProfileCliDeps = {
    inspectProfile: inspectLocalBrowserProfile,
    listProfiles: listLocalChromeProfiles,
    unlockProfile: unlockLocalBrowserProfile,
    writeStdout: (message) => process.stdout.write(message),
    writeStderr: (message) => process.stderr.write(message),
    ...overrides,
  };

  const parsed = parseOpensteerLocalProfileArgs(argv);
  if (parsed.mode === "help") {
    deps.writeStdout(
      renderHelp({
        schema: localProfileCliSchema,
        programName: "opensteer local-profile",
      }),
    );
    return 0;
  }
  if (parsed.mode === "error") {
    deps.writeStderr(`${parsed.error}\n`);
    return 1;
  }

  if (parsed.mode === "inspect") {
    const inspection = await deps.inspectProfile({
      ...(parsed.userDataDir === undefined ? {} : { userDataDir: parsed.userDataDir }),
    });
    deps.writeStdout(JSON.stringify(inspection));
    return 0;
  }

  if (parsed.mode === "unlock") {
    try {
      const result = await deps.unlockProfile({
        userDataDir: parsed.userDataDir,
      });
      deps.writeStdout(JSON.stringify(result));
      return 0;
    } catch (error) {
      if (error instanceof OpensteerLocalProfileUnavailableError) {
        deps.writeStderr(
          `${JSON.stringify({
            error: {
              code: error.code,
              message: error.message,
              name: error.name,
              details: {
                inspection: error.inspection,
              },
            },
          })}\n`,
        );
        return 1;
      }
      throw error;
    }
  }

  const profiles = deps.listProfiles(parsed.userDataDir);
  if (parsed.json) {
    deps.writeStdout(JSON.stringify({ profiles }, null, 2));
    return 0;
  }

  if (profiles.length === 0) {
    deps.writeStdout("No local Chrome profiles found.\n");
    return 0;
  }

  for (const profile of profiles) {
    deps.writeStdout(`${profile.directory}\t${profile.name}\t${profile.userDataDir}\n`);
  }
  return 0;
}
