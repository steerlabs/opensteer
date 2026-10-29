import { RunnerIdSchema, type IntegrationCallSubject } from "@opensteer/core";
import { formatComputerUseResultHead } from "@opensteer/protocol";
import type { MessageEntry, ToolEntry, TranscriptEntry } from "../host/client.js";

/**
 * One real Computer use turn, as the transcript records it: a Codex agent
 * asked to click the Opensteer workspace in Slack. It found the app, guessed
 * the act schema wrong, looked it up, was stopped once by a newer observation,
 * and then clicked through. Codex kept its reasoning to itself, so nothing
 * stands between the calls but the agent's opening note.
 *
 * The preview seeds a Thread with it, and the model and renderer tests read
 * the same entries, so what the tests assert is what the preview shows.
 */

const runnerId = RunnerIdSchema.parse("rnr_35a353b8-9b64-4600-9eb1-e25db7c052a3");

export const mockComputerUseSlack = {
  app: "Slack",
  bundleId: "com.tinyspeck.slackmacgap",
  computer: "Alex's MacBook Pro",
  runnerId,
} as const;

const observeRef =
  "igr_e1327fe8-282d-8988-98d6-60899b8b5427.itl_ae1ec767-1b09-4ca2-bccf-a21f3c2a005b.mGQzRJH1AN56mNyKtr60pzIdODzQ2MEIUOE6ayMoD3s";
const actRef =
  "igr_e1327fe8-282d-8988-98d6-60899b8b5427.itl_12274381-993e-4e88-aafd-b73add35086e.ixpXfZ6E5l0X-LV31e9ZmjfFvq1dLYxK8mNBUCAooo0";

/** Every opaque reference the turn passed around; none of them is anything a reader should see. */
export const mockComputerUseToolRefs = [observeRef, actRef] as const;

export function mockComputerUseSubject(
  operation: "act" | "observe",
  place: NonNullable<IntegrationCallSubject["computerApp"]> = mockComputerUseSlack,
): IntegrationCallSubject {
  return {
    account: "This computer",
    computerApp: place,
    effect: operation === "observe" ? "read" : "write",
    integration: "Computer use",
    operation: { name: operation, title: operation === "observe" ? "Observe" : "Act" },
  };
}

const ycTitle = "batch-ask-yc-software-team (Channel) - YC S2023 - 4 new items - Slack";
const opensteerTitle = "openai-yc-alumni-6 (Channel) - Opensteer - 2 new items - Slack";

/** The top of the window as Slack's accessibility tree reads it; the real one runs to 214 elements. */
function tree(title: string): string {
  return [
    `[0] window "${title}" (0,0 1440×904)`,
    `  [1] webarea "${title}" (0,0 1440×904)`,
    `    [2] toolbar "History Navigation" (0,0 1440×38)`,
    `      [4] button "Back in history" (345,7 25×25)`,
    `      [7] button "Search" (439,6 618×27)`,
    `    [10] tabgroup "Workspaces" (13,32 30×347)`,
    `      [11] radiobutton "Oversteer 2" (13,51 30×30)`,
    `      [14] radiobutton "YC S2023" (13,101 30×30)`,
    `      [16] radiobutton "Ultra 1" (13,150 30×30)`,
    `      [19] radiobutton "Opensteer 2" (13,200 30×30)`,
    `        [20] image "Opensteer" (13,200 30×30)`,
    `        [21] statictext "2" (41,194 6×11)`,
    `      [22] radiobutton "Duke Startups" (13,250 30×30)`,
    `      [26] popupbutton "Add workspaces" (13,349 30×30)`,
    `    [40] toolbar "Actions" (125,39 214×47)`,
    `    [44] textfield "Channel or user name" (152,99 159×15)`,
    `    [194] textarea "Message to ${title.split(" (")[0]}" (360,801 1055×36) (focused)`,
    `    [203] button "Send now" (1352,843 30×27) (disabled)`,
  ].join("\n");
}

