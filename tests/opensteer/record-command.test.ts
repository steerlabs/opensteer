import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  FLOW_RECORDER_DRAIN_SCRIPT,
  FLOW_RECORDER_INSTALL_SCRIPT,
} from "../../packages/runtime-core/src/index.js";
import {
  runOpensteerCloudRecordCommand,
  runOpensteerRecordCommand,
} from "../../packages/opensteer/src/cli/record.js";
import type { OpensteerDisconnectableRuntime } from "../../packages/opensteer/src/sdk/semantic-runtime.js";

interface FakeRecordPlan {
  readonly initialPages: readonly {
    readonly pageRef: string;
    readonly url: string;
  }[];
  readonly initialSnapshots: Readonly<Record<string, unknown>>;
  readonly polls: readonly {
    readonly pages: readonly {
      readonly pageRef: string;
      readonly url: string;
    }[];
    readonly snapshots: Readonly<Record<string, unknown>>;
  }[];
}

class FakeRecordRuntime {
  readonly addInitScripts: string[] = [];
  readonly evaluatedScripts: string[] = [];
  disconnectCalls = 0;

  private pollIndex = -1;
  private currentSnapshots: Readonly<Record<string, unknown>>;

  constructor(private readonly plan: FakeRecordPlan) {
    this.currentSnapshots = plan.initialSnapshots;
  }

  async open(input: { readonly url?: string } = {}): Promise<{ readonly url: string }> {
    return { url: input.url ?? "about:blank" };
  }

  async addInitScript(input: { readonly script: string }): Promise<undefined> {
    this.addInitScripts.push(input.script);
    return undefined;
  }

  async evaluate(input: { readonly script: string; readonly pageRef?: string }): Promise<unknown> {
    this.evaluatedScripts.push(input.script);
    if (input.script === FLOW_RECORDER_INSTALL_SCRIPT) {
      return {
        value: null,
      };
    }
    if (input.script !== FLOW_RECORDER_DRAIN_SCRIPT) {
      throw new Error(`Unexpected script: ${input.script.slice(0, 32)}`);
    }
    if (input.pageRef === undefined) {
      throw new Error("Drain snapshots require a pageRef.");
    }
    return {
      value: this.currentSnapshots[input.pageRef] ?? {
        url: "about:blank",
        focused: false,
        visibilityState: "hidden",
        stopRequested: false,
        events: [],
      },
    };
  }

  async listPages(): Promise<{
    readonly pages: readonly {
      readonly pageRef: string;
      readonly url: string;
    }[];
  }> {
    if (this.pollIndex === -1) {
      this.pollIndex = 0;
      this.currentSnapshots = this.plan.initialSnapshots;
      return { pages: this.plan.initialPages };
    }
    const poll = this.plan.polls[this.pollIndex];
    if (poll === undefined) {
      return { pages: this.plan.polls.at(-1)?.pages ?? this.plan.initialPages };
    }
    this.currentSnapshots = poll.snapshots;
    this.pollIndex += 1;
    return { pages: poll.pages };
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
  }
}

class FakeCloudRecordRuntime {
  readonly openCalls: Array<{
    readonly url?: string;
    readonly browser?: "temporary" | "persistent";
    readonly launch?: Record<string, unknown>;
    readonly context?: Record<string, unknown>;
  }> = [];
  closeCalls = 0;

  async open(input: {
    readonly url?: string;
    readonly browser?: "temporary" | "persistent";
    readonly launch?: Record<string, unknown>;
    readonly context?: Record<string, unknown>;
  }): Promise<{ readonly url: string }> {
    this.openCalls.push(input);
    return { url: input.url ?? "about:blank" };
  }

