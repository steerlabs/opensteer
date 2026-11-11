import { afterEach, describe, expect, it } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import { groupTranscriptEntries } from "./agent-activity-model.js";
import {
  agentCardLabel,
  agentMemberWord,
  agentPhaseLabel,
  assignmentSubagentCard,
  conversationSubagents,
  earlierHelpers,
  foldedSubagentSummary,
  nodeSubagentCard,
  subagentGroup,
  subagentPreview,
  subagentTitle,
  subagentTurnModel,
  visibleAgentMembers,
} from "./subagent-model.js";
import type { NodeEntry } from "./client.js";
import { taskFamily } from "./task-family.js";
const clients: MockHostClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
});
function fixture() {
  const client = new MockHostClient({ places: "absent" });
  clients.push(client);
  const snapshot = client.getSnapshot();
  const thread = snapshot.threads.find((thread) => thread.title === "Subagents everywhere")!;
  const entries = snapshot.transcripts[thread.id]!;
  const nodes = entries.filter((entry): entry is NodeEntry => entry.kind === "node");
  const node = nodes.find((node) => node.title === "Trace the client")!;
  const turn = groupTranscriptEntries(entries).findLast((group) => group.kind === "turn")!;
  if (turn.kind !== "turn") throw new Error("Missing turn");
  return { snapshot, thread, entries, nodes, node, turn: turn.turn };
}
describe("shared agent contract", () => {
  it("uses answerable requests only for Needs you and retains stale words without motion", () => {
    const { snapshot, nodes, thread, node } = fixture();
    const waiting = nodes.find((node) => node.title === "Review the experience")!;
    const card = nodeSubagentCard(waiting, thread.id, nodes, snapshot)!;
    expect(card).toMatchObject({
      tone: "needs-you",
      word: "Needs you",
      moving: false,
      line: { kind: "question", text: "Which surface should I inspect first?" },
    });
    expect(card.requestId).not.toBeNull();
    expect(
      nodeSubagentCard(waiting, thread.id, nodes, { ...snapshot, waitingRequests: [] }),
    ).toMatchObject({ tone: "waiting", word: "Waiting", requestId: null });
    for (const [status, tone, word] of [
      ["running", "working", "Working"],
      ["completed", "finished", "Finished"],
      ["failed", "failed", "Couldn't finish"],
      ["interrupted", "stopped", "Stopped"],
    ] as const) {
      expect(nodeSubagentCard({ ...node, status }, thread.id, nodes, snapshot)).toMatchObject({
        tone,
        word,
        moving: status === "running",
      });
    }
    expect(
      nodeSubagentCard(node, thread.id, nodes, { ...snapshot, network: "offline" }),
    ).toMatchObject({ word: "Last known: Working", moving: false });
    const failed = nodeSubagentCard({ ...node, status: "failed" }, thread.id, nodes, snapshot)!;
    expect(agentMemberWord(failed)).toBe("Failed");
    expect(
      agentCardLabel(
        { ...failed, endedAt: new Date(Date.parse(failed.startedAt) + 72_000).toISOString() },
        0,
      ),
    ).toBe(
      `Trace the client, subagent, Couldn't finish, 1 minute 12 seconds. ${failed.line!.text}`,
    );
    expect(
      nodeSubagentCard({ ...node, status: "completed" }, thread.id, nodes, {
        ...snapshot,
        network: "offline",
      })?.word,
    ).toBe("Finished");
  });
  it("uses only summary data for lines and catalog names for models", () => {
    const { snapshot, nodes, thread, node } = fixture();
    const card = (patch: Partial<NodeEntry>) =>
      nodeSubagentCard({ ...node, ...patch }, thread.id, nodes, snapshot)!;
    expect(card({ progress: "**Reading** `files`" }).line).toEqual({
      kind: "progress",
      text: "Reading files",
    });
    expect(card({ progress: null, prompt: "# Check this\nsecond line" }).line).toEqual({
      kind: "prompt",
      text: "Check this",
    });
    expect(card({ status: "completed", result: "[Done](https://example.com)" }).line).toEqual({
      kind: "result",
      text: "Done",
    });
    expect(card({ status: "failed", result: "Failure" }).line).toEqual({
      kind: "error",
      text: "Failure",
    });
    expect(card({ status: "failed", result: null, prompt: "Fallback" }).line).toEqual({
      kind: "prompt",
      text: "Fallback",
    });
    expect(card({ model: "unknown-model" }).modelLabel).toBeNull();
    const catalog = snapshot.environments
      .flatMap((env) => env.harnessCatalogs)
      .flatMap((catalog) => catalog.models)[0]!;
    expect(card({ model: catalog.modelId, effort: "high" }).modelLabel).toBe(
      `${catalog.displayName} · High`,
    );
    expect(subagentTitle("Subagent: /root/check_the-tests")).toBe("Check The Tests");
    expect(subagentPreview("👩‍💻".repeat(281))).toBe("👩‍💻".repeat(279) + "…");
  });
  it("builds the spec summaries and defaults expansion to live", () => {
    const { node, thread } = fixture();
    const card = nodeSubagentCard(node, thread.id)!;
    const cards = (tones: (typeof card.tone)[]) =>
      tones.map((tone, index) => ({ ...card, key: `node:${index}`, tone }));
    expect(subagentGroup(cards(["working", "waiting", "finished"]))).toMatchObject({
      summary: "3 subagents · 2 working · 1 finished",
      live: true,
      key: "node:0",
      endedAt: null,
    });
    expect(
      subagentGroup(cards(["needs-you", "working", "working", "working", "working"])).summary,
    ).toBe("5 subagents · 1 needs you · 4 working");
    expect(
      subagentGroup(
        cards(["finished", "finished"]).map((card) => ({ ...card, origin: "task" as const })),
      ),
    ).toMatchObject({ summary: "2 tasks · 2 finished", live: false });
    const many = cards(Array.from({ length: 12 }, (_, i) => (i === 10 ? "needs-you" : "working")));
    expect(visibleAgentMembers(many)).toMatchObject({
      cards: [...many.slice(0, 8), many[10]],
      remaining: 3,
    });
  });
  it("keeps workflows separate, chooses the open phase, and places nested nodes only in their own view", () => {
    const { snapshot, thread, turn, node, nodes } = fixture();
    const model = subagentTurnModel(turn, thread.id, snapshot);
    expect(model.rows.filter((row) => row.kind === "workflow")).toHaveLength(1);
    expect(
      model.groups
        .flatMap((group) => group.cards)
        .some((card) => card.title === "Check the tool output"),
    ).toBe(false);
    const workflow = conversationSubagents(snapshot, thread.id).now.find(
      (card) => card.kind === "workflow",
    )!.workflow!;
    expect(workflow).toMatchObject({
      openPhase: 1,
      summary: "Phase 2 of 3 · Validate · 0 of 1 finished",
      phases: [
        { settled: 1, total: 1, word: "Finished", tone: "finished" },
        { settled: 0, total: 1, word: "Working", tone: "working" },
        { settled: 0, total: 0, word: "Not started", tone: "pending" },
      ],
    });
    expect(agentPhaseLabel(workflow.phases[1]!)).toBe(
      "Phase 2, Validate, Working, 0 of 1 finished",
    );
    const parent = nodes.find((n) => n.nodeKind === "workflow")!;
    const failed = nodes.map((n) =>
      n.parentNodeId === parent.nodeId ? { ...n, status: "failed" as const } : n,
    );
    expect(
      nodeSubagentCard({ ...parent, status: "failed" }, thread.id, failed, snapshot)?.workflow,
    ).toMatchObject({
      openPhase: 0,
      phases: [
        { word: "1 failed", tone: "failed" },
        { word: "1 failed", tone: "failed" },
        { word: "Not started", tone: "pending" },
      ],
    });
    expect(
      subagentTurnModel(
        {
          ...turn,
          run: { ...turn.run!, status: "completed", endedAt: "2026-11-10T15:00:00.000Z" },
        },
        thread.id,
        snapshot,
      ).foldLabel,
    ).toContain("8 subagents · 1 task");
    expect(foldedSubagentSummary("Worked for 22m", 3, 1)).toBe(
      "Worked for 22m · 3 subagents · 1 task",
    );
    expect(foldedSubagentSummary("Worked", 1)).toBe("Worked · 1 subagent");
    const folded = subagentTurnModel(turn, thread.id, snapshot, { folded: true, keptKeys: [] });
    expect(folded.keptOutside?.cards.some((card) => card.key === `node:${node.nodeId}`)).toBe(true);
    const settled = {
      ...turn,
      work: turn.work.map((entry) =>
        entry.id === node.id ? { ...node, status: "completed" as const } : entry,
      ),
    };
    const retained = subagentTurnModel(settled, thread.id, snapshot, {
      folded: true,
      keptKeys: folded.keptKeys,
    });
    expect(
      retained.keptOutside?.cards.find((card) => card.key === `node:${node.nodeId}`)?.tone,
    ).toBe("finished");
    expect(
      subagentTurnModel(settled, thread.id, snapshot, { folded: false, keptKeys: folded.keptKeys })
        .keptOutside,
    ).toBeNull();
  });
  it("orders the roster, includes nested helpers, and hides a settled pill", () => {
    const { snapshot, thread } = fixture();
    const roster = conversationSubagents(snapshot, thread.id);
    expect(roster.now.map((card) => card.title)).toEqual([
      "Review the experience",
      "Trace the client",
      "Verify every surface",
      "Wait for another reader",
    ]);
    // A workflow's members are listed inside its row, never again beside it.
    const workflow = roster.now.find((card) => card.title === "Verify every surface")!;
    expect(
      workflow.workflow!.phases.flatMap((phase) => phase.members.map((card) => card.title)),
    ).toContain("Validate phone behavior");
    expect(roster.earlier.some((card) => card.title === "Check the tool output")).toBe(true);
    expect(roster.pill).toEqual({ live: 4, total: 10, needsYou: 1 });
    const settled = {
      ...snapshot,
      transcripts: {
        ...snapshot.transcripts,
        [thread.id]: snapshot.transcripts[thread.id]!.map((entry) =>
          entry.kind === "node" ? { ...entry, status: "completed" as const } : entry,
        ),
      },
    };
    expect(conversationSubagents(settled, thread.id).pill).toBeNull();
    const helpers = conversationSubagents(snapshot, thread.id, { tasks: false });
    expect(helpers.pill).toEqual({ live: 4, total: 9, needsYou: 1 });
    expect([...helpers.now, ...helpers.earlier].every((card) => card.origin === "subagent")).toBe(
      true,
    );
    const family = taskFamily(snapshot, thread.id);
    const earlier = earlierHelpers(helpers.earlier, family.earlier);
    expect(earlier.length).toBe(helpers.earlier.length + family.earlier.length);
    const ends = earlier.map((item) =>
      item.kind === "agent" ? (item.card.endedAt ?? item.card.startedAt) : item.task.finishedAt!,
    );
    expect(ends).toEqual(ends.toSorted().reverse());
    const assignment = Object.values(snapshot.assignments).find(
      (a) => a.parentThreadId === thread.id,
    )!;
    expect(assignmentSubagentCard(assignment, snapshot)).toMatchObject({
      origin: "task",
      word: "Finished",
      tone: "finished",
      task: { assignmentId: assignment.id, menu: true },
      opens: { kind: "thread" },
      line: { kind: "result", text: assignment.resultPreview },
    });
  });
});

it("offers Stop only from live Host eligibility and says Stopping until it ends", () => {
  const base = {
    nodeId: "node-stop",
    nodeKind: "subagent",
    kind: "node",
    id: "node:node-stop",
    runId: "run",
    status: "running",
    title: "Inspect",
    createdAt: "2026-11-10T00:00:00Z",
    completedAt: null,
    model: null,
    effort: null,
    parentNodeId: null,
    originCallId: null,
    phaseIndex: null,
    phases: [],
    progress: null,
    prompt: null,
    result: null,
  } as const;
  expect(nodeSubagentCard(base, "thread")?.stop).toBeNull();
  expect(nodeSubagentCard({ ...base, canStop: true }, "thread")?.stop).toEqual({
    threadId: "thread",
    nodeId: "node-stop",
  });
  const stopping = nodeSubagentCard({ ...base, canStop: true, stopping: true }, "thread")!;
  expect(stopping.stop).toBeNull();
  expect(stopping.word).toBe("Stopping");
  expect(
    nodeSubagentCard({ ...base, canStop: true, status: "completed" }, "thread")?.stop,
  ).toBeNull();
});
