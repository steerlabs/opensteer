import {
  conversationSurfaces,
  taskFamily,
  type FamilyTask,
  type HostSnapshot,
  type TaskFamily,
} from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { tabFixture, tabStoreFixture } from "@opensteer/client/test-support";
import { createId, TabIdSchema, ThreadIdSchema, type Tab } from "@opensteer/core";
import { afterAll, describe, expect, it } from "vitest";
import {
  aroundGlanceSelector,
  aroundFrom,
  aroundLabel,
  aroundPlaces,
  aroundSections,
  aroundYieldable,
  earlierDays,
  openingSection,
  sameAroundGlance,
  shownSection,
  type ActivityOf,
  type AroundPlace,
} from "./around-model.js";

const client = new MockHostClient({ latencyMs: 0 });
await client.load();
afterAll(() => client.dispose());
const source = client.getSnapshot();
const home = source.threads[0]!.id;
const titled = (title: string) => source.threads.find((thread) => thread.title === title)!.id;
/** The Host's per-tab activity, as these tests set it: who acts in which tab. */
const acting =
  (byTab: Record<string, readonly string[]>): ActivityOf =>
  (tabId) =>
    (byTab[tabId] ?? []).map((threadId) => ({ threadId: ThreadIdSchema.parse(threadId) }));
const nobody = acting({});
const glance = (snapshot: HostSnapshot, threadId: string, activity = nobody) =>
  aroundGlanceSelector(threadId, activity)(snapshot);
const noTabs = tabStoreFixture([]);

describe("around a conversation", () => {
  const items = conversationSurfaces(source, home);
  const worker = titled("Book a table for Friday");
  // Activity in a tab of its own, in one its delegated task uses, and in a
  // tab it holds that only another conversation acts in.
  const own = items[2]!;
  const delegated = items.find(({ tab }) => tab.usedBy.every(({ taskId }) => taskId === worker))!;
  const shared = items[0]!;
  const activity = acting({
    [own.key]: [home],
    [delegated.key]: [worker],
    [shared.key]: [titled("Review storage integration")],
  });

  // Failure: a tab another conversation acts in reads as working here, the
  // working ones sink under idle ones, or a row opens a sibling of its place.
  it("lists the places an agent of the conversation works in first, each opening exactly its own", () => {
    expect(new Set([own, delegated, shared]).size).toBe(3);
    const places = aroundPlaces(source, home, activity);
    expect(places.map(({ key, working }) => [key, working])).toEqual([
      [own.key, true],
      [delegated.key, true],
      ...items.filter((item) => item !== own && item !== delegated).map(({ key }) => [key, false]),
    ]);
    for (const place of places)
      expect(place.destination).toEqual({ kind: "tab", tabId: place.key });
    const window = items.find(({ kind }) => kind === "window")!;
    expect(places.find(({ key }) => key === window.key)).toMatchObject({
      detail: window.device.name,
      glyph: "laptopcomputer",
      title: window.title,
    });
  });

  // Failure: a root task counts a parent, counts are wrong, a mixed set of places
  // claims one kind, or schedules a Host never sent appear.
  it("sums places, tasks and schedules, and names the conversation a task works for", () => {
    const chat = glance(source, home, activity)!;
    expect(chat).toMatchObject({
      from: null,
      places: items.length,
      placesWorking: 2,
      placeGlyph: null,
      family: { running: 1, needsYou: true, automations: source.threadAutomations[home]!.length },
    });
    const parentOnly = { ...source, tabs: noTabs };
    expect(glance(parentOnly, worker)).toEqual({
      family: null,
      from: { threadId: home, title: "Build the new architecture" },
      placeGlyph: null,
      placeKeys: [],
      places: 0,
      placesWorking: 0,
    });
    expect(aroundLabel(glance(parentOnly, worker)!)).toBe("From Build the new architecture");
    const delivery = titled("Check the delivery ETA");
    const [phoneTab] = conversationSurfaces(source, delivery);
    const phone = glance(source, delivery, acting({ [phoneTab!.key]: [delivery] }))!;
    expect(phone).toMatchObject({ placeGlyph: "smartphone", places: 1, placesWorking: 1 });
    expect(aroundLabel(phone)).toBe("1 place open, 1 working");
  });

  // Failure: an old Host without `task-family-v1` sends no automations, and a
  // conversation with only those must not keep an empty control.
  it("has nothing to show for a conversation with nothing around it", () => {
    const threadId = titled("Review storage integration");
    expect(glance(source, threadId)?.family?.automations).toBe(1);
    const old = { ...source, tabs: noTabs, threadAutomations: {} };
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
    const empty = {
      places: 0,
      placeKeys: [],
      placesWorking: 0,
      placeGlyph: null,
      from: null,
      family: null,
    };
    expect(aroundLabel(empty)).toBe("");
    expect(aroundLabel({ ...empty, places: 2, placesWorking: 1 })).toBe("2 places open, 1 working");
    const family = { marks: [], running: 0, needsYou: false, automations: 0, earlier: 1 };
    expect(aroundLabel({ ...empty, family })).toBe("1 earlier task");
    expect(aroundLabel({ ...empty, family: { ...family, earlier: 2 } })).toBe("2 earlier tasks");
  });

  // Failure: a streamed token publishes a snapshot that reads as a new glance,
  // or an agent starting in a tab waits for an unrelated snapshot to show.
  it("reads the same while only a transcript changes, and follows activity without a new snapshot", () => {
    const byTab: Record<string, readonly string[]> = {};
    const select = aroundGlanceSelector(home, acting(byTab));
    const before = select(source);
    const after = select({
      ...source,
      transcripts: { ...source.transcripts, [home]: [...(source.transcripts[home] ?? [])] },
    });
    expect(sameAroundGlance(before, after)).toBe(true);
    expect(sameAroundGlance(before, select({ ...source, threadAutomations: {} }))).toBe(false);
    byTab[own.key] = [home];
    expect(select(source)?.placesWorking).toBe(1);
  });
});

