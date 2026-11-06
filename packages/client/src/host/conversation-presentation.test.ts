import { describe, expect, it } from "vitest";
import type { TranscriptGroup } from "./agent-activity-model.js";
import { conversationPlaces, conversationTimeLabel } from "./conversation-presentation.js";

const viewer = "person";
const noon = new Date(2026, 10, 6, 12, 0).getTime();
const at = (minutesBeforeNoon: number): string =>
  new Date(noon - minutesBeforeNoon * 60_000).toISOString();

const mine = (createdAt: string): TranscriptGroup =>
  ({
    key: createdAt,
    kind: "message",
    entry: {
      author: { kind: "human", userId: viewer },
      createdAt,
      messageKind: "input",
    },
  }) as TranscriptGroup;

const reply = (createdAt: string, assignments: readonly unknown[] = []): TranscriptGroup =>
  ({
    key: createdAt,
    kind: "turn",
    turn: { assignments, reply: { createdAt }, run: null },
  }) as TranscriptGroup;

describe("conversationPlaces", () => {
  it("gives a run of one voice a single tail, on its last row", () => {
    const places = conversationPlaces([mine(at(3)), mine(at(2)), reply(at(1))], viewer, noon);
    expect(places.map((place) => place.continued)).toEqual([true, false, false]);
    expect(places.map((place) => place.joined)).toEqual([false, true, false]);
  });

  it("keeps a reply's tail when what follows it is a task's line, not a bubble", () => {
    const task = {
      entry: { createdAt: at(1) },
      key: "task",
      kind: "assignment",
    } as TranscriptGroup;
    const places = conversationPlaces([reply(at(2)), task], viewer, noon);
    expect(places[0]?.continued).toBe(false);
    expect(places[1]?.joined).toBe(false);
    const started = conversationPlaces([reply(at(2), [{}]), reply(at(1))], viewer, noon);
    expect(started[0]?.continued).toBe(false);
    expect(started[1]?.joined).toBe(false);
  });

  it("says when the first row was said, and again after a pause", () => {
    const places = conversationPlaces([mine(at(200)), mine(at(199)), mine(at(100))], viewer, noon);
    expect(places.map((place) => place.time !== null)).toEqual([true, false, true]);
  });

  it("ends a run at a pause, so the row before it keeps its tail", () => {
    const places = conversationPlaces([mine(at(200)), mine(at(100))], viewer, noon);
    expect(places[0]?.continued).toBe(false);
    expect(places[1]?.joined).toBe(false);
  });

  it("names nothing for a row with no time of its own", () => {
    const silent = {
      key: "t",
      kind: "turn",
      turn: { assignments: [], reply: null, run: null },
    } as unknown as TranscriptGroup;
    expect(conversationPlaces([silent], viewer, noon)[0]?.time).toBeNull();
  });
});

describe("conversationTimeLabel", () => {
  const day = 24 * 60 * 60_000;

  it("names today and yesterday by word, across midnight rather than by hours", () => {
    const earlyToday = new Date(2026, 10, 6, 0, 30).getTime();
    const lateYesterday = new Date(2026, 10, 5, 23, 30).getTime();
    expect(conversationTimeLabel(earlyToday, noon)).toMatch(/^Today /u);
    expect(conversationTimeLabel(lateYesterday, earlyToday)).toMatch(/^Yesterday /u);
  });

  it("gives an older moment a date rather than a weekday that could be any week", () => {
    expect(conversationTimeLabel(noon - 30 * day, noon)).not.toMatch(/^(Today|Yesterday) /u);
  });
});