function observation(options: {
  readonly id: string;
  readonly notes?: string;
  readonly performed: readonly string[] | null;
  readonly stoppedBecause?: string;
  readonly title?: string;
}): string {
  const title = options.title ?? ycTitle;
  const head = formatComputerUseResultHead({
    appName: "Slack",
    elementCount: title === ycTitle ? 214 : 274,
    geometry: { height: 904, width: 1440 },
    snapshot: options.id,
    performed: options.performed,
    stoppedBecause: options.stoppedBecause ?? null,
    truncated: false,
    windowTitle: title,
  });
  return [head, tree(title), ...(options.notes ? ["", options.notes] : [])].join("\n");
}

function at(time: string): string {
  return `2026-08-06T23:${time}Z`;
}

/**
 * The turn's entries from the agent's opening note to its reply. `running`
 * stops the turn with its twelfth call in flight — the click that switches
 * workspaces — and the Run still going.
 */
export function mockComputerUseTurn(options: {
  readonly agent: MessageEntry["author"];
  /** The Mac the turn used Slack on; the recorded one unless a preview names its own. */
  readonly place?: NonNullable<IntegrationCallSubject["computerApp"]>;
  readonly runId: string;
  readonly state: "running" | "settled";
}): TranscriptEntry[] {
  const { runId } = options;
  const place = options.place ?? mockComputerUseSlack;
  let calls = 0;
  const call = (
    started: string,
    completed: string,
    fields: Pick<ToolEntry, "arguments" | "integration" | "tool"> & {
      readonly error?: boolean;
      readonly output: string;
    },
  ): ToolEntry => {
    calls += 1;
    return {
      arguments: fields.arguments,
      callId: `call_cu_${calls}`,
      completedAt: at(completed),
      createdAt: at(started),
      id: `tool:${runId}:call_cu_${calls}`,
      integration: fields.integration,
      isError: fields.error === true,
      kind: "tool",
      output: { text: fields.output },
      runId,
      state: fields.error === true ? "failed" : "done",
      streamText: "",
      tool: fields.tool,
    };
  };
  const search = { name: "integration_search", namespace: "opensteer.integrations" };
  const integrationCall = { name: "integration_call", namespace: "opensteer.integrations" };
  const observe = (started: string, completed: string, id: string, title?: string): ToolEntry =>
    call(started, completed, {
      arguments: { arguments: {}, toolRef: observeRef },
      integration: mockComputerUseSubject("observe", place),
      output: observation({ id, performed: null, ...(title ? { title } : {}) }),
      tool: integrationCall,
    });
  const act = (
    started: string,
    completed: string,
    fields: {
      readonly actions: readonly Record<string, unknown>[];
      readonly cited: string;
      readonly error?: boolean;
      readonly output: string;
    },
  ): ToolEntry =>
    call(started, completed, {
      arguments: {
        arguments: { actions: fields.actions, observationId: fields.cited },
        toolRef: actRef,
      },
      ...(fields.error === true ? { error: true } : {}),
      integration: mockComputerUseSubject("act", place),
      output: fields.output,
      tool: integrationCall,
    });

  const note: MessageEntry = {
    author: options.agent,
    body: "I’ll inspect the current Slack view first, then click the Opensteer workspace/org.",
    createdAt: at("28:10.000"),
    id: `msg_cu_${runId}_note`,
    kind: "message",
    messageKind: "assistant",
    runId,
  };
  const steps: ToolEntry[] = [
    call("28:11.406", "28:11.720", {
      arguments: { limit: 20, query: "Computer use", runnerId: place.runnerId },
      integration: null,
      output: '{"apps":[],"total":0,"nextOffset":null}',
      tool: search,
    }),
    call("28:15.913", "28:15.960", {
      arguments: {
        limit: 20,
        query: "Slack",
        runnerId: "rnr_35a353b8-9b64-460e-bc46-7d984637b47b",
      },
      error: true,
      integration: null,
      output: "Only this computer's owner can do that.",
      tool: search,
    }),
    call("28:19.266", "28:19.480", {
      arguments: { limit: 20, query: "Slack", runnerId: place.runnerId },
      integration: null,
      output: JSON.stringify({
        apps: [
          {
            access: "read-write",
            bundleId: mockComputerUseSlack.bundleId,
            name: "Slack",
            nextAction: "Call integration_call with the toolRef.",
            status: "approved",
            toolRefs: { act: actRef, observe: observeRef },
          },
        ],
        nextOffset: null,
        total: 1,
      }),
      tool: search,
    }),
    observe("28:24.156", "28:24.790", "4cf039beba5b8d92"),
    act("28:30.903", "28:31.110", {
      actions: [{ action: "click", target: { index: 19 } }],
      cited: "4cf039beba5b8d92",
      error: true,
      output: "Invalid Act arguments at $.actions[0]: must match exactly one allowed schema",
    }),
    call("28:35.368", "28:35.590", {
      arguments: { toolRef: actRef },
      integration: mockComputerUseSubject("act", place),
      output: [
        JSON.stringify({
          account: {
            alias: "This computer",
            connectionId: "con_9df27711-7b35-4eee-94bd-4f2d7b86a306",
            isDefault: false,
          },
          integration: { name: "macos-app", title: "Computer use", trust: "built-in" },
          operation: { annotations: { readOnlyHint: false }, name: "act", title: "Act" },
          path: "",
          schemaBytes: 92,
          cursor: 0,
          nextCursor: null,
        }),
        '{"inputSchema":{"type":"object","required":["observationId","actions"]},"outputSchema":null}',
      ].join("\n"),
      tool: { name: "integration_describe", namespace: "opensteer.integrations" },
    }),
    act("28:40.639", "28:41.020", {
      actions: [{ target: { index: 19 }, type: "click" }],
      cited: "4cf039beba5b8d92",
      error: true,
      output: observation({
        id: "612db06195afcd8b",
        notes: "Nothing was done. Act on this fresh observation.",
        performed: [],
        stoppedBecause: "Another window of this app came to the front.",
      }),
    }),
    observe("28:46.328", "28:46.710", "5a42824d4dd39e3e"),
    observe("28:56.640", "28:57.120", "afcb5e428528f3b8"),
    act("29:02.596", "29:02.910", {
      actions: [{ target: { x: 28, y: 215 }, type: "click" }],
      cited: "afcb5e428528f3b8",
      output: observation({ id: "000cc84d3ceceaa7", performed: ["Clicked at 28, 215"] }),
    }),
    act("29:11.671", "29:12.690", {
      actions: [
        { target: { index: 20 }, type: "click" },
        { ms: 500, type: "wait" },
      ],
      cited: "000cc84d3ceceaa7",
      output: observation({
        id: "3564d327ade80b44",
        performed: ['Clicked "Opensteer"', "Waited 500 ms"],
      }),
    }),
    act("29:22.671", "29:25.180", {
      actions: [
        { target: { index: 19 }, type: "click" },
        { ms: 2000, type: "wait" },
      ],
      cited: "3564d327ade80b44",
      output: observation({
        id: "5a757cea01c49ad5",
        performed: ['Clicked "Opensteer 2"', "Waited 2000 ms"],
        title: opensteerTitle,
      }),
    }),
    observe("29:31.723", "29:32.140", "eeb7b026dedf37fc", opensteerTitle),
  ];

  if (options.state === "running") {
    const settled = steps.slice(0, 11);
    const live = steps[11];
    if (!live) throw new Error("The Computer use turn has a twelfth call");
    return [
      note,
      ...settled,
      { ...live, completedAt: null, isError: false, output: undefined, state: "running" },
    ];
  }
  return [
    note,
    ...steps,
    {
      author: options.agent,
      body: "Done — I clicked the Opensteer organization in Slack. It’s now showing the `#openai-yc-alumni-6` channel.",
      createdAt: at("29:37.000"),
      id: `msg_cu_${runId}_reply`,
      kind: "message",
      messageKind: "assistant",
      runId,
    },
  ];
}
