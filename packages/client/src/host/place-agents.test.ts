import { TabIdSchema } from "@opensteer/core";
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
 * the idle agent is listed before the working one; Chat is named as a task.
 */

const tab = { kind: "tab", tabId: TabIdSchema.parse("tab-a") } as const;

function occupant(threadId: string, patch: Partial<PlaceOccupant> = {}): PlaceOccupant {
  return {
    acting: false,
    holding: true,

    lastActiveAt: "2026-10-20T10:00:00.000Z",
    threadId: threadId as PlaceOccupant["threadId"],
    ...patch,
  };
}

function source(patch: Partial<PlaceAgentSource> = {}): PlaceAgentSource {
  return {
    activeTasks: [],
    tasks: null,
    threads: [
      { id: "thread-hotels", title: "Compare hotels", icon: "bed", color: "purple" },
      { id: "thread-notes", title: "Shopping list", icon: null, color: null },
      { id: "thread-trip", title: "Tokyo trip", icon: "plane", color: "sky" },
    ],
    ...patch,
  } as unknown as PlaceAgentSource;
}

function place(occupants: PlaceOccupant[], destination: PlaceItem["destination"] = tab) {
  return { destination, occupants };
}

describe("place agents", () => {
  it("lists acting agents first, then the most recently active, using each task title", () => {
    const value = placeAgents(
      place([
        occupant("thread-notes", { lastActiveAt: "2026-10-20T10:05:00.000Z" }),
        occupant("thread-trip", { lastActiveAt: "2026-10-20T10:01:00.000Z" }),
        occupant("thread-hotels", { acting: true, lastActiveAt: "2026-10-20T09:00:00.000Z" }),
      ]),
      source(),
    );
    expect(value.unnamedActing).toBe(false);
    expect(value.agents.map(({ threadId }) => threadId)).toEqual([
      "thread-hotels",
      "thread-notes",
      "thread-trip",
    ]);
    expect(value.agents[1]).toMatchObject({
      mark: { icon: "document", color: null },
      title: "Shopping list",
    });
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

  it("does not say idle when an unseen agent works beside a visible idle occupant", () => {
    const value = placeAgents(
      place([occupant("thread-trip"), occupant("thread-private", { acting: true })]),
      source(),
    );
    expect(value.agents.map(({ threadId }) => threadId)).toEqual(["thread-trip"]);
    expect(placeAgentsWords(value)).toEqual({
      title: "Tokyo trip",
      detail: "Agent working",
      label: "Tokyo trip, agent working",
    });
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
