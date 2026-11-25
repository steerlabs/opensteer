import { describe, expect, it } from "vitest";
import { TabIdSchema } from "@opensteer/core";
import { requestPageTab, threadAgentPlace } from "./agent-place-links.js";

const a = { tabId: TabIdSchema.parse("a") };
const b = { tabId: TabIdSchema.parse("b") };

describe("the page a Request is about", () => {
  const tab = (tabId: string, taskId: string, kind: "page" | "window" = "page") => ({
    tabId: TabIdSchema.parse(tabId),
    kind,
    usedBy: [{ taskId }],
  });
  const source = (...tabs: ReturnType<typeof tab>[]) => {
    const rows = new Map(tabs.map((row) => [row.tabId, row]));
    return { tabs: { rows, get: (id: string) => rows.get(TabIdSchema.parse(id)) } } as never;
  };
  const question = { originatingThreadId: "task", payload: { kind: "person.question" } };
  const signIn = (tabId: string) => ({
    originatingThreadId: "task",
    payload: { kind: "browser.sign-in", tabId },
  });

  it("opens the task's page while it holds exactly one, and nothing while it holds several", () => {
    expect(requestPageTab(source(tab("a", "task"), tab("w", "task", "window")), question)).toEqual(
      a,
    );
    // Never the most recent of several: they may be different sites.
    expect(requestPageTab(source(tab("a", "task"), tab("b", "task")), question)).toBeNull();
    expect(requestPageTab(source(tab("a", "other")), question)).toBeNull();
  });

  it("opens the tab a Request names, and nothing once that tab is gone", () => {
    expect(requestPageTab(source(tab("a", "task"), tab("b", "task")), signIn("b"))).toEqual(b);
    // Its own tab closed: never another page the task still holds.
    expect(requestPageTab(source(tab("a", "task")), signIn("b"))).toBeNull();
  });
});

describe("where a task's agent is working", () => {
  const held = (
    tabId: string,
    taskId: string,
    updatedAt: string,
    fields: Record<string, unknown> = {},
  ) => ({
    tabId: TabIdSchema.parse(tabId),
    kind: "page",
    title: "",
    usedBy: [{ taskId }],
    updatedAt,
    ...fields,
  });
  const source = (...tabs: ReturnType<typeof held>[]) =>
    ({ tabs: { rows: new Map(tabs.map((row) => [row.tabId, row])) } }) as never;

  it("names the place the task holds that changed most recently, of any kind", () => {
    const page = held("a", "task", "2026-01-01T00:00:00.000Z", { title: " Le Petit Jardin " });
    const app = held("w", "task", "2026-01-01T00:00:01.000Z", {
      kind: "window",
      appName: "Notes",
    });
    expect(threadAgentPlace(source(page, app), "task")).toEqual({
      tabId: TabIdSchema.parse("w"),
      kind: "window",
      title: "Notes",
    });
    expect(threadAgentPlace(source(page), "task")).toEqual({
      tabId: TabIdSchema.parse("a"),
      kind: "page",
      title: "Le Petit Jardin",
    });
  });

  it("is nothing for a task that holds no place", () => {
    expect(threadAgentPlace(source(held("a", "other", "2026-01-01T00:00:00.000Z")), "task")).toBe(
      null,
    );
  });
});
