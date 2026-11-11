import {
  AgentEventViewSchema,
  ExecutionNodeIdSchema,
  RequestSchema,
  SequenceSchema,
  createId,
  type AgentEventView as AgentEvent,
  type Request,
} from "@opensteer/core";
import type {
  HostSnapshot,
  MessageEntry,
  NodeEntry,
  ToolEntry,
  TranscriptEntry,
} from "../host/client.js";

/** The subagent states a person can meet, one conversation each, for mock mode and captures. */
export const mockSubagentScenes = [
  "one",
  "three",
  "needs",
  "finished",
  "folded-one-running",
  "workflow",
  "nested",
  "thirty",
  "thirty-running",
] as const;
export type MockSubagentScene = (typeof mockSubagentScenes)[number];

type Status = "working" | "needs" | "finished" | "failed" | "stopped";
interface Spec {
  readonly title: string;
  readonly status: Status;
  /** Seconds it has run, or ran. */
  readonly t: number;
  readonly progress?: string;
  readonly result?: string;
  readonly prompt?: string;
  readonly kids?: readonly Spec[];
  readonly stop?: boolean;
  readonly summaryOnly?: boolean;
  readonly question?: {
    readonly title: string;
    readonly detail: string;
    readonly options: readonly string[];
  };
}
interface Step {
  readonly search?: string;
  readonly read?: string;
  readonly command?: string;
}
interface Turn {
  readonly user: string;
  readonly steps?: readonly Step[];
  readonly groups: readonly (readonly Spec[])[];
  readonly workflow?: {
    readonly title: string;
    readonly t: number;
    readonly phases: readonly { readonly title: string; readonly members: readonly Spec[] }[];
  };
  readonly background?: string;
  readonly reply?: string;
  /** Seconds the settled turn worked. */
  readonly worked?: number;
}

const a1 = (status: Status = "working"): Spec => ({
  title: "Trace the payment flow",
  status,
  t: status === "working" ? 161 : 241,
  stop: true,
  progress: "Checking the Stripe confirm call",
  prompt:
    "Follow a tap on Pay from the button's handler to the Stripe confirm call, on iPhone Safari. Report the first place the tap is lost, with the file and line.",
  ...(status === "finished"
    ? {
        result:
          "The tap never reaches `usePayment()`. The shared `Button` (src/ui/button.tsx:41) sets `touch-action: none` and listens only for `pointerup`.\n\nOn iPhone Safari, when the page scrolled in the last 300ms, Safari cancels the pointer and sends no `pointerup`, so the handler never runs.\n\n- Fix: listen for `click` on the checkout button.\n- No test covers this path.",
      }
    : {}),
});
const a2: Spec = {
  title: "Audit mobile CSS for every breakpoint across cart, checkout and the order summary drawer",
  status: "working",
  t: 98,
  stop: true,
  progress: "Comparing touch-action in cart.css and checkout.css",
  prompt:
    "Check every style that applies to the checkout at phone widths. Flag anything that can swallow a tap: overlays, pointer-events, touch-action.",
};
const a3: Spec = {
  title: "Check the test suite",
  status: "finished",
  t: 52,
  result: "42 passed, 1 skipped. Nothing covers touch events on the Pay button.",
  prompt: "Run the checkout tests and tell me which ones touch the Pay button.",
};
const earlier: Turn = {
  user: "The Pay button does nothing on iPhone Safari. Can you find out why?",
  steps: [{ read: "src/checkout/pay-button.tsx" }],
  groups: [
    [
      {
        title: "Reproduce on iPhone Safari",
        status: "finished",
        t: 58,
        result:
          "Reproduced: tapping Pay shows the press state, then nothing. No network request is sent.",
      },
    ],
  ],
  reply:
    "Reproduced it: the tap shows the press state and then nothing is sent. I'll trace it next.",
  worked: 65,
};
const deeper = "Go deeper. Check the CSS too, and whether any test covers it.";

