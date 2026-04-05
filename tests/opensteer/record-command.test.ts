import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  FLOW_RECORDER_DRAIN_SCRIPT,
  FLOW_RECORDER_INSTALL_SCRIPT,
} from "../../packages/runtime-core/src/index.js";
import { runOpensteerRecordCommand } from "../../packages/opensteer/src/cli/record.js";
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

const temporaryRoots: string[] = [];

describe("runOpensteerRecordCommand", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((rootPath) =>
        rm(rootPath, { recursive: true, force: true }).catch(() => undefined),
      ),
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
    expect(script).toContain(
      'const page0 = (await opensteer.open("https://example.com")).pageRef;',
    );
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
});
