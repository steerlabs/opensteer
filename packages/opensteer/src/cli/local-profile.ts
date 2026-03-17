import { listLocalChromeProfiles } from "../local-browser/chrome-discovery.js";

export interface LocalProfileCliDeps {
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
    };

const HELP_TEXT = `Usage: opensteer local-profile <command> [options]

Inspect local Chrome profiles for real-browser mode.

Commands:
  list                      List available local Chrome profiles

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

  if (command !== "list") {
    return {
      mode: "error",
      error: `Unsupported local-profile command "${command}".`,
    };
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
      error: `Unsupported option "${argument}" for "opensteer local-profile list".`,
    };
  }

  return {
    mode: "list",
    json,
    ...(userDataDir === undefined ? {} : { userDataDir }),
  };
}

export async function runOpensteerLocalProfileCli(
  argv: readonly string[],
  overrides: Partial<LocalProfileCliDeps> = {},
): Promise<number> {
  const deps: LocalProfileCliDeps = {
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

  const profiles = listLocalChromeProfiles(parsed.userDataDir);
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
