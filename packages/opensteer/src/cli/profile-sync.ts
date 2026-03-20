import { createInterface } from "node:readline/promises";

import { resolveCloudConfig } from "../cloud/config.js";
import { OpensteerCloudClient } from "../cloud/client.js";
import { normalizeCookieDomain } from "../cloud/cookie-sync.js";
import type { BrowserBrandId } from "../local-browser/browser-brands.js";
import {
  resolveCookieCaptureStrategy,
  type CookieCaptureStrategy,
} from "../local-browser/cookie-capture.js";
import { parseCliArguments, profileCliSchema, renderHelp } from "./schema.js";

export interface ProfileSyncCliDeps {
  readonly writeStdout: (message: string) => void;
  readonly writeStderr: (message: string) => void;
}

export type ParsedProfileSyncArgs =
  | { readonly mode: "help" }
  | { readonly mode: "error"; readonly error: string }
  | {
      readonly mode: "sync";
      readonly allDomains: boolean;
      readonly attachEndpoint?: string;
      readonly brandId?: BrowserBrandId;
      readonly userDataDir?: string;
      readonly profileDirectory?: string;
      readonly executablePath?: string;
      readonly strategy?: CookieCaptureStrategy;
      readonly restoreBrowser: boolean;
      readonly dryRun: boolean;
      readonly domains: readonly string[];
      readonly yes: boolean;
      readonly json: boolean;
      readonly profileId: string;
      readonly timeoutMs?: number;
    };

