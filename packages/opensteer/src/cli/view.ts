import path from "node:path";

import {
  getPersistedLocalBrowserSessionOwnership,
  isAttachedLocalBrowserSessionReachable,
  readPersistedLocalBrowserSessionRecord,
} from "../live-session.js";
import { isProcessRunning } from "../local-browser/process-owner.js";
import { setLocalViewMode } from "../local-view/preferences.js";
import { runLocalViewService } from "../local-view/serve.js";
import {
  buildLocalViewSessionUrl,
  ensureLocalViewServiceRunning,
  stopLocalViewService,
} from "../local-view/service.js";
import { buildLocalViewSessionIdForRecord } from "../local-view/session-manifest.js";
import { resolveFilesystemWorkspacePath } from "../root.js";
import { CliError } from "./errors.js";
import type { ParsedCommandLine } from "./parse.js";
import { openBrowserUrl, type BrowserUrlOpener } from "./open-browser.js";

export async function handleViewCommand(
  parsed: ParsedCommandLine,
  options: {
    readonly openUrl?: BrowserUrlOpener;
  } = {},
): Promise<void> {
  const subcommand = parsed.command[1];

  if (subcommand === "serve") {
    assertNoViewPreferenceFlag(parsed);
    await runLocalViewService();
    return;
  }

  if (subcommand === "stop") {
    assertNoViewPreferenceFlag(parsed);
    const stopped = await stopLocalViewService();
    writeViewOutput(parsed, { stopped });
    return;
  }

  if (subcommand !== undefined) {
    throw new CliError("unknown_command", `Unknown view command: view ${subcommand}`);
  }

  if (parsed.options.localViewMode !== undefined) {
    const preference = await setLocalViewMode(parsed.options.localViewMode);
    writeViewOutput(parsed, { mode: preference.mode });
    return;
  }

  const service = await ensureLocalViewServiceRunning();
  const sessionId =
    parsed.options.workspace === undefined
      ? undefined
      : await resolveWorkspaceSessionId({
          rootDir: process.cwd(),
          workspace: parsed.options.workspace,
        });
  const url = buildLocalViewSessionUrl({
    baseUrl: service.url,
    ...(sessionId === undefined ? {} : { sessionId }),
  });

  writeViewOutput(parsed, {
    url,
    ...(sessionId === undefined ? {} : { sessionId }),
  });

  if (parsed.options.json !== true) {
    try {
      await (options.openUrl ?? openBrowserUrl)(url);
    } catch {
      process.stderr.write(
        `Could not automatically open the local view. Open it manually: ${url}\n`,
      );
    }
  }
}

async function resolveWorkspaceSessionId(input: {
  readonly rootDir: string;
  readonly workspace: string;
}): Promise<string | undefined> {
  const rootPath = resolveFilesystemWorkspacePath({
    rootDir: path.resolve(input.rootDir),
    workspace: input.workspace,
  });
  const live = await readPersistedLocalBrowserSessionRecord(rootPath);
  if (!live) {
    return undefined;
  }
  if (getPersistedLocalBrowserSessionOwnership(live) === "attached") {
    if (!(await isAttachedLocalBrowserSessionReachable(live))) {
      return undefined;
    }
  } else if (!isProcessRunning(live.pid)) {
    return undefined;
  }

  return buildLocalViewSessionIdForRecord({
    rootPath,
    live,
  });
}

function assertNoViewPreferenceFlag(parsed: ParsedCommandLine): void {
  if (parsed.options.localViewMode !== undefined) {
    throw new CliError(
      "invalid_option",
      "View preference flags cannot be combined with this subcommand.",
    );
  }
}

function writeViewOutput(
  parsed: ParsedCommandLine,
  value:
    | {
        readonly url: string;
        readonly sessionId?: string;
      }
    | {
        readonly stopped: boolean;
      }
    | {
        readonly mode: "auto" | "manual";
      },
): void {
  if (parsed.options.json === true) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }

  if ("url" in value) {
    process.stdout.write(`${value.url}\n`);
    return;
  }

  if ("stopped" in value) {
    process.stdout.write(
      `${value.stopped ? "Local view service stopped." : "Local view service is not running."}\n`,
    );
    return;
  }

  process.stdout.write(`Local view preference set to ${value.mode}.\n`);
}
