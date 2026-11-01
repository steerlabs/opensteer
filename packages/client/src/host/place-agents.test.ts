import { describe, expect, it } from "vitest";
import type { PlaceOccupant } from "@opensteer/protocol";
import {
  placeAgents,
  placeAgentsWords,
  samePlaceAgents,
  type PlaceAgentSource,
} from "./place-agents.js";
import type { PlaceItem } from "./places.js";

/*
 * Who a place's bar names. What can go wrong: an agent is invented from the
 * route or picked by being nearby; a Thread the reader cannot open is offered;
 * the idle agent is listed before the working one; Chat is named as a task;
 * an older Host's anonymous acting is dropped, or named after someone.
 */

const tab = { kind: "browser", sessionId: "browser-a", tabId: "tab-a" } as const;

function occupant(threadId: string, patch: Partial<PlaceOccupant> = {}): PlaceOccupant {
  return {
    acting: false,
    holding: true,
    home: false,
    lastActiveAt: "2026-10-20T10:00:00.000Z",
    threadId: threadId as PlaceOccupant["threadId"],
    ...patch,
  };
}

function source(patch: Partial<PlaceAgentSource> = {}): PlaceAgentSource {
  return {
    activeTasks: [],
    browserSessions: [],
    machines: [],
    tasks: null,
    threads: [
      { id: "thread-hotels", title: "Compare hotels", icon: "bed", color: "purple" },
      { id: "thread-trip", title: "Tokyo trip", icon: "plane", color: "sky" },
    ],
    workspaceTasks: {},
    ...patch,
  } as unknown as PlaceAgentSource;
}

function place(occupants: PlaceOccupant[], destination: PlaceItem["destination"] = tab) {
  return { destination, occupants };
}

describe("place agents", () => {
  it("lists acting agents first, then the most recently active, with Chat wearing its own name", () => {
    const value = placeAgents(
      place([
        occupant("thread-home", { home: true, lastActiveAt: "2026-10-20T10:05:00.000Z" }),
        occupant("thread-trip", { lastActiveAt: "2026-10-20T10:01:00.000Z" }),
        occupant("thread-hotels", { acting: true, lastActiveAt: "2026-10-20T09:00:00.000Z" }),
      ]),
      source(),
    );
    expect(value.unnamedActing).toBe(false);
    expect(value.agents.map(({ threadId }) => threadId)).toEqual([
      "thread-hotels",
      "thread-home",
      "thread-trip",
    ]);
    expect(value.agents[1]).toMatchObject({ home: true, mark: null, title: "Chat" });
    expect(value.agents[0]?.mark).toEqual({ color: "purple", icon: "bed" });
    expect(placeAgentsWords(value)).toEqual({
      detail: "1 working",
      label: "3 agents, 1 working",
      title: "3 agents",
    });
  });

  it("names nobody in an empty place and says one agent's state", () => {
    expect(placeAgentsWords(placeAgents(place([]), source()))).toBeNull();
    expect(
      placeAgentsWords(placeAgents(place([occupant("thread-trip", { acting: true })]), source())),
    ).toEqual({ detail: "Working here", label: "Tokyo trip, working here", title: "Tokyo trip" });
  });

  it("drops a Thread the reader cannot open, keeping only that someone acts", () => {
    const hidden = placeAgents(place([occupant("thread-elsewhere", { acting: true })]), source());
    expect(hidden).toEqual({ agents: [], unnamedActing: true });
    expect(placeAgentsWords(hidden)).toEqual({
      detail: null,
      label: "Agent working",
      title: "Agent working",
    });
    expect(placeAgents(place([occupant("thread-elsewhere")]), source())).toEqual({
      agents: [],
      unnamedActing: false,
    });
  });

  it("says an older Host's browser acts without naming anyone, only for its one tab", () => {
    const browser = (tabs: { id: string; occupants: PlaceOccupant[] }[]) =>
      source({
        browserSessions: [
          { id: "browser-a", state: "ready", acting: true, tabCatalog: { tabs } },
        ] as unknown as PlaceAgentSource["browserSessions"],
      });
    expect(placeAgents(place([]), browser([{ id: "tab-a", occupants: [] }])).unnamedActing).toBe(
      true,
    );
    // Two tabs: the browser's flag cannot say which one.
    expect(
      placeAgents(
        place([]),
        browser([
          { id: "tab-a", occupants: [] },
          { id: "tab-b", occupants: [] },
        ]),
      ).unnamedActing,
    ).toBe(false);
    // A Host that names who acts named someone in another tab.
    expect(
      placeAgents(
        place([]),
        browser([{ id: "tab-a", occupants: [occupant("thread-trip", { acting: true })] }]),
      ).unnamedActing,
    ).toBe(false);
  });

  it("says a task session acts on an app without an actor, and never for the person's own view", () => {
    const machines = (actor: { threadId: string; home: boolean } | null) =>
      [
        {
          id: "mac-a",
          computerUse: {
            sessions: [{ sessionId: "session-a", actor, actingAppKeys: ["notes"], apps: [] }],
          },
        },
      ] as unknown as PlaceAgentSource["machines"];
    const app = {
      appKey: "notes",
      computerSessionId: "session-a",
      kind: "app",
      machineId: "mac-a",
    } as const;
    expect(placeAgents(place([], app), source({ machines: machines(null) })).unnamedActing).toBe(
      true,
    );
    expect(
      placeAgents(place([], app), source({ machines: machines({ home: false, threadId: "x" }) }))
        .unnamedActing,
    ).toBe(false);
    expect(
      placeAgents(
        place([], {
          appKey: "notes",
          kind: "app",
          machineId: "mac-a",
          source: { generation: 1, kind: "owner-view", viewId: "view-a" },
        }),
        source({ machines: machines(null) }),
      ).unnamedActing,
    ).toBe(false);
  });

  it("compares answers by what the bar says", () => {
    const one = placeAgents(place([occupant("thread-trip")]), source());
    expect(samePlaceAgents(one, placeAgents(place([occupant("thread-trip")]), source()))).toBe(
      true,
    );
    expect(
      samePlaceAgents(
        one,
        placeAgents(place([occupant("thread-trip", { acting: true })]), source()),
      ),
    ).toBe(false);
  });
});
