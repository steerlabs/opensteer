import { afterEach, describe, expect, it } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import type { MockSubagentScene } from "../mock/mock-subagent-scenes.js";
import { groupTranscriptEntries, type Turn } from "./agent-activity-model.js";
import type { HostSnapshot, NodeEntry, TranscriptEntry } from "./client.js";
import {
  agentCardLabel,
  noteSubagentStop,
  SubagentCache,
  subagentTurnModel,
  type AgentCard,
  type AgentPhrase,
} from "./subagent-model.js";
import {
  requestAsker,
  runningNow,
  subagentFooter,
  subagentLineage,
  subagentSiblings,
} from "./subagent-now.js";

const clients: MockHostClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
});

function scene(name: MockSubagentScene) {
  const client = new MockHostClient({ places: "absent", subagents: name });
  clients.push(client);
  const snapshot = client.getSnapshot();
  const thread = snapshot.threads.find(
    (candidate) => candidate.title === "Fix checkout on mobile",
  )!;
  const entries = snapshot.transcripts[thread.id]!;
  const turns = groupTranscriptEntries(entries).flatMap((group) =>
    group.kind === "turn" ? [group.turn] : [],
  );
  const node = (title: string) =>
    entries.find((entry): entry is NodeEntry => entry.kind === "node" && entry.title === title)!;
  return { snapshot, threadId: thread.id, turns, node, entries };
}

const words = (phrases: readonly AgentPhrase[]) => phrases.map((phrase) => phrase.text).join(" · ");

/** Each subagent row a turn draws, as "title — line two". */
function rows(snapshot: HostSnapshot, threadId: string, turn: Turn) {
  return subagentTurnModel(turn, threadId, snapshot).rows.flatMap((row) => {
    if (row.kind === "work") return [];
    if (row.kind === "workflow")
      return [`${row.card.title} — Workflow · ${words(row.card.detail)}`];
    const { group } = row;
    if (group.cards.length === 1)
      return [
        `${group.cards[0]!.title} — ${group.cards[0]!.noun} · ${words(group.cards[0]!.detail)}`,
      ];
    return [
      `${group.label} — ${words(group.detail)}`,
      ...group.cards.map((card) => `  ${card.title} — ${words(card.detail)}`),
    ];
  });
}

