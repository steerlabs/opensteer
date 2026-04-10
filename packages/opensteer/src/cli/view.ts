import path from "node:path";

import { readPersistedLocalBrowserSessionRecord } from "../live-session.js";
import { isProcessRunning } from "../local-browser/process-owner.js";
import { setLocalViewMode } from "../local-view/preferences.js";
import { runLocalViewService } from "../local-view/serve.js";
import {
  buildLocalViewSessionUrl,
  ensureLocalViewServiceRunning,
  stopLocalViewService,
} from "../local-view/service.js";
import { buildLocalViewSessionId } from "../local-view/session-manifest.js";
import { resolveFilesystemWorkspacePath } from "../root.js";
import type { ParsedCommandLine } from "./parse.js";

export async function handleViewCommand(parsed: ParsedCommandLine): Promise<void> {
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
    throw new Error(`Unknown view command: view ${subcommand}`);
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
  if (!live || !isProcessRunning(live.pid)) {
    return undefined;
  }

  return buildLocalViewSessionId({
    rootPath,
    pid: live.pid,
    startedAt: live.startedAt,
  });
}

function assertNoViewPreferenceFlag(parsed: ParsedCommandLine): void {
  if (parsed.options.localViewMode !== undefined) {
    throw new Error("View preference flags cannot be combined with this subcommand.");
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
