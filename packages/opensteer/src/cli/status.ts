import path from "node:path";

import type { OpensteerCloudConfig } from "../cloud/config.js";
import { OpensteerCloudClient } from "../cloud/client.js";
import {
  readPersistedCloudSessionRecord,
  readPersistedLocalBrowserSessionRecord,
  type PersistedCloudSessionRecord,
  type PersistedLocalBrowserSessionRecord,
} from "../live-session.js";
import { resolveFilesystemWorkspacePath } from "../root.js";
import { pathExists } from "../internal/filesystem.js";
import { isProcessRunning } from "../local-browser/process-owner.js";
import type { OpensteerResolvedProvider } from "../provider/config.js";

export interface OpensteerStatusLaneSummary {
  readonly provider: "local" | "cloud";
  readonly status: "idle" | "active" | "connected" | "stale" | "closed";
  readonly current: boolean;
  readonly summary?: string;
  readonly detail?: string;
  readonly sessionId?: string;
  readonly baseUrl?: string;
  readonly pid?: number;
  readonly engine?: string;
  readonly browser?: string;
  readonly region?: string;
}

export interface OpensteerStatusOutput {
  readonly provider: {
    readonly current: OpensteerResolvedProvider["kind"];
    readonly source: "flag" | "env" | "default";
    readonly cloudBaseUrl?: string;
  };
  readonly workspace?: string;
  readonly rootPath?: string;
  readonly lanes?: {
    readonly local: OpensteerStatusLaneSummary;
    readonly cloud: OpensteerStatusLaneSummary;
  };
}

export async function collectOpensteerStatus(input: {
  readonly rootDir: string;
  readonly workspace?: string;
  readonly provider: OpensteerResolvedProvider;
  readonly cloudConfig?: OpensteerCloudConfig;
}): Promise<OpensteerStatusOutput> {
  const output: OpensteerStatusOutput = {
    provider: {
      current: input.provider.kind,
      source: mapProviderSource(input.provider.source),
      ...(input.cloudConfig === undefined ? {} : { cloudBaseUrl: input.cloudConfig.baseUrl }),
    },
    ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
  };

  if (input.workspace === undefined) {
    return output;
  }

  const rootPath = resolveFilesystemWorkspacePath({
    rootDir: input.rootDir,
    workspace: input.workspace,
  });
  const localRecord = await readWorkspaceLocalRecord(rootPath);
  const cloudRecord = await readWorkspaceCloudRecord(rootPath);

  return {
    ...output,
    rootPath,
    lanes: {
      local: describeLocalLane(localRecord, input.provider.kind === "local"),
      cloud: await describeCloudLane({
        record: cloudRecord,
        current: input.provider.kind === "cloud",
        cloudConfig: input.cloudConfig,
      }),
    },
  };
}

export function renderOpensteerStatus(status: OpensteerStatusOutput): string {
  const lines: string[] = [
    "Provider resolution",
    `  current: ${status.provider.current}`,
    `  source: ${status.provider.source}`,
  ];

  if (status.provider.cloudBaseUrl !== undefined) {
    lines.push(`  control api: ${status.provider.cloudBaseUrl}`);
  }
  if (status.workspace !== undefined) {
    lines.push(`  workspace: ${status.workspace}`);
  }

  if (status.lanes === undefined) {
    return `${lines.join("\n")}\n`;
  }

  lines.push("", "Live sessions");
  for (const lane of [status.lanes.local, status.lanes.cloud]) {
    lines.push(
      formatLaneRow({
        marker: lane.current ? "*" : " ",
        provider: lane.provider,
        status: lane.status,
        summary: lane.summary ?? "none",
        detail: lane.detail,
      }),
    );
  }

  return `${lines.join("\n")}\n`;
}

async function readWorkspaceLocalRecord(
  rootPath: string,
): Promise<PersistedLocalBrowserSessionRecord | undefined> {
  if (!(await pathExists(rootPath))) {
    return undefined;
  }
  return readPersistedLocalBrowserSessionRecord(rootPath);
}

async function readWorkspaceCloudRecord(
  rootPath: string,
): Promise<PersistedCloudSessionRecord | undefined> {
  if (!(await pathExists(rootPath))) {
    return undefined;
  }
  return readPersistedCloudSessionRecord(rootPath);
}

function describeLocalLane(
  record: PersistedLocalBrowserSessionRecord | undefined,
  current: boolean,
): OpensteerStatusLaneSummary {
  if (record === undefined || !isProcessRunning(record.pid)) {
    return {
      provider: "local",
      status: "idle",
      current,
      summary: "none",
    };
  }

  const browser = record.executablePath
    ? path.basename(record.executablePath).replace(/\.[A-Za-z0-9]+$/u, "")
    : undefined;
  return {
    provider: "local",
    status: "active",
    current,
    summary: `PID ${String(record.pid)}`,
    detail: browser ?? record.engine,
    pid: record.pid,
    engine: record.engine,
    ...(browser === undefined ? {} : { browser }),
  };
}

async function describeCloudLane(input: {
  readonly record: PersistedCloudSessionRecord | undefined;
  readonly current: boolean;
  readonly cloudConfig: OpensteerCloudConfig | undefined;
}): Promise<OpensteerStatusLaneSummary> {
  if (input.record === undefined) {
    return {
      provider: "cloud",
      status: "idle",
      current: input.current,
      summary: "none",
    };
  }

  const base: OpensteerStatusLaneSummary = {
    provider: "cloud",
    status: "connected",
    current: input.current,
    summary: input.record.sessionId,
    detail: input.record.baseUrl,
    sessionId: input.record.sessionId,
    baseUrl: input.record.baseUrl,
  };

  if (input.cloudConfig === undefined) {
    return base;
  }

  try {
    const client = new OpensteerCloudClient(input.cloudConfig);
    const session = (await client.getSession(input.record.sessionId)) as {
      readonly status?: string;
      readonly region?: string;
      readonly runtimeRegion?: string;
    };
    if (session.status === "closed") {
      return {
        ...base,
        status: "closed",
        ...((session.region ?? session.runtimeRegion)
          ? { region: session.region ?? session.runtimeRegion }
          : {}),
      };
    }
    if (session.status === "failed") {
      return {
        ...base,
        status: "stale",
      };
    }
    return {
      ...base,
      ...((session.region ?? session.runtimeRegion)
        ? { region: session.region ?? session.runtimeRegion }
        : {}),
    };
  } catch {
    return {
      ...base,
      status: "stale",
    };
  }
}

function mapProviderSource(
  source: OpensteerResolvedProvider["source"],
): "flag" | "env" | "default" {
  if (source === "explicit") {
    return "flag";
  }
  return source;
}

function formatLaneRow(input: {
  readonly marker: string;
  readonly provider: string;
  readonly status: string;
  readonly summary: string;
  readonly detail: string | undefined;
}): string {
  const provider = input.provider.padEnd(7, " ");
  const status = input.status.padEnd(9, " ");
  const summary = input.summary.padEnd(16, " ");
  return `${input.marker} ${provider} ${status} ${summary}${input.detail ?? ""}`.trimEnd();
}
