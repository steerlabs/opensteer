import {
  conversationSurfaces,
  conversationThreadIds,
  surfaceDestination,
  type HostSnapshot,
} from "@opensteer/client/host";
import { createId } from "@opensteer/core";
import { MockHostClient } from "@opensteer/client/mock";
import { afterAll, describe, expect, it } from "vitest";
import { actingFor } from "../browser/agent-surface.js";
import {
  aroundGlanceSelector,
  aroundFrom,
  aroundLabel,
  aroundPlaces,
  sameAroundGlance,
} from "./around-model.js";

// Loaded and connected, so the Mac apps and phones its Runs hold are listed.
const client = new MockHostClient({ latencyMs: 0 });
await client.load();
afterAll(() => client.dispose());
const source = client.getSnapshot();
const home = source.homeThreadId!;
const titled = (title: string) => source.threads.find((thread) => thread.title === title)!.id;
const glance = (snapshot: HostSnapshot, threadId: string) =>
  aroundGlanceSelector(threadId)(snapshot);

describe("around a conversation", () => {
  // Failure: a tab another conversation acts in reads as working here, the
  // working ones sink under idle ones, or a row opens a sibling of its place.
  it("lists the places an agent of the conversation works in first, each opening exactly its own", () => {
    const threadId = titled("Switch Slack to Opensteer");
    const items = conversationSurfaces(source, threadId);
    const threads = conversationThreadIds(source, threadId);
    const places = aroundPlaces(source, threadId);
    const working = items.filter((item) => actingFor(item, threads));
    expect(working.length).toBeGreaterThan(0);
    expect(working.length).toBeLessThan(items.length);
    expect(places.map(({ key }) => key)).toEqual([
      ...working.map(({ key }) => key),
      ...items.filter((item) => !actingFor(item, threads)).map(({ key }) => key),
    ]);
    for (const place of places) {
      const item = items.find(({ key }) => key === place.key)!;
      expect(place.destination).toEqual(surfaceDestination(item));
      expect(place.working).toBe(actingFor(item, threads));
    }
    const app = places.find(({ glyph }) => glyph === "laptopcomputer")!;
    const item = items.find(({ key }) => key === app.key);
    expect(item?.kind === "app" && [app.title, app.detail]).toEqual([
      item?.kind === "app" && item.app.displayName,
      item?.kind === "app" && item.machine.name,
    ]);
  });

  // Failure: Chat counts a parent, counts are wrong, a mixed set of places
  // claims one kind, or schedules a Host never sent appear.
  it("sums places, tasks and schedules, and names the conversation a task works for", () => {
    const chat = glance(source, home)!;
    expect(chat).toMatchObject({
      from: null,
      places: aroundPlaces(source, home).length,
      placesWorking: aroundPlaces(source, home).filter(({ working }) => working).length,
      placeGlyph: null,
      family: { running: 1, needsYou: true, automations: source.threadAutomations[home]!.length },
    });
    const worker = titled("Book a table for Friday");
    expect(glance(source, worker)).toEqual({
      family: null,
      from: { threadId: home, title: "Chat" },
      placeGlyph: null,
      places: 0,
      placesWorking: 0,
    });
    expect(aroundLabel(glance(source, worker)!)).toBe("From Chat");
    const phone = glance(source, titled("Check the delivery ETA"))!;
    expect(phone).toMatchObject({ placeGlyph: "smartphone", places: 1, placesWorking: 1 });
    expect(aroundLabel(phone)).toBe("1 place open, 1 working");
  });

  // Failure: an old Host without `task-family-v1` sends no automations, and a
  // conversation with only those must not keep an empty control.
  it("has nothing to show for a conversation with nothing around it", () => {
    const threadId = titled("Review PortableFS integration");
    expect(glance(source, threadId)?.family?.automations).toBe(1);
    const old = { ...source, browserSessions: [], threadAutomations: {} };
    expect(glance(old, threadId)).toBeNull();
    const chat = glance({ ...source, threadAutomations: {} }, home)!;
    expect(chat.family?.automations).toBe(0);
    expect(aroundLabel(chat)).not.toContain("schedule");
  });

  it("links a reused worker to its current Assignment parent, never its original or a hidden parent", () => {
    const worker = titled("Book a table for Friday");
    const parent = titled("Switch Slack to Opensteer");
    const assignment = Object.values(source.assignments).find((a) => a.workerThread.id === worker)!;
    const reused = {
      ...assignment,
      id: createId("delegation"),
      createdAt: "2099-01-01T00:00:00.000Z",
      parentThreadId: parent as typeof assignment.parentThreadId,
    };
    const snapshot = {
      ...source,
      assignments: {
        [assignment.id]: { ...assignment, status: "completed" as const },
        [reused.id]: reused,
      },
    };
    expect(aroundFrom(snapshot, worker)).toEqual({
      threadId: parent,
      title: "Switch Slack to Opensteer",
    });
    const hidden = { ...reused, parentThreadId: "hidden-parent" as typeof reused.parentThreadId };
    expect(aroundFrom({ ...snapshot, assignments: { [hidden.id]: hidden } }, worker)).toBeNull();
  });

  it("pluralizes place and earlier-task counts without announcing zero sections", () => {
    const empty = { places: 0, placesWorking: 0, placeGlyph: null, from: null, family: null };
    expect(aroundLabel(empty)).toBe("");
    expect(aroundLabel({ ...empty, places: 2, placesWorking: 1 })).toBe("2 places open, 1 working");
    const family = { marks: [], running: 0, needsYou: false, automations: 0, earlier: 1 };
    expect(aroundLabel({ ...empty, family })).toBe("1 earlier task");
    expect(aroundLabel({ ...empty, family: { ...family, earlier: 2 } })).toBe("2 earlier tasks");
  });

  // Failure: a streamed token publishes a snapshot that reads as a new glance.
  it("reads the same while only a transcript changes", () => {
    const select = aroundGlanceSelector(home);
    const before = select(source);
    const after = select({
      ...source,
      transcripts: { ...source.transcripts, [home]: [...(source.transcripts[home] ?? [])] },
    });
    expect(sameAroundGlance(before, after)).toBe(true);
    expect(sameAroundGlance(before, select({ ...source, threadAutomations: {} }))).toBe(false);
  });
});
