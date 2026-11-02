import {
  conversationSurfaces,
  conversationThreadIds,
  surfaceDestination,
  taskFamily,
  type FamilyTask,
  type HostSnapshot,
  type TaskFamily,
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
  aroundSections,
  earlierDays,
  openingSection,
  sameAroundGlance,
  shownSection,
  type AroundPlace,
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

describe("the sheet's sections", () => {
  const place = aroundPlaces(source, home)[0]!;
  const idle: AroundPlace = { ...place, working: false };
  const family = taskFamily(source, home);
  const running = family.running[0]!;
  const task = (patch: Partial<FamilyTask>): FamilyTask => ({
    ...running,
    needsYou: false,
    ...patch,
  });
  const empty: TaskFamily = { automations: [], earlier: [], running: [] };

  // Failure: a tile stands for a section with nothing in it, or tiles change order.
  it("offers only the sections with something in them, in the button's order", () => {
    expect(aroundSections([], empty)).toEqual([]);
    expect(aroundSections([idle], { ...family, earlier: [task({})] })).toEqual([
      "places",
      "tasks",
      "earlier",
      "schedules",
    ]);
    expect(aroundSections([], { ...empty, automations: family.automations })).toEqual([
      "schedules",
    ]);
  });

  // Failure: the sheet opens on Places while a task waits on the reader, or on
  // an empty section.
  it("opens on what needs the reader, then on where an agent works, then on the first section", () => {
    const waiting = { ...empty, running: [task({}), task({ needsYou: true })] };
    expect(openingSection([place], waiting)).toBe("tasks");
    expect(openingSection([idle, place], { ...waiting, running: [task({})] })).toBe("places");
    expect(openingSection([idle], { ...empty, running: [task({})] })).toBe("places");
    expect(
      openingSection([], { ...empty, earlier: [task({})], automations: family.automations }),
    ).toBe("earlier");
    expect(openingSection([], empty)).toBeNull();
  });

  // Failure: the chosen section jumps as data changes, or a section that
  // emptied stays shown blank.
  it("keeps the chosen section while it has anything, then falls to the first that does", () => {
    expect(shownSection("schedules", ["places", "tasks", "schedules"])).toBe("schedules");
    expect(shownSection("tasks", ["places", "schedules"])).toBe("places");
    expect(shownSection("tasks", [])).toBeNull();
  });

  // Failure: finished tasks lose their newest-first order, or a day is named
  // by a clock rather than the way Messages and Mail name it.
  it("groups earlier tasks by the day they finished", () => {
    const now = new Date(2026, 10, 6, 15, 0).getTime(); // Friday 6 November 2026
    const at = (month: number, day: number, hour = 9) =>
      new Date(2026, month, day, hour).toISOString();
    const tasks = [
      task({ assignmentId: "a", finishedAt: at(10, 6, 14) }),
      task({ assignmentId: "b", finishedAt: at(10, 6, 0) }),
      task({ assignmentId: "c", finishedAt: at(10, 5, 23) }),
      task({ assignmentId: "d", finishedAt: at(10, 2) }),
      task({ assignmentId: "e", finishedAt: at(9, 20) }),
      task({ assignmentId: "f", finishedAt: new Date(2025, 11, 31).toISOString() }),
      task({ assignmentId: "g", finishedAt: null }),
    ];
    expect(
      earlierDays(tasks, now).map((day) => [day.title, day.tasks.map((t) => t.assignmentId)]),
    ).toEqual([
      ["Today", ["a", "b"]],
      ["Yesterday", ["c"]],
      ["Monday", ["d"]],
      ["October 20", ["e"]],
      ["December 31, 2025", ["f"]],
      ["Earlier", ["g"]],
    ]);
  });
});