export function parseOpensteerProfileSyncArgs(argv: readonly string[]): ParsedProfileSyncArgs {
  try {
    const parsed = parseCliArguments({
      schema: profileCliSchema,
      programName: "opensteer profile",
      argv,
    });

    if (parsed.kind === "help") {
      return { mode: "help" };
    }

    if (parsed.invocation.commandId !== "profile.sync") {
      return {
        mode: "error",
        error: `Unsupported profile command "${parsed.invocation.commandId}".`,
      };
    }

    const options = parsed.invocation.options as {
      readonly allDomains?: boolean;
      readonly attachEndpoint?: string;
      readonly brandId?: BrowserBrandId;
      readonly domain?: readonly string[];
      readonly dryRun?: boolean;
      readonly executablePath?: string;
      readonly json?: boolean;
      readonly restoreBrowser?: boolean;
      readonly noRestoreBrowser?: boolean;
      readonly profileDirectory?: string;
      readonly profileId?: string;
      readonly strategy?: "auto" | CookieCaptureStrategy;
      readonly timeoutMs?: number;
      readonly userDataDir?: string;
      readonly yes?: boolean;
    };

    if (!options.profileId) {
      return { mode: "error", error: "--profile-id is required." };
    }

    return {
      mode: "sync",
      allDomains: options.allDomains === true,
      ...(options.attachEndpoint === undefined ? {} : { attachEndpoint: options.attachEndpoint }),
      ...(options.brandId === undefined ? {} : { brandId: options.brandId }),
      ...(options.userDataDir === undefined ? {} : { userDataDir: options.userDataDir }),
      ...(options.profileDirectory === undefined
        ? {}
        : { profileDirectory: options.profileDirectory }),
      ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
      ...(options.strategy === undefined || options.strategy === "auto"
        ? {}
        : { strategy: options.strategy }),
      restoreBrowser: options.restoreBrowser !== false && options.noRestoreBrowser !== true,
      dryRun: options.dryRun === true,
      domains: [...new Set((options.domain ?? []).map(normalizeCookieDomain).filter(Boolean))],
      yes: options.yes === true,
      json: options.json === true,
      profileId: options.profileId,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    };
  } catch (error) {
    return {
      mode: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runOpensteerProfileSyncCli(
  argv: readonly string[],
  overrides: Partial<ProfileSyncCliDeps> = {},
): Promise<number> {
  const deps: ProfileSyncCliDeps = {
    writeStdout: (message) => process.stdout.write(message),
    writeStderr: (message) => process.stderr.write(message),
    ...overrides,
  };
  const parsed = parseOpensteerProfileSyncArgs(argv);
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

  const nonInteractive = !process.stdin.isTTY || !process.stdout.isTTY;
  const hasExplicitScope = parsed.allDomains || parsed.domains.length > 0;
  if (!parsed.dryRun && nonInteractive && !hasExplicitScope) {
    deps.writeStderr(
      "Non-interactive profile sync requires explicit scope: --domain <domain> (repeatable) or --all-domains.\n",
    );
    return 1;
  }

  let capturePlan: Awaited<ReturnType<typeof resolveCookieCaptureStrategy>>;
  try {
    capturePlan = await resolveCookieCaptureStrategy({
      ...(parsed.attachEndpoint === undefined ? {} : { attachEndpoint: parsed.attachEndpoint }),
      ...(parsed.brandId === undefined ? {} : { brandId: parsed.brandId }),
      ...(parsed.userDataDir === undefined ? {} : { userDataDir: parsed.userDataDir }),
      ...(parsed.profileDirectory === undefined
        ? {}
        : { profileDirectory: parsed.profileDirectory }),
      ...(parsed.executablePath === undefined ? {} : { executablePath: parsed.executablePath }),
      ...(parsed.strategy === undefined ? {} : { strategy: parsed.strategy }),
      ...(parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs }),
    });
  } catch (error) {
    deps.writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (parsed.dryRun) {
    deps.writeStdout(`${JSON.stringify(capturePlan, null, 2)}\n`);
    return 0;
  }

  if (capturePlan.strategy === "managed-relaunch" && !parsed.yes) {
    if (nonInteractive) {
      deps.writeStderr("Managed-relaunch requires explicit --yes in non-interactive mode.\n");
      return 1;
    }

    const confirmed = await confirmManagedRelaunch(capturePlan);
    if (!confirmed) {
      deps.writeStderr("Profile sync cancelled.\n");
      return 1;
    }
  }

  if (!nonInteractive && !hasExplicitScope && !parsed.yes) {
    const confirmed = await confirmSyncAllDomains();
    if (!confirmed) {
      deps.writeStderr("Profile sync cancelled. Use --domain <domain> or --all-domains.\n");
      return 1;
    }
  }

  const cloud = resolveCloudConfig({
    enabled: true,
    mode: "cloud",
  });
  if (!cloud) {
    deps.writeStderr("Cloud mode is required for profile sync.\n");
    return 1;
  }

  const client = new OpensteerCloudClient(cloud);

  try {
    const result = await client.syncBrowserProfileCookies({
      profileId: parsed.profileId,
      ...(capturePlan.attachEndpoint === undefined
        ? {}
        : { attachEndpoint: capturePlan.attachEndpoint }),
      ...(capturePlan.brandId === undefined ? {} : { brandId: capturePlan.brandId }),
      ...(capturePlan.userDataDir === undefined ? {} : { userDataDir: capturePlan.userDataDir }),
      ...(capturePlan.profileDirectory === undefined
        ? {}
        : { profileDirectory: capturePlan.profileDirectory }),
      ...(capturePlan.executablePath === undefined
        ? {}
        : { executablePath: capturePlan.executablePath }),
      strategy: capturePlan.strategy,
      restoreBrowser: parsed.restoreBrowser,
      ...(parsed.allDomains ? {} : { domains: parsed.domains }),
      ...(parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs }),
    });

    if (parsed.json) {
      deps.writeStdout(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }

    deps.writeStdout(
      `Synced cookies into ${parsed.profileId} revision ${String(result.revision ?? "unknown")}.\n`,
    );
    return 0;
  } catch (error) {
    deps.writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function confirmSyncAllDomains(): Promise<boolean> {
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await prompt.question(
      "No domain filter provided. Sync cookies for all domains? [y/N] ",
    );
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

async function confirmManagedRelaunch(
  capturePlan: Awaited<ReturnType<typeof resolveCookieCaptureStrategy>>,
): Promise<boolean> {
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const browserName = capturePlan.brandDisplayName ?? capturePlan.brandId ?? "Browser";
  const pidLabel =
    capturePlan.runningPid === undefined ? "" : ` (PID ${String(capturePlan.runningPid)})`;

  try {
    const answer = await prompt.question(
      `${browserName}${pidLabel} is running but not debuggable.\nTo capture cookies, opensteer will:\n  1. Gracefully close ${browserName}\n  2. Relaunch it headlessly to capture cookies via CDP\n  3. Restore it to normal operation\n\nContinue? [y/N] `,
    );
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}
