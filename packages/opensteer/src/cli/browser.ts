import {
  discoverLocalCdpBrowsers,
  inspectCdpEndpoint,
} from "../local-browser/cdp-discovery.js";
import { browserCliSchema, parseCliArguments, renderHelp } from "./schema.js";

export interface BrowserCliDeps {
  readonly discoverBrowsers: typeof discoverLocalCdpBrowsers;
  readonly inspectBrowser: typeof inspectCdpEndpoint;
  readonly writeStdout: (message: string) => void;
  readonly writeStderr: (message: string) => void;
}

export type ParsedBrowserArgs =
  | { readonly mode: "help" }
  | { readonly mode: "error"; readonly error: string }
  | {
      readonly mode: "discover";
      readonly json: boolean;
      readonly timeoutMs?: number;
    }
  | {
      readonly mode: "inspect";
      readonly cdp: string;
      readonly json: boolean;
      readonly timeoutMs?: number;
    };

export function parseOpensteerBrowserArgs(argv: readonly string[]): ParsedBrowserArgs {
  try {
    const parsed = parseCliArguments({
      schema: browserCliSchema,
      programName: "opensteer browser",
      argv,
    });

    if (parsed.kind === "help") {
      return { mode: "help" };
    }

    const options = parsed.invocation.options as {
      readonly cdp?: string;
      readonly json?: boolean;
      readonly timeoutMs?: number;
    };

    switch (parsed.invocation.commandId) {
      case "browser.discover":
        return {
          mode: "discover",
          json: options.json === true,
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        };
      case "browser.inspect":
        if (options.cdp === undefined) {
          return {
            mode: "error",
            error: "--cdp is required for inspect.",
          };
        }
        return {
          mode: "inspect",
          cdp: options.cdp,
          json: options.json === true,
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        };
      default:
        return {
          mode: "error",
          error: `Unsupported browser command "${parsed.invocation.commandId}".`,
        };
    }
  } catch (error) {
    return {
      mode: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runOpensteerBrowserCli(
  argv: readonly string[],
  overrides: Partial<BrowserCliDeps> = {},
): Promise<number> {
  const deps: BrowserCliDeps = {
    discoverBrowsers: discoverLocalCdpBrowsers,
    inspectBrowser: inspectCdpEndpoint,
    writeStdout: (message) => process.stdout.write(message),
    writeStderr: (message) => process.stderr.write(message),
    ...overrides,
  };

  const parsed = parseOpensteerBrowserArgs(argv);
  if (parsed.mode === "help") {
    deps.writeStdout(
      renderHelp({
        schema: browserCliSchema,
        programName: "opensteer browser",
      }),
    );
    return 0;
  }

  if (parsed.mode === "error") {
    deps.writeStderr(`${parsed.error}\n`);
    return 1;
  }

  if (parsed.mode === "inspect") {
    const inspection = await deps.inspectBrowser({
      endpoint: parsed.cdp,
      ...(parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs }),
    });
    const payload = {
      ...inspection,
      attachHint: `opensteer open --browser cdp --cdp ${JSON.stringify(parsed.cdp)}`,
    };
    deps.writeStdout(parsed.json ? `${JSON.stringify(payload, null, 2)}\n` : `${JSON.stringify(payload)}\n`);
    return 0;
  }

  const browsers = await deps.discoverBrowsers({
    ...(parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs }),
  });
  if (parsed.json) {
    deps.writeStdout(`${JSON.stringify({ browsers }, null, 2)}\n`);
    return 0;
  }

  if (browsers.length === 0) {
    deps.writeStdout("No local CDP browsers found.\n");
    return 0;
  }

  for (const browser of browsers) {
    deps.writeStdout(
      `${browser.endpoint}\t${browser.source}\t${browser.browser ?? ""}\t${browser.userDataDir ?? ""}\n`,
    );
  }
  return 0;
}
