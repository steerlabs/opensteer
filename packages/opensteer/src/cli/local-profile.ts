import { listLocalChromeProfiles } from "../local-browser/chrome-discovery.js";
import {
  inspectLocalBrowserProfile,
  OpensteerLocalProfileUnavailableError,
  unlockLocalBrowserProfile,
} from "../local-browser/profile-inspection.js";

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

const HELP_TEXT = `Usage: opensteer local-profile <command> [options]

Inspect local Chrome profiles for real-browser mode.

Commands:
  list                      List available local Chrome profiles
  inspect                   Inspect a local Chrome user-data-dir for launch ownership state
  unlock                    Remove stale Chrome singleton artifacts from a user-data-dir

Options:
  --json                    JSON output
  --user-data-dir <path>    Override Chrome user-data root
  -h, --help                Show this help
`;

export function parseOpensteerLocalProfileArgs(argv: readonly string[]): ParsedLocalProfileArgs {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    return { mode: "help" };
  }

  let json = false;
  let userDataDir: string | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!;
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return { mode: "help" };
    }
    if (argument === "--user-data-dir") {
      const value = rest[index + 1];
      if (!value) {
        return {
          mode: "error",
          error: "--user-data-dir requires a path value.",
        };
      }
      userDataDir = value;
      index += 1;
      continue;
    }

    return {
      mode: "error",
      error: `Unsupported option "${argument}" for "opensteer local-profile ${command}".`,
    };
  }

  if (command === "list") {
    return {
      mode: "list",
      json,
      ...(userDataDir === undefined ? {} : { userDataDir }),
    };
  }

  if (command === "inspect") {
    return {
      mode: "inspect",
      ...(userDataDir === undefined ? {} : { userDataDir }),
    };
  }

  if (command === "unlock") {
    if (userDataDir === undefined) {
      return {
        mode: "error",
        error: "--user-data-dir is required for unlock.",
      };
    }
    return {
      mode: "unlock",
      userDataDir,
    };
  }

  return {
    mode: "error",
    error: `Unsupported local-profile command "${command}".`,
  };
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
    deps.writeStdout(HELP_TEXT);
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