function scene(name: MockSubagentScene): readonly Turn[] {
  switch (name) {
    case "one":
      return [
        {
          user: earlier.user,
          steps: [{ read: "src/checkout/pay-button.tsx" }, { search: "touch-action" }],
          groups: [[a1()]],
        },
      ];
    case "three":
      return [
        earlier,
        { user: deeper, steps: [{ search: "pointer-events" }], groups: [[a1(), a2, a3]] },
      ];
    case "needs":
      return [
        earlier,
        {
          user: deeper,
          steps: [{ search: "pointer-events" }],
          groups: [
            [
              {
                ...a1(),
                kids: [
                  {
                    title: "Check webhook retries",
                    status: "needs",
                    t: 44,
                    prompt: "Find out whether a failed confirm is retried by the webhook.",
                    question: {
                      title: "Run stripe listen --forward-to localhost:5173/webhook?",
                      detail: "It forwards Stripe's test webhooks to this computer for a minute.",
                      options: ["Allow once", "Deny"],
                    },
                  },
                ],
              },
              {
                ...a2,
                status: "needs",
                question: {
                  title: "Change the shared Button, or only the checkout one?",
                  detail:
                    "The shared Button sets touch-action: none, which swallows the tap in Safari. Fixing it there changes 14 screens.",
                  options: ["Only the checkout button", "The shared Button (14 screens)"],
                },
              },
              a3,
            ],
          ],
        },
      ];
    case "finished":
      return [
        earlier,
        {
          user: deeper,
          steps: [{ search: "pointer-events" }],
          groups: [
            [
              a1("finished"),
              {
                ...a3,
                title: "Audit mobile CSS",
                t: 133,
                result: "Only the checkout overrides touch-action. The drawer is fine at 375px.",
              },
              { title: "Check the test suite", status: "stopped", t: 40 },
              {
                title: "Inspect the old checkout",
                status: "failed",
                t: 12,
                result: "Couldn't read apps/legacy-checkout: permission denied",
              },
              {
                title: "Compare with Android Chrome",
                status: "finished",
                t: 75,
                summaryOnly: true,
                result: "Android isn't affected: Chrome sends pointerup after a scroll.",
              },
            ],
          ],
          reply:
            "Found it. The shared Button only listens for `pointerup`, which Safari drops after a scroll. I switched the checkout button to `click`; Pay works on iPhone Safari now.",
          worked: 372,
        },
      ];
    case "folded-one-running":
      return [
        {
          user: "Fix it, then run the whole browser matrix.",
          steps: [{ read: "src/checkout/pay-button.tsx" }],
          groups: [
            [
              {
                title: "Trace the payment flow",
                status: "finished",
                t: 241,
                result: "Lost in the shared Button: pointerup only.",
              },
              {
                title: "Write a touch test",
                status: "finished",
                t: 90,
                result: "Added pay-button.touch.test.ts; it fails before the fix and passes after.",
              },
              {
                title: "Run the browser test matrix",
                status: "working",
                t: 212,
                stop: true,
                progress: "Pixel 8 · Chrome: passing",
                prompt: "Run checkout.e2e on every browser in the matrix and report failures.",
              },
            ],
          ],
          reply:
            "Fixed and tested on iPhone Safari. One subagent is still running the full browser matrix; I'll tell you what it finds.",
          worked: 270,
        },
      ];
    case "workflow":
      return [
        {
          user: "Now verify the fix on every device we support before we ship.",
          background: "pnpm dev --port 5173",
          groups: [],
          workflow: {
            title: "Verify checkout on every device",
            t: 318,
            phases: [
              {
                title: "Explore",
                members: [
                  {
                    title: "Map the checkout routes",
                    status: "finished",
                    t: 40,
                    result: "4 routes: cart, details, pay, done.",
                  },
                  {
                    title: "List supported browsers",
                    status: "finished",
                    t: 22,
                    result: "6 browsers in the support matrix.",
                  },
                  {
                    title: "Find every touch handler",
                    status: "finished",
                    t: 51,
                    result: "9 handlers, 3 use pointerup only.",
                  },
                ],
              },
              {
                title: "Validate",
                members: [
                  {
                    title: "iPhone Safari",
                    status: "working",
                    t: 94,
                    stop: true,
                    progress: "Scrolling, then tapping Pay",
                  },
                  {
                    title: "Android Chrome",
                    status: "failed",
                    t: 120,
                    result: "The emulator didn't boot within 2 minutes",
                  },
                  {
                    title: "Desktop Firefox",
                    status: "working",
                    t: 31,
                    stop: true,
                    progress: "Loading the cart",
                  },
                  {
                    title: "iPad Safari",
                    status: "finished",
                    t: 66,
                    result: "Pay works in both orientations.",
                  },
                ],
              },
              { title: "Ship", members: [] },
            ],
          },
        },
      ];
    case "nested":
      return [
        {
          user: "Find out why Pay does nothing on iPhone, and whether a failed payment gets retried.",
          steps: [{ read: "src/checkout/pay-button.tsx" }],
          groups: [
            [
              {
                title: "Trace the payment flow",
                status: "working",
                t: 161,
                prompt:
                  "Follow a tap on Pay to the Stripe confirm call. Split the work if it branches.",
                kids: [
                  {
                    title: "Check webhook retries",
                    status: "working",
                    t: 61,
                    progress: "Comparing retry windows",
                    kids: [
                      {
                        title: "Read the Stripe retry docs",
                        status: "working",
                        t: 20,
                        progress: "Reading docs.stripe.com/webhooks#retries",
                      },
                    ],
                  },
                  {
                    title: "Find every caller of confirmPayment",
                    status: "finished",
                    t: 35,
                    result: "3 callers; only the checkout one runs on touch.",
                  },
                ],
              },
              {
                title: "Audit mobile CSS",
                status: "working",
                t: 98,
                progress: "Comparing touch-action in cart.css and checkout.css",
              },
            ],
          ],
        },
      ];
    case "thirty-running":
      return scene("thirty").map((turn) => ({
        ...turn,
        groups: turn.groups.map((group) =>
          group.map(({ question: _question, ...spec }): Spec => ({ ...spec, status: "working" })),
        ),
      }));
    case "thirty": {
      const names = [
        "Oak side table",
        "Linen throw",
        "Stoneware mug set",
        "Walnut tray",
        "Wool rug 5×8",
        "Brass lamp",
        "Cotton sheets",
        "Rattan chair",
        "Glass carafe",
        "Cedar planter",
        "Velvet pillow",
        "Ash stool",
        "Ceramic vase",
        "Jute basket",
        "Marble coaster set",
        "Pine shelf",
        "Copper kettle",
        "Linen apron",
        "Teak bench",
        "Wool blanket",
        "Clay planter",
        "Oak frame",
        "Cast iron pan",
        "Bamboo board",
        "Leather pouf",
        "Steel lantern",
        "Silk scarf",
        "Birch crate",
        "Cork board",
        "Felt slippers",
      ];
      const states: Status[] = [
        "needs",
        "working",
        "working",
        "working",
        "failed",
        "working",
        "finished",
        "working",
        "finished",
        "working",
        "finished",
        "finished",
        "working",
        "finished",
        "stopped",
        "finished",
        "working",
        "finished",
        "finished",
        "working",
        "finished",
        "failed",
        "finished",
        "finished",
        "finished",
        "finished",
        "finished",
        "finished",
        "finished",
        "finished",
      ];
      return [
        {
          user: "Check every product page: the price on the page, in the cart and on the receipt must match.",
          steps: [{ read: "localhost:5173/products" }],
          groups: [
            names.map((name, index): Spec => ({
              title: `Check the price on ${name}`,
              status: states[index]!,
              t: 30 + ((index * 37) % 200),
              stop: true,
              progress: "Comparing the listed price with the cart",
              result:
                states[index] === "failed"
                  ? "The product page returned 404"
                  : "Price matches in the listing, cart and receipt.",
              ...(states[index] === "needs"
                ? {
                    question: {
                      title: "Which price is right for the Oak side table?",
                      detail: "The page says $129 and the cart says $149.",
                      options: ["$129", "$149"],
                    },
                  }
                : {}),
            })),
          ],
        },
      ];
    }
  }
}

