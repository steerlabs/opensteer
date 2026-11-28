import { describe, expect, it } from "vitest";
import { mockAgentWork } from "../mock/mock-agent-work.js";
import { mockConnectedAgents } from "../mock/mock-connected-agents.js";
import type { ThreadSummary } from "./client.js";
import { connectedAgentEarlier } from "./connected-agent-earlier.js";

const now = new Date(2026, 10, 24, 16);
const { connections } = mockConnectedAgents("seeded", now);
const seed = mockAgentWork({
  now,
  connections,
  userId: "usr_0192f4a1-0000-4000-8000-000000000001",
  template: { title: "Task", status: "idle" } as ThreadSummary,
});
const times = [
  new Date(2026, 10, 24, 15).toISOString(),
  new Date(2026, 10, 23, 13).toISOString(),
  new Date(2026, 10, 22, 10).toISOString(),
] as const;
const operation = (
  index: number,
  at: string,
  { place = "Shopping", of = index }: { place?: string; of?: number } = {},
) => {
  const { operation: own } = seed.operations[index]!;
  const { operation: session } = seed.operations[of]!;
  return {
    ...own,
    taskId: session.taskId,
    sessionId: session.sessionId,
    tool: "tab_open",
    state: "completed" as const,
    outcome: "completed" as const,
    target: {
      ...own.target,
      name: place,
      grant: { kind: "browser-profile" as const, profileId: place },
    },
    createdAt: at,
    handedOffAt: at,
    completedAt: at,
  };
};

describe("earlier work by session", () => {
  const group = (
    operations: Parameters<typeof connectedAgentEarlier>[0]["operations"],
    hasEarlier = false,
    activeSessionIds: ReadonlySet<string> = new Set(),
  ) => connectedAgentEarlier({ operations, hasEarlier, activeSessionIds, now });

  it("sorts sessions by their latest action under local day headings", () => {
    const today = operation(0, times[0]);
    const yesterday = operation(6, times[1], { place: "Travel" });
    const older = operation(8, times[2]);
    expect(group([older, today, yesterday])).toMatchObject([
      {
        label: "Today",
        sessions: [
          {
            threadId: today.taskId,
            action: "Opened a tab in Shopping",
            outcome: "Done",
            at: times[0],
            actionCount: 1,
          },
        ],
      },
      {
        label: "Yesterday",
        sessions: [{ threadId: yesterday.taskId, place: "Travel", actionCount: 1 }],
      },
      {
        label: new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
          new Date(times[2]),
        ),
        sessions: [{ threadId: older.taskId, actionCount: 1 }],
      },
    ]);
  });

  it("counts distinct places and settles a split group after its remaining actions arrive", () => {
    const latest = operation(0, times[0]);
    const repeatedPlace = operation(1, times[1], { of: 0 });
    const olderPlace = operation(2, times[2], { of: 0, place: "Travel" });
    expect(group([latest], true)[0]?.sessions).toMatchObject([{ actionCount: null }]);
    expect(group([latest, repeatedPlace, olderPlace, latest])[0]?.sessions).toMatchObject([
      { actionCount: 3, place: "2 places", at: times[0] },
    ]);
  });

  it("does not publish partial counts for newer groups when the pages interleave sessions", () => {
    const latest = operation(0, times[0]);
    const between = operation(6, times[1], { place: "Travel" });
    const oldest = operation(2, times[2], { of: 0 });
    expect(
      group([latest, between], true).flatMap(({ sessions }) =>
        sessions.map(({ actionCount }) => actionCount),
      ),
    ).toEqual([null, null]);
    expect(
      group([latest, between, oldest]).flatMap(({ sessions }) =>
        sessions.map(({ actionCount }) => actionCount),
      ),
    ).toEqual([2, 1]);
  });

  it("leaves out work shown in Now and leaves no group when there is no past work", () => {
    const active = operation(0, times[0]);
    expect(group([])).toEqual([]);
    expect(group([active], false, new Set([active.sessionId]))).toEqual([]);
  });
});