describe("subagent rows", () => {
  it("says one thing worth knowing for each state, with the noun on a lone row", () => {
    const one = scene("one");
    expect(rows(one.snapshot, one.threadId, one.turns.at(-1)!)).toEqual([
      "Trace the payment flow — Subagent · Checking the Stripe confirm call",
    ]);
    const three = scene("three");
    expect(rows(three.snapshot, three.threadId, three.turns.at(-1)!)).toEqual([
      "3 subagents — 2 working · 1 finished",
      "  Trace the payment flow — Checking the Stripe confirm call",
      "  Audit mobile CSS for every breakpoint across cart, checkout and the order summary drawer — Comparing touch-action in cart.css and checkout.css",
      "  Check the test suite — 42 passed, 1 skipped. Nothing covers touch events on the Pay button.",
    ]);
    const finished = scene("finished");
    const settled = rows(finished.snapshot, finished.threadId, finished.turns.at(-1)!);
    expect(settled[0]).toBe("5 subagents — 3 finished · 1 couldn't finish · 1 stopped");
    expect(settled.slice(3)).toEqual([
      "  Check the test suite — Stopped",
      "  Inspect the old checkout — Couldn't finish · Couldn't read apps/legacy-checkout: permission denied",
      "  Compare with Android Chrome — Android isn't affected: Chrome sends pointerup after a scroll.",
    ]);
  });

  it("puts nested subagents under the one that started them, and says who a parent waits for", () => {
    const { snapshot, threadId, turns } = scene("nested");
    const [group] = subagentTurnModel(turns.at(-1)!, threadId, snapshot).groups;
    const parent = group!.cards[0]!;
    expect(parent.children.map((child) => child.title)).toEqual([
      "Check webhook retries",
      "Find every caller of confirmPayment",
    ]);
    expect(parent.children[0]!.children.map((child) => child.title)).toEqual([
      "Read the Stripe retry docs",
    ]);
    expect(words(parent.detail)).toBe("Waiting for Check webhook retries");
    expect(group!.cards).toHaveLength(2);
  });

  it("asks for the person in words and never offers Stop on a question", () => {
    const { snapshot, threadId, turns } = scene("needs");
    const [group] = subagentTurnModel(turns.at(-1)!, threadId, snapshot).groups;
    expect(words(group!.detail)).toBe("1 needs you · 1 working · 1 finished");
    expect(group!.name).toBe("3 subagents: 1 needs you, 1 working, 1 finished");
    const audit = group!.cards[1]!;
    expect(audit.detail).toEqual([{ text: "Waiting for your answer", tone: "attention" }]);
    expect(audit.stop).toBeNull();
    expect(group!.lead).toBe(audit);
    expect(group!.cards[0]!.children[0]!.detail[0]!.text).toBe("Waiting for your answer");
  });

  it("lists a workflow's phases with their members, and thirty members compactly", () => {
    const workflow = scene("workflow");
    expect(rows(workflow.snapshot, workflow.threadId, workflow.turns.at(-1)!)).toEqual([
      "Verify checkout on every device — Workflow · Validate, phase 2 of 3",
    ]);
    const card = subagentTurnModel(
      workflow.turns.at(-1)!,
      workflow.threadId,
      workflow.snapshot,
    ).rows.flatMap((row) => (row.kind === "workflow" ? [row.card] : []))[0]!;
    expect(card.workflow!.phases.map((phase) => `${phase.title}: ${words(phase.detail)}`)).toEqual([
      "Explore: 3 finished",
      "Validate: 2 working · 1 finished · 1 couldn't finish",
      "Ship: Not started",
    ]);
    expect(card.workflow!.openPhase).toBe(1);
    const thirty = scene("thirty");
    const [group] = subagentTurnModel(
      thirty.turns.at(-1)!,
      thirty.threadId,
      thirty.snapshot,
    ).groups;
    expect(group).toMatchObject({ compact: true, label: "30 subagents" });
  });

  it("names a row for a screen reader once, without its ticking time", () => {
    const { snapshot, threadId, turns } = scene("three");
    const card = subagentTurnModel(turns.at(-1)!, threadId, snapshot).groups[0]!.cards[0]!;
    const now = Date.parse(card.startedAt) + 180_000;
    expect(agentCardLabel(card, now)).toBe(
      "Subagent Trace the payment flow, Working, 3 minutes. Open",
    );
  });

  it("says Last known and offers no Stop while the Host is out of reach", () => {
    const { snapshot, threadId, turns } = scene("three");
    const offline = { ...snapshot, connection: "offline" as const };
    const [group] = subagentTurnModel(turns.at(-1)!, threadId, offline).groups;
    const card = group!.cards[0]!;
    expect(card).toMatchObject({ lastKnown: true, stop: null, word: "Last known: Working" });
    expect(words(card.detail)).toBe("Last known · Checking the Stripe confirm call");
    expect(words(group!.detail)).toBe("2 last known · 1 finished");
  });

  it("says who stopped one only when this screen sent the stop", () => {
    const { snapshot, threadId, turns, node } = scene("finished");
    const stopped = node("Check the test suite");
    const card = () =>
      subagentTurnModel(turns.at(-1)!, threadId, snapshot).groups[0]!.cards.find(
        (candidate) => candidate.nodeId === stopped.nodeId,
      )!;
    expect(words(card().detail)).toBe("Stopped");
    noteSubagentStop(stopped.nodeId);
    expect(words(card().detail)).toBe("Stopped · Stopped by you");
  });

  it("counts a settled turn's subagents on its fold and keeps a running one outside it", () => {
    const { snapshot, threadId, turns } = scene("folded-one-running");
    const model = subagentTurnModel(turns.at(-1)!, threadId, snapshot, {
      folded: true,
      keptKeys: [],
    });
    expect(model.foldLabel).toMatch(/^Worked for .+ · 3 subagents$/u);
    expect(model.keptOutside?.cards.map((card) => card.title)).toEqual([
      "Run the browser test matrix",
    ]);
  });

  it("keeps every unchanged row the same object when one subagent reports progress", () => {
    const { snapshot, threadId, entries, node } = scene("thirty");
    const cache = new SubagentCache();
    const turnOf = (list: readonly TranscriptEntry[]) =>
      groupTranscriptEntries(list).findLast((group) => group.kind === "turn")!;
    const model = (list: readonly TranscriptEntry[]) => {
      const turn = turnOf(list);
      if (turn.kind !== "turn") throw new Error("Missing turn");
      return subagentTurnModel(
        turn.turn,
        threadId,
        { ...snapshot, transcripts: { ...snapshot.transcripts, [threadId]: [...list] } },
        { folded: false, keptKeys: [] },
        cache,
      );
    };
    const before = model(entries).groups[0]!.cards;
    const moving = node("Check the price on Linen throw");
    const progressed = entries.map((entry) =>
      entry === moving ? { ...moving, progress: "Reading the receipt" } : entry,
    );
    const after = model(progressed).groups[0]!.cards;
    const changed = after.filter((card, index) => card !== before[index]);
    expect(changed.map((card: AgentCard) => card.title)).toEqual([
      "Check the price on Linen throw",
    ]);
    expect(words(changed[0]!.detail)).toBe("Reading the receipt");
    // A new snapshot with nothing new in it changes nothing at all.
    expect(model([...progressed]).groups[0]!.cards).toEqual(after);
    expect(model([...progressed]).groups[0]!.cards.every((card, i) => card === after[i])).toBe(
      true,
    );
  });
});