/**
 * A task, "Fix checkout on mobile", holding one scene of the subagent design:
 * its transcript, the questions its subagents ask, and each subagent's own
 * steps for its opened view.
 */
export function seedMockSubagentScene<Snapshot extends HostSnapshot>(
  snapshot: Snapshot,
  name: MockSubagentScene,
  now: Date,
): { snapshot: Snapshot; events: readonly AgentEvent[]; threadId: string } {
  const base =
    snapshot.threads.find((thread) => thread.id === snapshot.homeThreadId) ?? snapshot.threads[0];
  if (!base || !snapshot.user) throw new Error("Subagent scenes need a mock conversation.");
  const user = snapshot.user;
  const threadId = createId("thread");
  const ago = (seconds: number) => new Date(now.getTime() - seconds * 1_000).toISOString();
  const entries: TranscriptEntry[] = [];
  const requests: Request[] = [];
  const events: AgentEvent[] = [];
  let sequence = 500;
  const emit = (runId: string, event: Pick<AgentEvent, "type" | "data">, at: string) =>
    events.push(
      AgentEventViewSchema.parse({
        ...event,
        createdAt: at,
        environmentId: base.environmentId,
        eventId: createId("event"),
        runId,
        threadId,
        workspaceId: base.workspaceId,
        sequence: SequenceSchema.parse(String(++sequence)),
      }),
    );
  const tool = (runId: string, step: Step, at: string, nodeId?: string): ToolEntry => {
    const callId = createId("event");
    const [identity, args, output] = step.search
      ? [
          { namespace: "codex", name: "shell" },
          {
            command: `rg ${step.search}`,
            commandActions: [{ type: "search", query: step.search, command: `rg ${step.search}` }],
          },
          "12 results",
        ]
      : step.read
        ? [{ namespace: "functions", name: "read_file" }, { path: step.read }, "Read the file."]
        : [{ namespace: "codex", name: "shell" }, { command: step.command ?? "" }, "ok"];
    return {
      arguments: args,
      callId,
      completedAt: at,
      createdAt: at,
      id: `tool:${runId}:${callId}`,
      integration: null,
      isError: false,
      kind: "tool",
      ...(nodeId ? { nodeId } : {}),
      output: { text: output },
      runId,
      state: "done",
      streamText: "",
      tool: identity,
    };
  };
  const nodeOf = (
    spec: Spec,
    runId: string,
    parentNodeId: string | null,
    extra: Partial<NodeEntry> = {},
  ): NodeEntry[] => {
    const nodeId = createId("executionNode");
    const running = spec.status === "working" || spec.status === "needs";
    const startedAt = running ? ago(spec.t) : ago(spec.t + 120);
    const node: NodeEntry = {
      id: `node:${nodeId}`,
      kind: "node",
      nodeKind: "subagent",
      nodeId,
      title: spec.title,
      runId,
      status: running
        ? "running"
        : spec.status === "finished"
          ? "completed"
          : spec.status === "failed"
            ? "failed"
            : "interrupted",
      stopSupported: spec.stop === true,
      createdAt: startedAt,
      completedAt: running ? null : ago(120),
      model: "gpt-6.1-sol",
      effort: "high",
      originCallId: null,
      parentNodeId,
      phaseIndex: null,
      phases: [],
      prompt: spec.prompt ?? `${spec.title}.`,
      result: spec.result ?? null,
      progress: spec.status === "working" ? (spec.progress ?? null) : null,
      ...extra,
    };
    if (spec.question)
      requests.push(
        RequestSchema.parse({
          id: createId("request"),
          kind: "harness.input",
          payload: { kind: "harness.input" },
          mode: "live",
          status: "pending",
          createdAt: ago(spec.t - 5),
          callId: createId("event"),
          originatingNodeId: nodeId,
          originatingRunId: runId,
          originatingOccurrenceId: null,
          originatingThreadId: threadId,
          originatingWorkspaceId: base.workspaceId,
          targetWorkspaceId: base.workspaceId,
          requestedBy: user.id,
          requiredActor: "requester",
          resolvedAt: null,
          resolvedBy: null,
          response: null,
          cancellationReason: null,
          presentation: {
            kind: "choice",
            title: spec.question.title,
            detail: spec.question.detail,
            risk: "low",
            options: spec.question.options.map((label, index) => ({
              id: `option-${index}`,
              label,
              hint: "other",
            })),
          },
        }),
      );
    if (!spec.summaryOnly) {
      const detailId = ExecutionNodeIdSchema.parse(nodeId);
      const steps: Step[] = [
        { read: "src/checkout/pay-button.tsx" },
        { search: "onPointerUp" },
        { read: "src/checkout/use-payment.ts" },
        { command: "pnpm vitest pay" },
      ];
      steps.forEach((step, index) => {
        const callId = `${nodeId}:${index}`;
        const at = new Date(Date.parse(startedAt) + (index + 1) * 4_000).toISOString();
        const made = tool(runId, step, at);
        emit(
          runId,
          {
            type: "tool.started",
            data: { nodeId: detailId, callId, tool: made.tool!, arguments: made.arguments },
          },
          at,
        );
        emit(
          runId,
          {
            type: "tool.completed",
            data: { nodeId: detailId, callId, output: made.output!, isError: false },
          },
          at,
        );
      });
      if (spec.result && spec.status === "finished")
        emit(
          runId,
          { type: "node.message", data: { nodeId: detailId, text: spec.result } },
          ago(121),
        );
    }
    const kids = (spec.kids ?? []).flatMap((kid) => nodeOf(kid, runId, nodeId));
    return [node, ...kids];
  };
  const turns = scene(name);
  let clock = 900;
  for (const [index, turn] of turns.entries()) {
    const runId = createId("run");
    const last = index === turns.length - 1;
    const settled = turn.reply !== undefined;
    const start = last && !settled ? 400 : (clock -= 200);
    const replyId = createId("message");
    entries.push({
      author: {
        displayName: "Alex",
        kind: "human",
        principalId: `user:${user.id}`,
        userId: user.id,
      },
      body: turn.user,
      createdAt: ago(start + 1),
      id: createId("message"),
      kind: "message",
      messageKind: "input",
      runId,
    } as MessageEntry);
    entries.push({
      createdAt: ago(start),
      error: null,
      id: `run:${runId}`,
      kind: "run",
      replyMessageId: settled ? replyId : null,
      runId,
      status: settled ? "completed" : "running",
      startedAt: ago(start),
      ...(settled ? { endedAt: ago(start - (turn.worked ?? 60)) } : {}),
    });
    for (const step of turn.steps ?? []) entries.push(tool(runId, step, ago(start - 2)));
    if (turn.background)
      entries.push(
        ...nodeOf({ title: turn.background, status: "working", t: 402 }, runId, null, {
          nodeKind: "task",
          prompt: null,
        }),
      );
    if (turn.workflow) {
      const [workflow] = nodeOf(
        { title: turn.workflow.title, status: "working", t: turn.workflow.t, stop: true },
        runId,
        null,
        { nodeKind: "workflow", phases: turn.workflow.phases.map((phase) => phase.title) },
      );
      entries.push(workflow!);
      turn.workflow.phases.forEach((phase, phaseIndex) => {
        for (const member of phase.members)
          entries.push(...nodeOf(member, runId, workflow!.nodeId, { phaseIndex }));
      });
    }
    turn.groups.forEach((group, groupIndex) => {
      if (groupIndex > 0)
        entries.push(tool(runId, { read: "src/checkout/cart.tsx" }, ago(start - 3)));
      for (const spec of group) entries.push(...nodeOf(spec, runId, null));
    });
    if (settled)
      entries.push({
        author: {
          displayName: "Opensteer",
          kind: "agent",
          runId,
          threadId,
          workspaceId: base.workspaceId,
          workspaceName: "Main",
        } as MessageEntry["author"],
        body: turn.reply!,
        createdAt: ago(start - (turn.worked ?? 60)),
        id: replyId,
        kind: "message",
        messageKind: "assistant",
        runId,
      } as MessageEntry);
  }
  const liveRuns = new Set(
    entries.flatMap((entry) =>
      entry.kind === "node" && entry.status === "running" && entry.runId ? [entry.runId] : [],
    ),
  );
  for (const [index, entry] of entries.entries())
    if (
      entry.kind === "run" &&
      entry.status === "completed" &&
      entry.runId !== null &&
      liveRuns.has(entry.runId)
    )
      entries[index] = { ...entry, background: true };
  const runningRun = entries.find((entry) => entry.kind === "run" && entry.status === "running");
  const running = runningRun !== undefined;
  const thread = {
    ...base,
    id: threadId,
    title: "Fix checkout on mobile",
    role: "work" as const,
    parentThreadId: null,
    status: running ? ("running" as const) : ("idle" as const),
    pendingRequests: requests.length,
    createdAt: ago(1_000),
    updatedAt: ago(10),
    listed: true,
  };
  return {
    threadId,
    events,
    snapshot: {
      ...snapshot,
      threads: [...snapshot.threads, thread],
      requests: { ...snapshot.requests, [threadId]: requests },
      runQueue:
        runningRun?.kind === "run" && runningRun.runId
          ? [
              ...snapshot.runQueue,
              {
                id: runningRun.runId,
                threadId,
                runOrdinal: 1,
                createdAt: runningRun.createdAt,
                status: "running",
              },
            ]
          : snapshot.runQueue,
      transcripts: { ...snapshot.transcripts, [threadId]: entries },
    },
  };
}
