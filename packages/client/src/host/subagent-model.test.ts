import { afterEach, describe, expect, it } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import { groupTranscriptEntries, turnWords, workSummary } from "./agent-activity-model.js";
import {
  conversationSubagents,
  foldedSubagentSummary,
  nodeSubagentCard,
  subagentGroup,
  subagentTurnModel,
} from "./subagent-model.js";
import type { NodeEntry } from "./client.js";

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
  return { client, snapshot, thread, entries, nodes };
}

describe("shared subagent presentation", () => {
  it("counts each status once and uses progress, results and errors in a card", () => {
    const { nodes, thread, snapshot } = fixture();
    const running = nodes.find((node) => node.title === "Trace the client")!;
    const waiting = nodes.find((node) => node.title === "Review the experience")!;
    const done = nodes.find((node) => node.title === "Research the reference")!;
    const cards = [
      running,
      waiting,
      done,
      { ...done, id: "failure", status: "failed" as const, result: "Cannot read the file" },
      { ...done, id: "stopped", status: "interrupted" as const },
    ].map((node) =>
      nodeSubagentCard(node, thread.id, nodes, Object.values(snapshot.requests).flat())!,
    );
    expect(subagentGroup(cards)).toMatchObject({
      summary: "5 subagents · 1 working · 1 waiting · 1 done · 1 failed · 1 stopped",
      counts: { total: 5, active: 2, working: 1, waiting: 1, done: 1, failed: 1, stopped: 1 },
    });
    expect(cards[0]).toMatchObject({
      line: running.progress,
      modelLabel: "gpt-6.1-sol",
      effortLabel: "high",
      open: { kind: "node-detail", nodeId: running.nodeId },
    });
    expect(cards[1]).toMatchObject({ status: "waiting", waitingOnPerson: true });
    expect(cards[2]).toMatchObject({ status: "done", line: done.result });
    expect(cards[3]).toMatchObject({ status: "failed", line: "Cannot read the file" });
  });

  it("groups workflow phases without counting members or background tasks as loose helpers", () => {
    const { snapshot, thread, entries, nodes } = fixture();
    const roster = conversationSubagents(snapshot, thread.id);
    const workflow = roster.cards.find((card) => card.kind === "workflow")!;
    expect(workflow.phases).toMatchObject([
      { index: 0, title: "Inspect", settled: 1, total: 1, status: "done" },
      { index: 1, title: "Validate", settled: 0, total: 1, status: "working" },
    ]);
    const memberIds = workflow.phases.flatMap((phase) => phase.members.map((card) => card.id));
    expect(roster.cards.every((card) => !memberIds.includes(card.id))).toBe(true);
    expect(roster.cards).toHaveLength(7);
    const background = nodes.find((node) => node.nodeKind === "task")!;
    expect(nodeSubagentCard(background, thread.id)).toBeNull();
    expect(roster.cards.some((card) => card.id === background.id)).toBe(false);
    const turn = groupTranscriptEntries(entries).findLast((group) => group.kind === "turn")!;
    if (turn.kind !== "turn") throw new Error("Missing turn");
    const model = subagentTurnModel(turn.turn, thread.id, snapshot);
    expect(model.helperCount).toBe(5);
    expect(model.rows.filter((row) => row.kind === "subagents")).toHaveLength(1);
    expect(model.rows).toContainEqual({ kind: "work", entry: background });
    expect(model.outsideFold.flatMap((group) => group.cards).map((card) => card.title)).toEqual([
      "Trace the client",
      "Review the experience",
      "Verify every surface",
    ]);
  });

  it("keeps prose between helper groups even when their timestamps are equal", () => {
    const { snapshot, thread, entries, nodes } = fixture();
    const first = nodes.find((node) => node.title === "Trace the client")!;
    const second = nodes.find((node) => node.title === "Review the experience")!;
    const note = entries.find((entry) => entry.kind === "message")!;
    if (note.kind !== "message") throw new Error("Missing note");
    const middle = {
      ...note,
      id: "between-helpers",
      runId: first.runId,
      createdAt: first.createdAt,
    };
    const work = [first, middle, { ...second, createdAt: first.createdAt }];
    const reader = { ...snapshot, transcripts: { ...snapshot.transcripts, [thread.id]: work } };
    const group = groupTranscriptEntries(work)[0]!;
    if (group.kind !== "turn") throw new Error("Missing turn");
    expect(subagentTurnModel(group.turn, thread.id, reader).rows.map((row) => row.kind)).toEqual([
      "subagents",
      "work",
      "subagents",
    ]);
  });

  it("keeps older running helpers visible when a new Run is queued and orders the full roster", () => {
    const { snapshot, thread } = fixture();
    const queued = {
      ...snapshot,
      runQueue: [
        ...snapshot.runQueue,
        {
          id: "new-run",
          threadId: thread.id,
          status: "queued" as const,
          createdAt: "2026-11-10T15:00:00.000Z",
          runOrdinal: 2,
        },
      ],
    };
    const roster = conversationSubagents(queued, thread.id);
    expect(roster.cards.map((card) => card.title)).toEqual([
      "Trace the client",
      "Review the experience",
      "Verify every surface",
      "Review the release notes",
      "Research the reference",
      "Check the tool output",
      "Inspect the contract",
    ]);
    expect(roster.pill).toMatchObject({ label: "3/7 agents" });
    expect(roster.cards.find((card) => card.origin === "assignment")).toMatchObject({
      open: { kind: "conversation" },
      status: "done",
      line: "Release notes reviewed; all surfaces are covered.",
    });
  });

  it("names helpers in a folded finished turn and leaves running cards outside its words", () => {
    const { entries, nodes } = fixture();
    const turn = groupTranscriptEntries(entries).find((group) => group.kind === "turn")!;
    if (turn.kind !== "turn") throw new Error("Missing turn");
    expect(workSummary(turn.turn)?.label).toBe("Worked for 22m · 1 subagent");
    expect(foldedSubagentSummary("Worked 22m", 3)).toBe("Worked 22m · 3 subagents");
    const live = nodes.find((node) => node.title === "Trace the client")!;
    expect(turnWords({ ...turn.turn, work: [...turn.turn.work, live] })).toContainEqual(live);
  });
});