describe("running now", () => {
  it("is empty when nothing runs, and counts what runs when something does", () => {
    const finished = scene("finished");
    expect(runningNow(finished.snapshot, finished.threadId)).toBeNull();
    const three = scene("three");
    const now = runningNow(three.snapshot, three.threadId)!;
    expect(now).toMatchObject({ count: "2 subagents working", detail: [], commands: [] });
    expect(now.rows.map((row) => row.card.title)).toEqual([
      "Trace the payment flow",
      "Audit mobile CSS for every breakpoint across cart, checkout and the order summary drawer",
    ]);
    // The newest real progress, never a prompt.
    expect(now.newest?.text).toBe("Comparing touch-action in cart.css and checkout.css");
    expect(now.name).toBe("Running now: 2 subagents working");
  });

  it("puts whoever needs the person first, nested ones under their parent", () => {
    const { snapshot, threadId } = scene("needs");
    const now = runningNow(snapshot, threadId)!;
    expect(now.rows.map((row) => [row.card.title.slice(0, 22), row.depth, row.within])).toEqual([
      ["Trace the payment flow", 0, null],
      ["Check webhook retries", 1, "Trace the payment flow"],
      ["Audit mobile CSS for e", 0, null],
    ]);
    expect(now.count).toBe("3 subagents");
    expect(words(now.detail)).toBe("2 need you · 1 working");
    expect(now.lead?.tone).toBe("needs-you");
  });

  it("lists a background command as a command, never as a subagent", () => {
    const { snapshot, threadId } = scene("workflow");
    const now = runningNow(snapshot, threadId)!;
    expect(now.commands.map((command) => command.command)).toEqual(["pnpm dev --port 5173"]);
    expect(now.rows.map((row) => [row.card.title, row.within])).toEqual([
      ["iPhone Safari", "Verify checkout on every device"],
      ["Desktop Firefox", "Verify checkout on every device"],
    ]);
    expect(now.count).toBe("2 subagents working");
    expect(words(now.detail)).toBe("1 command");
    const commandsOnly = {
      ...snapshot,
      transcripts: {
        ...snapshot.transcripts,
        [threadId]: snapshot.transcripts[threadId]!.map((entry) =>
          entry.kind === "node" && entry.nodeKind !== "task"
            ? { ...entry, status: "completed" as const }
            : entry,
        ),
      },
    };
    expect(runningNow(commandsOnly, threadId)).toMatchObject({
      count: "1 command",
      lead: null,
      rows: [],
    });
  });

  it("says last known and nothing newer while the Host is out of reach", () => {
    const { snapshot, threadId } = scene("three");
    const now = runningNow({ ...snapshot, network: "offline" }, threadId)!;
    expect(now).toMatchObject({ count: "2 subagents", newest: null });
    expect(words(now.detail)).toBe("last known");
  });
});

describe("an opened subagent", () => {
  it("names who asked a question, and the subagent a nested asker runs in", () => {
    const { snapshot, threadId, node } = scene("needs");
    const requests = snapshot.requests[threadId]!;
    const asked = (title: string) =>
      requestAsker(
        snapshot,
        requests.find((r) => r.originatingNodeId === node(title).nodeId)!,
      );
    expect(asked("Check webhook retries")).toMatchObject({
      title: "Check webhook retries",
      byline: "in Trace the payment flow",
    });
    expect(
      asked(
        node(
          "Audit mobile CSS for every breakpoint across cart, checkout and the order summary drawer",
        ).title,
      )?.byline,
    ).toBe("subagent");
  });

  it("hops between the subagents started beside it, in the order they started", () => {
    const { snapshot, threadId, node } = scene("three");
    expect(subagentSiblings(snapshot, threadId, node("Check the test suite").nodeId)).toEqual({
      index: 2,
      total: 3,
      previous: node(
        "Audit mobile CSS for every breakpoint across cart, checkout and the order summary drawer",
      ).nodeId,
      next: null,
    });
    const workflow = scene("workflow");
    expect(
      subagentSiblings(
        workflow.snapshot,
        workflow.threadId,
        workflow.node("Desktop Firefox").nodeId,
      ),
    ).toMatchObject({ index: 2, total: 4 });
    const nested = scene("nested");
    expect(
      subagentSiblings(
        nested.snapshot,
        nested.threadId,
        nested.node("Check webhook retries").nodeId,
      ),
    ).toMatchObject({ index: 0, total: 2 });
    expect(
      subagentLineage(
        nested.entries.filter((entry): entry is NodeEntry => entry.kind === "node"),
        nested.node("Read the Stripe retry docs").nodeId,
      ).map((step) => step.title),
    ).toEqual(["Trace the payment flow", "Check webhook retries"]);
  });

  it("says why there is no Stop when its engine cannot stop one subagent", () => {
    const { snapshot, threadId, turns } = scene("nested");
    const [group] = subagentTurnModel(turns.at(-1)!, threadId, snapshot).groups;
    const card = group!.cards[1]!;
    expect(card.stop).toBeNull();
    expect(subagentFooter(card, "Fix checkout on mobile", "Codex")).toEqual({
      reportsTo: "Fix checkout on mobile",
      noStop: "Codex can't stop one subagent; it stops with its turn.",
    });
    const stoppable = scene("three");
    const live = subagentTurnModel(stoppable.turns.at(-1)!, stoppable.threadId, stoppable.snapshot)
      .groups[0]!.cards[0]!;
    expect(subagentFooter(live, "Fix checkout on mobile", "Codex").noStop).toBeNull();
  });
});
