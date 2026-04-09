import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  FlowRecorderCollector,
  generateReplayScript,
  type RecorderRuntimeAdapter,
  type RecordedAction,
} from "@opensteer/runtime-core";
import type {
  CloudSessionRecordingState,
  OpensteerBrowserContextOptions,
  OpensteerBrowserLaunchOptions,
  OpensteerOpenOutput,
  OpensteerSessionInfo,
  PageRef,
} from "@opensteer/protocol";

import { OpensteerCloudClient } from "../cloud/client.js";
import { requireCloudAppBaseUrl, type OpensteerCloudConfig } from "../cloud/config.js";
import { CloudSessionProxy } from "../cloud/session-proxy.js";
import type { OpensteerDisconnectableRuntime } from "../sdk/semantic-runtime.js";
import { resolveFilesystemWorkspacePath } from "../root.js";
import { openBrowserUrl, type BrowserUrlOpener } from "./open-browser.js";

export interface OpensteerRecordCommandInput {
  readonly runtime: OpensteerDisconnectableRuntime;
  readonly closeSession?: () => Promise<void>;
  readonly workspace: string;
  readonly url: string;
  readonly rootDir: string;
  readonly outputPath?: string;
  readonly pollIntervalMs?: number;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
}

interface OpensteerCloudRecordRuntime {
  open(input: {
    readonly url?: string;
    readonly browser?: "temporary" | "persistent";
    readonly launch?: OpensteerBrowserLaunchOptions;
    readonly context?: OpensteerBrowserContextOptions;
  }): Promise<OpensteerOpenOutput>;
  info(): Promise<OpensteerSessionInfo>;
  close(): Promise<unknown>;
}

interface OpensteerCloudRecordClient {
  startSessionRecording(sessionId: string): Promise<CloudSessionRecordingState>;
  getSessionRecording(sessionId: string): Promise<CloudSessionRecordingState>;
}

export interface OpensteerCloudRecordCommandInput {
  readonly cloudConfig: OpensteerCloudConfig;
  readonly workspace: string;
  readonly url: string;
  readonly rootDir: string;
  readonly outputPath?: string;
  readonly browser?: "temporary" | "persistent";
  readonly launch?: OpensteerBrowserLaunchOptions;
  readonly context?: OpensteerBrowserContextOptions;
  readonly pollIntervalMs?: number;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  readonly runtime?: OpensteerCloudRecordRuntime;
  readonly client?: OpensteerCloudRecordClient;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly openUrl?: BrowserUrlOpener;
}

export async function runOpensteerRecordCommand(input: OpensteerRecordCommandInput): Promise<void> {
  const stdout = input.stdout ?? process.stdout;
  const stderr = input.stderr ?? process.stderr;
  const outputPath = resolveRecordOutputPath({
    rootDir: input.rootDir,
    workspace: input.workspace,
    ...(input.outputPath === undefined ? {} : { outputPath: input.outputPath }),
  });
  const runtime = input.runtime;
  const collector = new FlowRecorderCollector(createRecorderRuntimeAdapter(runtime), {
    ...(input.pollIntervalMs === undefined ? {} : { pollIntervalMs: input.pollIntervalMs }),
    onAction: (action) => {
      stderr.write(`${formatRecordedAction(action)}\n`);
    },
  });
  stderr.write(
    `Recording browser actions for workspace "${input.workspace}". Click "Stop recording" in the browser when you're done.\n`,
  );
  let closed = false;

  try {
    const opened = await runtime.open({
      url: input.url,
    });
    await collector.install();
    collector.start();

    await collector.waitForStop();

    const actions = await collector.stop();
    const script = generateReplayScript({
      actions,
      workspace: input.workspace,
      startUrl: opened.url,
    });
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, script, "utf8");

    if (input.closeSession !== undefined) {
      await input.closeSession();
      closed = true;
    }

    stdout.write(`${outputPath}\n`);
    stderr.write(`Wrote replay script to ${outputPath}\n`);
  } finally {
    if (!closed) {
      await runtime.disconnect().catch(() => undefined);
    }
  }
}

export async function runOpensteerCloudRecordCommand(
  input: OpensteerCloudRecordCommandInput,
): Promise<void> {
  const stdout = input.stdout ?? process.stdout;
  const stderr = input.stderr ?? process.stderr;
  const cloudAppBaseUrl = requireCloudAppBaseUrl(input.cloudConfig);
  const outputPath = resolveRecordOutputPath({
    rootDir: input.rootDir,
    workspace: input.workspace,
    ...(input.outputPath === undefined ? {} : { outputPath: input.outputPath }),
  });
  let cloud: OpensteerCloudClient | undefined;
  const resolveCloud = (): OpensteerCloudClient => {
    cloud ??= new OpensteerCloudClient(input.cloudConfig);
    return cloud;
  };
  const runtime =
    input.runtime ??
    new CloudSessionProxy(resolveCloud(), {
      rootDir: input.rootDir,
      workspace: input.workspace,
    });
  const client = input.client ?? resolveCloud();
  const sleep = input.sleep ?? delay;
  const openUrl = input.openUrl ?? openBrowserUrl;
  let closed = false;

  try {
    await runtime.open({
      url: input.url,
      ...(input.browser === undefined ? {} : { browser: input.browser }),
      ...(input.launch === undefined ? {} : { launch: input.launch }),
      ...(input.context === undefined ? {} : { context: input.context }),
    });
    const sessionId = await resolveCloudRecordingSessionId(runtime);
    const sessionUrl = buildCloudRecordingSessionUrl(cloudAppBaseUrl, sessionId);

    await client.startSessionRecording(sessionId);
    await tryOpenCloudRecordingSessionUrl({
      sessionUrl,
      stderr,
      openUrl,
    });
    stderr.write(
      `Recording browser actions for workspace "${input.workspace}". Open ${sessionUrl} and click "Stop recording" in the browser session toolbar when you're done.\n`,
    );

    const completed = await waitForCloudRecordingCompletion({
      client,
      sessionId,
      ...(input.pollIntervalMs === undefined ? {} : { pollIntervalMs: input.pollIntervalMs }),
      sleep,
    });
    if (completed.result === undefined) {
      throw new Error("Cloud recording completed without a replay script.");
    }

    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, completed.result.script, "utf8");
    await runtime.close();
    closed = true;

    stdout.write(`${outputPath}\n`);
    stderr.write(`Cloud browser session: ${sessionUrl}\n`);
    stderr.write(`Wrote replay script to ${outputPath}\n`);
  } finally {
    if (!closed) {
      await runtime.close().catch(() => undefined);
    }
  }
}

