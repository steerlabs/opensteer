import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  FlowRecorderCollector,
  generateReplayScript,
  type RecorderRuntimeAdapter,
  type RecordedAction,
} from "@opensteer/runtime-core";
import type { PageRef } from "@opensteer/protocol";

import type { OpensteerDisconnectableRuntime } from "../sdk/semantic-runtime.js";
import { resolveFilesystemWorkspacePath } from "../root.js";

export interface OpensteerRecordCommandInput {
  readonly runtime: OpensteerDisconnectableRuntime;
  readonly workspace: string;
  readonly url: string;
  readonly rootDir: string;
  readonly outputPath?: string;
  readonly pollIntervalMs?: number;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
}

export async function runOpensteerRecordCommand(
  input: OpensteerRecordCommandInput,
): Promise<void> {
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
  const stopSignal = createStopSignal();

  stderr.write(`Recording browser actions for workspace "${input.workspace}". Press Ctrl+C to stop.\n`);

  try {
    const opened = await runtime.open({
      url: input.url,
    });
    await collector.install();
    collector.start();

    await stopSignal;

    const actions = await collector.stop();
    const script = generateReplayScript({
      actions,
      workspace: input.workspace,
      startUrl: opened.url,
    });
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, script, "utf8");

    stdout.write(`${outputPath}\n`);
    stderr.write(`Wrote replay script to ${outputPath}\n`);
  } finally {
    await runtime.disconnect().catch(() => undefined);
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

function createStopSignal(): Promise<void> {
  return new Promise((resolve) => {
    const onSigint = () => {
      process.off("SIGINT", onSigint);
      resolve();
    };
    process.on("SIGINT", onSigint);
  });
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