  async info(): Promise<{ readonly sessionId: string }> {
    return {
      sessionId: "cloud-session-123",
    };
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

interface FakeCloudRecordingResult {
  readonly fileName: string;
  readonly script: string;
  readonly actionCount: number;
}

interface FakeCloudRecordingState {
  readonly status: "idle" | "recording" | "completed" | "failed";
  readonly result?: FakeCloudRecordingResult;
  readonly error?: string;
}

interface FakeCloudRecordingResponse extends FakeCloudRecordingState {
  readonly sessionId: string;
  readonly actionCount: number;
  readonly updatedAt: number;
}

class FakeCloudRecordClient {
  readonly startCalls: string[] = [];
  readonly getCalls: string[] = [];

  constructor(private readonly states: readonly FakeCloudRecordingState[]) {}

  async startSessionRecording(sessionId: string): Promise<{
    readonly sessionId: string;
    readonly status: "recording";
    readonly actionCount: number;
    readonly updatedAt: number;
  }> {
    this.startCalls.push(sessionId);
    return {
      sessionId,
      status: "recording",
      actionCount: 0,
      updatedAt: Date.now(),
    };
  }

  async getSessionRecording(sessionId: string): Promise<FakeCloudRecordingResponse> {
    this.getCalls.push(sessionId);
    const state = this.states[Math.min(this.getCalls.length - 1, this.states.length - 1)]!;
    return {
      sessionId,
      actionCount: state.result?.actionCount ?? 0,
      updatedAt: Date.now(),
      ...state,
    };
  }
}

const temporaryRoots: string[] = [];

describe("runOpensteerRecordCommand", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryRoots
        .splice(0)
        .map((rootPath) => rm(rootPath, { recursive: true, force: true }).catch(() => undefined)),
    );
  });

  test("writes the replay script and closes the owned browser session after stop", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "opensteer-record-command-"));
    temporaryRoots.push(rootDir);

    const runtime = new FakeRecordRuntime({
      initialPages: [
        {
          pageRef: "page-ref-0",
          url: "https://example.com",
        },
      ],
      initialSnapshots: {
        "page-ref-0": {
          url: "https://example.com",
          focused: true,
          visibilityState: "visible",
          stopRequested: false,
          events: [],
        },
      },
      polls: [
        {
          pages: [
            {
              pageRef: "page-ref-0",
              url: "https://example.com",
            },
          ],
          snapshots: {
            "page-ref-0": {
              url: "https://example.com",
              focused: true,
              visibilityState: "visible",
              stopRequested: true,
              events: [],
            },
          },
        },
      ],
    });
    const closeSession = vi.fn(async () => undefined);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const outputPath = path.join(rootDir, "recorded-flow.ts");

    await runOpensteerRecordCommand({
      runtime: runtime as OpensteerDisconnectableRuntime,
      closeSession,
      workspace: "recorded-close",
      url: "https://example.com",
      rootDir,
      outputPath,
      pollIntervalMs: 5,
      stdout,
      stderr,
    });

    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(runtime.disconnectCalls).toBe(0);
    expect(runtime.addInitScripts).toEqual([FLOW_RECORDER_INSTALL_SCRIPT]);

    const script = await readFile(outputPath, "utf8");
    expect(script).toContain('await opensteer.open("https://example.com");');
    expect(script).toContain("const page0 = (await opensteer.listPages()).activePageRef;");
    expect(script).toContain("await opensteer.close();");
  });

  test("falls back to disconnect when the record command does not own browser shutdown", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "opensteer-record-command-"));
    temporaryRoots.push(rootDir);

    const runtime = new FakeRecordRuntime({
      initialPages: [
        {
          pageRef: "page-ref-0",
          url: "https://example.com",
        },
      ],
      initialSnapshots: {
        "page-ref-0": {
          url: "https://example.com",
          focused: true,
          visibilityState: "visible",
          stopRequested: false,
          events: [],
        },
      },
      polls: [
        {
          pages: [
            {
              pageRef: "page-ref-0",
              url: "https://example.com",
            },
          ],
          snapshots: {
            "page-ref-0": {
              url: "https://example.com",
              focused: true,
              visibilityState: "visible",
              stopRequested: true,
              events: [],
            },
          },
        },
      ],
    });

    await runOpensteerRecordCommand({
      runtime: runtime as OpensteerDisconnectableRuntime,
      workspace: "recorded-disconnect",
      url: "https://example.com",
      rootDir,
      outputPath: path.join(rootDir, "recorded-flow.ts"),
      pollIntervalMs: 5,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });

    expect(runtime.disconnectCalls).toBe(1);
  });

  test("writes the cloud replay script after the browser session UI stops recording", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "opensteer-record-command-"));
    temporaryRoots.push(rootDir);

    const runtime = new FakeCloudRecordRuntime();
    const client = new FakeCloudRecordClient([
      { status: "recording" },
      {
        status: "completed",
        result: {
          fileName: "recorded-flow.ts",
          script: 'console.log("cloud recording");\n',
          actionCount: 3,
        },
      },
    ]);
    const sleep = vi.fn(async () => undefined);
    const openUrl = vi.fn(async () => undefined);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const outputPath = path.join(rootDir, "recorded-flow.ts");

    await runOpensteerCloudRecordCommand({
      cloudConfig: {
        apiKey: "test-api-key",
        baseUrl: "http://127.0.0.1:8180",
        appBaseUrl: "http://127.0.0.1:3000",
      },
      workspace: "recorded-cloud",
      url: "https://example.com",
      rootDir,
      outputPath,
      browser: "persistent",
      launch: {
        headless: false,
      },
      runtime,
      client,
      sleep,
      openUrl,
      stdout,
      stderr,
    });

    expect(runtime.openCalls).toEqual([
      {
        url: "https://example.com",
        browser: "persistent",
        launch: {
          headless: false,
        },
      },
    ]);
    expect(client.startCalls).toEqual(["cloud-session-123"]);
    expect(client.getCalls).toEqual(["cloud-session-123", "cloud-session-123"]);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith("http://127.0.0.1:3000/browsers/cloud-session-123");
    expect(runtime.closeCalls).toBe(1);
    await expect(readFile(outputPath, "utf8")).resolves.toBe('console.log("cloud recording");\n');
    expect(stdout.read()?.toString("utf8")).toContain(outputPath);
    expect(stderr.read()?.toString("utf8")).toContain(
      "http://127.0.0.1:3000/browsers/cloud-session-123",
    );
  });

  test("continues cloud recording when opening the browser URL fails", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "opensteer-record-command-"));
    temporaryRoots.push(rootDir);

    const runtime = new FakeCloudRecordRuntime();
    const client = new FakeCloudRecordClient([
      {
        status: "completed",
        result: {
          fileName: "recorded-flow.ts",
          script: 'console.log("cloud recording");\n',
          actionCount: 1,
        },
      },
    ]);
    const openUrl = vi.fn(async () => {
      throw new Error("No browser available");
    });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const outputPath = path.join(rootDir, "recorded-flow.ts");

    await runOpensteerCloudRecordCommand({
      cloudConfig: {
        apiKey: "test-api-key",
        baseUrl: "http://127.0.0.1:8180",
        appBaseUrl: "http://127.0.0.1:3000",
      },
      workspace: "recorded-cloud",
      url: "https://example.com",
      rootDir,
      outputPath,
      runtime,
      client,
      openUrl,
      stdout,
      stderr,
    });

    expect(openUrl).toHaveBeenCalledWith("http://127.0.0.1:3000/browsers/cloud-session-123");
    expect(runtime.closeCalls).toBe(1);
    await expect(readFile(outputPath, "utf8")).resolves.toBe('console.log("cloud recording");\n');
    expect(stdout.read()?.toString("utf8")).toContain(outputPath);
    expect(stderr.read()?.toString("utf8")).toContain(
      "Could not automatically open the cloud browser session.",
    );
  });

  test("fails cloud recording before opening a session when appBaseUrl is missing", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "opensteer-record-command-"));
    temporaryRoots.push(rootDir);

    const runtime = new FakeCloudRecordRuntime();
    const client = new FakeCloudRecordClient([]);

    await expect(
      runOpensteerCloudRecordCommand({
        cloudConfig: {
          apiKey: "test-api-key",
          baseUrl: "http://127.0.0.1:8180",
        },
        workspace: "recorded-cloud",
        url: "https://example.com",
        rootDir,
        runtime,
        client,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      }),
    ).rejects.toThrow(
      'record with provider=cloud requires OPENSTEER_CLOUD_APP_BASE_URL or "--cloud-app-base-url".',
    );

    expect(runtime.openCalls).toEqual([]);
    expect(runtime.closeCalls).toBe(0);
    expect(client.startCalls).toEqual([]);
    expect(client.getCalls).toEqual([]);
  });
});