export function resolveRecordOutputPath(input: {
  readonly rootDir: string;
  readonly workspace: string;
  readonly outputPath?: string;
}): string {
  if (input.outputPath !== undefined) {
    return path.resolve(input.rootDir, input.outputPath);
  }
  return path.join(
    resolveFilesystemWorkspacePath({
      rootDir: input.rootDir,
      workspace: input.workspace,
    }),
    "recorded-flow.ts",
  );
}

export function createRecorderRuntimeAdapter(
  runtime: OpensteerDisconnectableRuntime,
): RecorderRuntimeAdapter {
  return {
    addInitScript: (input) => runtime.addInitScript(input),
    evaluate: async (input) => {
      const output = await runtime.evaluate({
        script: input.script,
        ...(input.pageRef === undefined ? {} : { pageRef: input.pageRef as PageRef }),
      });
      return output.value;
    },
    listPages: async () => {
      const output = await runtime.listPages();
      return {
        pages: output.pages.map((page) => ({
          pageRef: page.pageRef,
          url: page.url,
          ...(page.openerPageRef === undefined ? {} : { openerPageRef: page.openerPageRef }),
        })),
      };
    },
  };
}

function buildCloudRecordingSessionUrl(appBaseUrl: string, sessionId: string): string {
  return `${appBaseUrl}/browsers/${encodeURIComponent(sessionId)}`;
}

async function tryOpenCloudRecordingSessionUrl(input: {
  readonly sessionUrl: string;
  readonly stderr: NodeJS.WritableStream;
  readonly openUrl: BrowserUrlOpener;
}): Promise<void> {
  try {
    await input.openUrl(input.sessionUrl);
  } catch {
    input.stderr.write(
      `Could not automatically open the cloud browser session. Open it manually: ${input.sessionUrl}\n`,
    );
  }
}

async function resolveCloudRecordingSessionId(
  runtime: Pick<OpensteerCloudRecordRuntime, "info">,
): Promise<string> {
  const info = await runtime.info();
  if (typeof info.sessionId !== "string" || info.sessionId.length === 0) {
    throw new Error("Cloud recording could not resolve the created session id.");
  }
  return info.sessionId;
}

async function waitForCloudRecordingCompletion(input: {
  readonly client: OpensteerCloudRecordClient;
  readonly sessionId: string;
  readonly pollIntervalMs?: number;
  readonly sleep: (ms: number) => Promise<void>;
}): Promise<CloudSessionRecordingState> {
  const pollIntervalMs = input.pollIntervalMs ?? 1_000;

  for (;;) {
    const state = await input.client.getSessionRecording(input.sessionId);
    if (state.status === "completed") {
      return state;
    }
    if (state.status === "failed") {
      throw new Error(state.error ?? "Cloud recording failed.");
    }
    await input.sleep(pollIntervalMs);
  }
}

function formatRecordedAction(action: RecordedAction): string {
  const time = new Date(action.timestamp).toISOString().slice(11, 19);
  switch (action.kind) {
    case "click":
      return `[${time}] click ${action.pageId} -> ${action.selector ?? "<unknown>"}`;
    case "dblclick":
      return `[${time}] dblclick ${action.pageId} -> ${action.selector ?? "<unknown>"}`;
    case "type":
      return `[${time}] type ${action.pageId} -> ${action.selector ?? "<unknown>"} -> ${JSON.stringify(action.detail.text)}`;
    case "keypress":
      return `[${time}] keypress ${action.pageId} -> ${action.detail.key}`;
    case "scroll":
      return `[${time}] scroll ${action.pageId} -> (${String(action.detail.deltaX)}, ${String(action.detail.deltaY)})`;
    case "select-option":
      return `[${time}] select ${action.pageId} -> ${action.selector ?? "<unknown>"} -> ${JSON.stringify(action.detail.value)}`;
    case "navigate":
      return `[${time}] navigate ${action.pageId} -> ${action.detail.url}`;
    case "new-tab":
      return `[${time}] new-tab ${action.pageId} -> ${action.detail.initialUrl}`;
    case "close-tab":
      return `[${time}] close-tab ${action.pageId}`;
    case "switch-tab":
      return `[${time}] switch-tab -> ${action.detail.toPageId}`;
    case "go-back":
      return `[${time}] go-back ${action.pageId}`;
    case "go-forward":
      return `[${time}] go-forward ${action.pageId}`;
    case "reload":
      return `[${time}] reload ${action.pageId}`;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