describe("apps open as tabs", () => {
  const opened = (name: string, threadId: string): Tab =>
    tabFixture({
      tabId: TabIdSchema.parse(`tab_${name}`),
      kind: "app",
      title: name,
      openedBy: { taskId: ThreadIdSchema.parse(threadId) },
    });

  // Failure: another conversation's app is listed here, or a row opens something else.
  it("lists the app tabs this thread opened only, each opening exactly its own tab", () => {
    const tabs = tabStoreFixture([opened("Budget", home), opened("Other", createId("thread"))]);
    expect(aroundPlaces({ ...source, tabs }, home, nobody)).toMatchObject([
      { destination: { kind: "tab", tabId: "tab_Budget" }, title: "Budget", working: false },
    ]);
  });

  // Failure: the header keeps its old count because no surface source changed.
  it("refreshes the glance when only the app tabs change", () => {
    const select = aroundGlanceSelector(home, nobody);
    const tabs = tabStoreFixture([opened("Budget", home)]);
    const snapshot = { ...source, tabs };
    expect(select(snapshot)?.places).toBe(1);
    tabs.seed({ tabs: [], layout: { revision: 2, items: [] }, complete: true });
    expect(select(snapshot)?.places ?? 0).toBe(0);
  });
});

describe("the sheet's sections", () => {
  const place: AroundPlace = { ...aroundPlaces(source, home, nobody)[0]!, working: true };
  const idle: AroundPlace = { ...place, working: false };
  const family = taskFamily(source, home);
  const running = family.running[0]!;
  const task = (patch: Partial<FamilyTask>): FamilyTask => ({
    ...running,
    needsYou: false,
    ...patch,
  });
  const empty: TaskFamily = { automations: [], earlier: [], ended: [], running: [] };

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
    // Asked for by name, a section opens over anything else waiting.
    expect(openingSection([place], waiting, "schedules")).toBe("schedules");
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

describe("aroundYieldable", () => {
  it("gives up schedules, then places, and keeps who it works for and its tasks", () => {
    expect(aroundYieldable(["from", "places", "tasks", "schedules"])).toEqual([
      "schedules",
      "places",
    ]);
    expect(aroundYieldable(["tasks", "schedules"])).toEqual(["schedules"]);
  });

  it("keeps one part, so Around is never an empty button", () => {
    expect(aroundYieldable(["places", "schedules"])).toEqual(["schedules"]);
    expect(aroundYieldable(["places"])).toEqual([]);
  });
});
