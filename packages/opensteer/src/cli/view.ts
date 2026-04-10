import path from "node:path";

import { readPersistedLocalBrowserSessionRecord } from "../live-session.js";
import { isProcessRunning } from "../local-browser/process-owner.js";
import {
  buildLocalViewSessionUrl,
  ensureLocalViewServiceRunning,
} from "../local-view/registration.js";
import { enableLocalViewPreference } from "../local-view/preferences.js";
import { runLocalViewService } from "../local-view/serve.js";
import { buildLocalViewSessionId } from "../local-view/session-manifest.js";
import { resolveFilesystemWorkspacePath } from "../root.js";
import type { ParsedCommandLine } from "./parse.js";

export async function handleViewCommand(parsed: ParsedCommandLine): Promise<void> {
  if (parsed.command[1] === "serve") {
    await runLocalViewService();
    return;
  }

  await enableLocalViewPreference();
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

  if (parsed.options.json === true) {
    process.stdout.write(
      JSON.stringify(
        {
          url,
          ...(sessionId === undefined ? {} : { sessionId }),
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  process.stdout.write(`${url}\n`);
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
