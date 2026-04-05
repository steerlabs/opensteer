import { describe, expect, test } from "vitest";

import {
  FLOW_RECORDER_DRAIN_SCRIPT,
  FLOW_RECORDER_INSTALL_SCRIPT,
  FlowRecorderCollector,
  type RecorderRuntimeAdapter,
} from "../../packages/runtime-core/src/index.js";

interface FakeAdapterPlan {
  readonly initialPages: readonly {
    readonly pageRef: string;
    readonly url: string;
    readonly openerPageRef?: string;
  }[];
  readonly initialSnapshots: Readonly<Record<string, unknown>>;
  readonly polls: readonly {
    readonly pages: readonly {
      readonly pageRef: string;
      readonly url: string;
      readonly openerPageRef?: string;
    }[];
    readonly snapshots: Readonly<Record<string, unknown>>;
  }[];
}

class FakeRecorderRuntimeAdapter implements RecorderRuntimeAdapter {
  readonly addInitScripts: string[] = [];
  readonly evaluatedScripts: string[] = [];

  private pollIndex = -1;
  private currentSnapshots: Readonly<Record<string, unknown>>;

  constructor(private readonly plan: FakeAdapterPlan) {
    this.currentSnapshots = plan.initialSnapshots;
  }

  async addInitScript(input: { readonly script: string }): Promise<unknown> {
    this.addInitScripts.push(input.script);
    return undefined;
  }

  async evaluate(input: { readonly script: string; readonly pageRef?: string }): Promise<unknown> {
    this.evaluatedScripts.push(input.script);
    if (input.script === FLOW_RECORDER_INSTALL_SCRIPT) {
      return null;
    }
    if (input.script !== FLOW_RECORDER_DRAIN_SCRIPT) {
      throw new Error(`Unexpected script: ${input.script.slice(0, 32)}`);
    }
    if (input.pageRef === undefined) {
      throw new Error("Drain snapshots require an explicit pageRef.");
    }
    return this.currentSnapshots[input.pageRef] ?? {
      url: "about:blank",
      focused: false,
      visibilityState: "hidden",
      events: [],
    };
  }

  async listPages(): Promise<{
    readonly pages: readonly {
      readonly pageRef: string;
      readonly url: string;
      readonly openerPageRef?: string;
    }[];
  }> {
    if (this.pollIndex === -1) {
      this.pollIndex = 0;
      this.currentSnapshots = this.plan.initialSnapshots;
      return {
        pages: this.plan.initialPages,
      };
    }
    const poll = this.plan.polls[this.pollIndex];
    if (poll === undefined) {
      return {
        pages: [],
      };
    }
    this.currentSnapshots = poll.snapshots;
    this.pollIndex += 1;
    return {
      pages: poll.pages,
    };
  }
}

describe("FlowRecorderCollector", () => {
  test("normalizes raw page events and page lifecycle changes", async () => {
    const adapter = new FakeRecorderRuntimeAdapter({
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
          events: [],
        },
      },
      polls: [
        {
          pages: [
            {
              pageRef: "page-ref-0",
              url: "https://example.com/dashboard",
            },
            {
              pageRef: "page-ref-1",
              url: "https://example.com/docs",
              openerPageRef: "page-ref-0",
            },
          ],
          snapshots: {
            "page-ref-0": {
              url: "https://example.com/dashboard",
              focused: false,
              visibilityState: "hidden",
              events: [
                {
                  kind: "click",
                  timestamp: 1000,
                  selector: "#submit",
                  button: 0,
                  modifiers: [],
                },
              ],
            },
            "page-ref-1": {
              url: "https://example.com/docs",
              focused: true,
              visibilityState: "visible",
              events: [
                {
                  kind: "type",
                  timestamp: 1001,
                  selector: 'input[name="query"]',
                  text: "opensteer",
                },
              ],
            },
          },
        },
        {
          pages: [
            {
              pageRef: "page-ref-1",
              url: "https://example.com/docs",
              openerPageRef: "page-ref-0",
            },
          ],
          snapshots: {
            "page-ref-1": {
              url: "https://example.com/docs",
              focused: true,
              visibilityState: "visible",
              events: [],
            },
          },
        },
      ],
    });

    const collector = new FlowRecorderCollector(adapter);
    await collector.install();

    const firstPoll = await collector.pollOnce();
    expect(firstPoll.map((action) => action.kind)).toEqual([
      "navigate",
      "new-tab",
      "switch-tab",
      "click",
      "type",
    ]);
    expect(firstPoll[1]).toMatchObject({
      kind: "new-tab",
      pageId: "page1",
      detail: {
        kind: "new-tab",
        openerPageId: "page0",
      },
    });
    expect(firstPoll[0]).toMatchObject({
      kind: "navigate",
      pageId: "page0",
      detail: {
        kind: "navigate",
        source: "poll",
        url: "https://example.com/dashboard",
      },
    });

    const secondPoll = await collector.pollOnce();
    expect(secondPoll).toMatchObject([
      {
        kind: "close-tab",
        pageId: "page0",
      },
    ]);

    expect(adapter.addInitScripts).toEqual([FLOW_RECORDER_INSTALL_SCRIPT]);
    expect(adapter.evaluatedScripts).toContain(FLOW_RECORDER_DRAIN_SCRIPT);
  });
});
