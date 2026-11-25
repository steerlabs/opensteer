// @vitest-environment happy-dom
import { act } from "react";

import { describe, expect, it, vi, type MockInstance } from "vitest";
import { withTimeout } from "@opensteer/shared/withTimeout";
import type { MockHostClient } from "@opensteer/client/mock";

import {
  doneTaskList,
  heldThread,
  placeList,
  taskAfter,
  taskList,
  taskUnderWay,
  type TranscriptFixtureSnapshot,
  type TaskRow,
} from "@opensteer/client/host";
import {
  BrowserProfileIdSchema,
  BrowserSessionIdSchema,
  BrowserSurfaceIdSchema,
  createId,
  ThreadIdSchema,
} from "@opensteer/core";

import { rememberPlace } from "./navigation.js";

import {
  root,
  client,
  historyState,
  deferred,
  history,
  goTo,
  resize,
  mount,
  until,
  isMockPage,
  element,
  click,
  placeParams,
  pageTab,
  tabSearch,
  firstTaskId,
  setRoot,
  resetHistory,
} from "./workspace.interaction.test-support.js";
import { composerText, rewrite } from "../composer-editor.test-support.js";
/** The task that handed work to another, which the mock's family and task line belong to. */
function delegating(source: { getSnapshot(): TranscriptFixtureSnapshot }): string {
  const assignment = Object.values(source.getSnapshot().assignments)[0];
  if (!assignment) throw new Error("The mock hands out no work");
  return assignment.parentThreadId;
}

describe("Settings returns to the workspace exactly as it was", () => {
  async function openSettingsFromWorkspace() {
    await click(element(".sidebar__place"));
    const settings = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (button) => button.textContent?.trim() === "Settings",
    );
    if (!settings) throw new Error("Missing Settings menu item");
    await click(settings);
  }

  it("returns to the tab and conversation with one push", async () => {
    let threadId = "";
    await mount((source) => {
      const snapshot = source.getSnapshot();
      threadId = snapshot.threads.find((thread) => thread.purpose === "task")!.id;
      return `/tasks/${threadId}${tabSearch(pageTab(source))}`;
    });
    const canonical = history.at(-1)!;
    expect(canonical).toMatchObject({ path: `/tasks/${threadId}` });
    const place = pageTab();
    expect(element(".place").getAttribute("data-place-key")).toBe(place.key);

    await openSettingsFromWorkspace();
    expect(history.at(-1)).toMatchObject({ path: "/settings/general", type: "REPLACE" });
    await click(element<HTMLAnchorElement>('.settings-navigation__link[href="/settings/account"]'));
    expect(history.at(-1)).toMatchObject({ path: "/settings/account", type: "PUSH" });

    const beforeBack = history.length;
    await click(element(".settings-navigation__back"));
    await until("Back never returned to the conversation", () => {
      expect(history.slice(beforeBack)).toEqual([
        { path: `/tasks/${threadId}`, search: canonical.search, type: "PUSH" },
      ]);
      expect(element(".thread")).toBeTruthy();
    });
    expect(element(".place").getAttribute("data-place-key")).toBe(place.key);
  });

  it("returns past a replaced legacy computers alias without looping", async () => {
    let threadId = "";
    await mount((source) => {
      const snapshot = source.getSnapshot();
      threadId = snapshot.threads.find((thread) => thread.purpose === "task")!.id;
      return `/tasks/${threadId}`;
    });
    await act(async () => goTo!("/computers"));
    await until("The legacy alias was never replaced", () =>
      expect(history.at(-1)!.path).toBe("/settings/devices"),
    );
    expect(history.slice(-2)).toEqual([
      { path: "/computers", search: "", type: "PUSH" },
      { path: "/settings/devices", search: "", type: "REPLACE" },
    ]);
    expect(element(".settings-layout")).toBeTruthy();

    const beforeBack = history.length;
    await click(element(".settings-navigation__back"));
    await until("Back never returned to the conversation", () => {
      expect(history.slice(beforeBack)).toEqual([
        { path: `/tasks/${threadId}`, search: "", type: "PUSH" },
      ]);
      expect(element(".thread")).toBeTruthy();
    });
  });

  it("returns to a conversation-only address without reopening the remembered browser", async () => {
    let threadId = "";
    await mount((source) => {
      const snapshot = source.getSnapshot();
      threadId = snapshot.threads.find((thread) => thread.purpose === "task")!.id;
      return `/tasks/${threadId}${tabSearch(pageTab(source))}`;
    });
    const place = pageTab();
    const snapshot = client.getSnapshot();
    rememberPlace(
      { deploymentId: snapshot.deploymentId, userId: snapshot.user!.id },
      place.destination,
    );
    const conversationOnly = snapshot.threads.find(
      (thread) => thread.purpose === "task" && thread.id !== threadId,
    )!;
    await act(async () => goTo!(`/tasks/${conversationOnly.id}`));
    await until("The conversation never opened", () =>
      expect(history.at(-1)!.path).toBe(`/tasks/${conversationOnly.id}`),
    );
    expect(history.at(-1)).toMatchObject({
      path: `/tasks/${conversationOnly.id}`,
      search: "",
      type: "PUSH",
    });
    expect(document.querySelector(".place")).toBeNull();

    await openSettingsFromWorkspace();
    const beforeBack = history.length;
    await click(element(".settings-navigation__back"));
    await until("Back never returned to the conversation", () => {
      expect(history.slice(beforeBack)).toEqual([
        { path: `/tasks/${conversationOnly.id}`, search: "", type: "PUSH" },
      ]);
      expect(element(".thread")).toBeTruthy();
    });
    expect(document.querySelector(".place")).toBeNull();
  });

  it("returns a directly opened Settings window to Home with one push", async () => {
    await mount("/settings/ai-engines");
    expect(element(".settings-layout")).toBeTruthy();
    const beforeBack = history.length;
    await click(element(".settings-navigation__back"));
    await until("Back never returned Home", () => {
      expect(history[beforeBack]).toEqual({ path: "/", search: "", type: "PUSH" });
      expect(element(".thread")).toBeTruthy();
    });
    const [home, ...named] = history.slice(beforeBack);
    expect(home).toEqual({ path: "/", search: "", type: "PUSH" });
    // Home names its blank draft in place; nothing else moves.
    expect(named.every((step) => step.type === "REPLACE" && step.path === "/")).toBe(true);
    expect(element(".thread")).toBeTruthy();
  });
});

describe("a window opened again returns to the tab the person left", () => {
  it("waits for the tab list before deciding the remembered tab is gone", async () => {
    let tabId = "";
    let arrives = (): boolean => false;
    await mount((source) => {
      const place = pageTab(source);
      tabId = place.key;
      const snapshot = source.getSnapshot();
      const scope = { deploymentId: snapshot.deploymentId, userId: snapshot.user!.id };
      rememberPlace(scope, place.destination);
      // Connected, but the Home's tab list has not arrived yet, as on a fresh launch.
      // The mock's snapshot carries its own tab store, as the session client's does.
      const store = snapshot.tabs as unknown as {
        readonly rows: ReadonlyMap<string, unknown>;
        readonly layout: unknown;
        clear(): void;
        replaceCurrent(bootstrap: unknown): boolean;
      };
      const listed = { tabs: [...store.rows.values()], layout: store.layout, complete: true };
      store.clear();
      arrives = () => store.replaceCurrent(listed);
      return "/";
    });
    expect(new URLSearchParams(history.at(-1)!.search).get("panel")).toBeNull();
    await act(async () => {
      arrives();
    });
    await until("The remembered tab never came back", () =>
      expect(new URLSearchParams(history.at(-1)!.search).get("tab")).toBe(tabId),
    );
  });
});

describe("selection actions own exactly their axis, one history entry each", () => {
  it("task row: the conversation changes, the place stays, the middle is not remounted", async () => {
    await mount((source) => `/${tabSearch(pageTab(source))}`);
    const place = pageTab();
    const middle = element(".place");
    const canvas = element(".place .browser-canvas");
    const before = history.length;
    const threadId = firstTaskId();
    await click(element(`.side-task[data-thread-id="${threadId}"] .side-task__main`));
    expect(history.length).toBe(before + 1);
    expect(history.at(-1)).toMatchObject({ path: `/tasks/${threadId}`, type: "PUSH" });
    expect(placeParams(history.at(-1)!.search)).toBe(placeParams(tabSearch(place)));
    expect(element(".place")).toBe(middle);
    expect(element(".place .browser-canvas")).toBe(canvas);
    expect(middle.isConnected).toBe(true);
  });

  it("tab row: the place changes, the conversation stays", async () => {
    const node = await mount("/");
    const place = pageTab();
    const before = history.length;
    await click(element(`.side-tab[data-place-key="${place.key}"] .side-tab__main`, node));
    expect(history.length).toBe(before + 1);
    expect(history.at(-1)).toMatchObject({ path: "/", type: "PUSH" });
    expect(placeParams(history.at(-1)!.search)).toBe(placeParams(tabSearch(place)));
    expect(element(".place").getAttribute("data-place-key")).toBe(place.key);
  });

  it("face on a tab: that place and that task, as one entry", async () => {
    await mount("/");
    const place = pageTab();
    const occupant = place.occupants[0]!;
    const before = history.length;
    await click(
      element(
        `.side-tab[data-place-key="${place.key}"] .occupant-mark[data-thread-id="${occupant.threadId}"]`,
      ),
    );
    expect(history.length).toBe(before + 1);
    expect(history.at(-1)!.path).toBe(`/tasks/${occupant.threadId}`);
    expect(placeParams(history.at(-1)!.search)).toBe(placeParams(tabSearch(place)));
  });

  it("a task in the header's family: only the conversation", async () => {
    await mount((source) => `/tasks/${delegating(source)}${tabSearch(pageTab(source))}`);
    const place = pageTab();
    const middle = element(".place");
    await click(element(".conv-header__menu"));
    expect(element(".popover--conversation-menu").textContent).not.toContain("Started here");
    expect(document.querySelector(".popover--conversation-menu .task-family__row")).toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await until("Escape never closed the conversation menu", () =>
      expect(document.querySelector(".popover--conversation-menu")).toBeNull(),
    );
    await click(element(".task-family-button"));
    // The menu is this conversation's: no search across every task, which the sidebar has.
    expect(document.querySelector(".popover--conversation-menu input")).toBeNull();
    const target = element<HTMLButtonElement>(".task-family__row");
    const before = history.length;
    await click(target);
    expect(history.length).toBe(before + 1);
    expect(history.at(-1)!.path).toMatch(/^\/tasks\//u);
    expect(history.at(-1)!.path).not.toBe(`/tasks/${delegating(client)}`);
    expect(placeParams(history.at(-1)!.search)).toBe(placeParams(tabSearch(place)));
    expect(element(".place")).toBe(middle);
  });

  it("a task line in its parent's transcript: only the conversation", async () => {
    await mount((source) => `/tasks/${delegating(source)}${tabSearch(pageTab(source))}`);
    const place = pageTab();
    const card = element<HTMLAnchorElement>("a.agent-step__head");
    const before = history.length;
    await click(card);
    expect(history.length).toBe(before + 1);
    expect(history.at(-1)!.path).toMatch(/^\/tasks\//u);
    expect(placeParams(history.at(-1)!.search)).toBe(placeParams(tabSearch(place)));
  });

  it("viewfinder: only the place, and it opens Work from Talk", async () => {
    let task = "";
    await mount((source) => {
      task = source.getSnapshot().threads.find(({ status }) => status === "running")!.id;
      return `/tasks/${task}`;
    });
    const viewfinder = await until("The running task's viewfinder never became usable", () =>
      element<HTMLButtonElement>(".viewfinder:not(:disabled)"),
    );
    const key = viewfinder.dataset.placeKey!;
    const before = history.length;
    await click(viewfinder);
    expect(history.length).toBe(before + 1);
    expect(history.at(-1)!.path).toBe(`/tasks/${task}`);
    expect(new URLSearchParams(history.at(-1)!.search).get("panel")).toBe("browser");
    expect(element(".place").getAttribute("data-place-key")).toBe(key);
  });
});

describe("nothing but the person navigates", () => {
  it("agent activity, catalog churn and a completion cause no navigation", async () => {
    await mount((source) => `/${tabSearch(pageTab(source))}`);
    const before = history.length;
    const running = client
      .getSnapshot()
      .threads.find((thread) => thread.status === "running" && thread.listed);
    expect(running).toBeDefined();
    // Agent activity: the running task starts acting in another page.
    const acted = placeList(client.getSnapshot()).find(
      (item) => isMockPage(item) && item.key !== pageTab().key,
    )!;
    await act(async () => client.actInPlace(running!.id, acted.key));
    await until("The agent's activity never reached the sidebar", () =>
      element(
        `.side-tab[data-place-key="${acted.key}"] .occupant-mark[data-thread-id="${running!.id}"]`,
      ),
    );
    // Catalog churn: a tab this page never asked for joins the list.
    const churn = await act(async () =>
      client.openTab({
        kind: "page",
        url: "https://churn.example/",
        profileId: BrowserProfileIdSchema.parse(client.getSnapshot().browserProfiles[0]!.id),
      }),
    );
    await until("The new tab never joined the sidebar", () =>
      element(`.side-tab[data-place-key="${churn.tabId}"]`),
    );
    // A task finishing is a completion; the middle and the conversation stay put.
    await act(async () => {
      await client.stopRun(running!.id).catch(() => undefined);
    });
    await until("The task's run never ended", () =>
      expect(
        client.getSnapshot().threads.find((thread) => thread.id === running!.id)?.status,
      ).not.toBe("running"),
    );
    expect(history.length).toBe(before);
  });

  it("legacy /live opens Home, keeps an explicit place and invents none", async () => {
    await mount((source) => `/live${tabSearch(pageTab(source))}`);
    const place = pageTab();
    expect(history.at(-1)).toMatchObject({ path: "/", type: "REPLACE" });
    expect(placeParams(history.at(-1)!.search)).toBe(placeParams(tabSearch(place)));
    resetHistory();
    act(() => root?.unmount());
    setRoot(null);
    client.dispose();
    document.body.replaceChildren();
    await mount("/live");
    expect(history.at(-1)).toMatchObject({ path: "/", type: "REPLACE" });
    expect(placeParams(history.at(-1)!.search)).toBe(placeParams(""));
  });

  it("an older browser address is canonicalised by one replace, naming no tab it cannot", async () => {
    await mount(
      (source) => `/tasks/${delegating(source)}?panel=browser&browser=bsn_old&browserTab=old`,
    );
    await until("The older address was never canonicalised", () =>
      expect(new URLSearchParams(history.at(-1)!.search).has("browser")).toBe(false),
    );
    const replaces = history.filter((step) => step.type === "REPLACE");
    expect(replaces).toHaveLength(1);
    const params = new URLSearchParams(history.at(-1)!.search);
    expect(params.has("browser")).toBe(false);
    expect(params.has("browserTab")).toBe(false);
  });
});

describe("the conversation survives layout changes", () => {
  it("keeps the draft, the textarea and its focus through Hide and Show computer", async () => {
    await mount((source) => `/${tabSearch(pageTab(source))}`);
    const place = pageTab();
    const field = element<HTMLElement>("[data-composer-input]");
    field.focus();
    await act(async () => {
      rewrite(field, "Keep this");
    });
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: ".", metaKey: true }));
    });
    await until("⌘. never hid the computer", () =>
      expect(document.querySelector(".place")).toBeNull(),
    );
    expect(element("[data-composer-input]")).toBe(field);
    expect(composerText(field)).toBe("Keep this");
    expect(document.activeElement).toBe(field);
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: ".", metaKey: true }));
    });
    await until("⌘. never showed the computer again", () =>
      expect(element(".place").getAttribute("data-place-key")).toBe(place.key),
    );
    expect(element("[data-composer-input]")).toBe(field);
    expect(composerText(field)).toBe("Keep this");
  });

  it("a docked page without a conversation still expands from its name", async () => {
    await mount((source) => `/${tabSearch(pageTab(source))}`);
    expect(document.querySelector(".conv-header--area .conv-header__actions")).toBeNull();
    await click(element(".conv-header--area .conv-header__menu"));
    const expand = [
      ...document.querySelectorAll<HTMLButtonElement>(".popover--conversation-menu button"),
    ].find((button) => button.textContent?.startsWith("Expand"));
    expect(expand).toBeDefined();
    await click(expand!);
    expect(document.querySelector(".place")).toBeNull();
    expect(element(".conv-header--area .conv-header__name").textContent).toBe("New task");
    // The menu's button went with the dock; focus carries on in the page.
    await until("Focus never carried on in the page", () =>
      expect(element(".workspace__conversation").contains(document.activeElement)).toBe(true),
    );
  });
});

describe("breakpoints change layout, never the conversation", () => {
  it("keeps the textarea, its draft, the chip and focus from 1440 to 820 to 390 and back", async () => {
    await mount((source) => `/${tabSearch(pageTab(source))}`);
    const place = pageTab();
    await until("The shown page never became the chip", () =>
      expect(element(".context-chip__title").textContent).toBe(place.title),
    );
    const field = element<HTMLElement>("[data-composer-input]");
    field.focus();
    await act(async () => {
      rewrite(field, "Still here");
    });
    const before = history.length;
    for (const width of [820, 390, 1100, 1440]) {
      await resize(width);
      expect(element("[data-composer-input]")).toBe(field);
      expect(composerText(field)).toBe("Still here");
      expect(document.activeElement).toBe(field);
      expect(element(".context-chip__title").textContent).toBe(place.title);
      expect(element(".place").getAttribute("data-place-key")).toBe(place.key);
    }
    expect(history.length).toBe(before);
  });
});

describe("focus never lands on the body", () => {
  it("a focused face that leaves hands focus to its tab row", async () => {
    await mount("/");
    const place = pageTab();
    const occupant = place.occupants[0]!;
    const face = element<HTMLButtonElement>(
      `.side-tab[data-place-key="${place.key}"] .occupant-mark[data-thread-id="${occupant.threadId}"]`,
    );
    face.focus();
    expect(document.activeElement).toBe(face);
    await act(async () => {
      await client.stopRun(occupant.threadId).catch(() => undefined);
    });
    await until("The face never left and handed focus to its tab row", () => {
      expect(face.isConnected).toBe(false);
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).toBe(
        element(`.side-tab[data-place-key="${place.key}"] .side-tab__main`),
      );
    });
  });
});

describe("the Needs you pill", () => {
  it("opens the Needs you list, loads older requests, and opens one in the task it waits in", async () => {
    let askTask = "";
    await mount((source) => {
      askTask = source.getSnapshot().threads.find((thread) => thread.purpose === "task")!.id;
      const getSnapshot = source.getSnapshot.bind(source);
      const [held] = getSnapshot().needsYou!.entries;
      if (!held) throw new Error("The mock Home holds no request.");
      const older = {
        ...held,
        request: { ...held.request, id: createId("request") },
        originThreadId: ThreadIdSchema.parse(askTask),
        navigationThreadId: ThreadIdSchema.parse(askTask),
        title: "Older request",
      };
      const page = getSnapshot().needsYou!;
      let current: TranscriptFixtureSnapshot = {
        ...getSnapshot(),
        needsYou: { ...page, count: page.count + 1, window: { ...page.window, hasMore: true } },
      };
      vi.spyOn(source, "getSnapshot").mockImplementation(() => current);
      vi.spyOn(source, "loadEarlierNeedsYou").mockImplementation(async () => {
        current = {
          ...current,
          needsYou: {
            ...current.needsYou!,
            entries: [...current.needsYou!.entries, older],
            window: { ...current.needsYou!.window, hasMore: false },
          },
        };
      });
      return `/${tabSearch(pageTab(source))}`;
    });
    const place = pageTab();
    const before = history.length;
    const pill = element<HTMLButtonElement>(".side-needs");
    await click(pill);
    expect(history.length).toBe(before);
    expect(element('[role="dialog"]').textContent).toContain("Needs you");
    const earlier = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Earlier requests",
    );
    expect(earlier).toBeDefined();
    await click(earlier!);
    const row = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Older request"),
    );
    expect(row).toBeDefined();
    await click(row!);
    // No dialog of its own: the request is answered in its task.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(history.at(-1)!.path).toBe(`/tasks/${askTask}`);
    expect(placeParams(history.at(-1)!.search)).toBe(placeParams(tabSearch(place)));
  });
});

describe("sidebar Tasks until Done", () => {
  const openTasks = () => taskList(client.getSnapshot());
  const doneRows = () => doneTaskList(client.getSnapshot())?.rows ?? [];
  async function readTask() {
    const task = openTasks().ready.find((item) => item.canBeDone)!;
    expect(task).toBeDefined();
    const completedAt = client
      .getSnapshot()
      .threads.find((thread) => thread.id === task.threadId)?.latestRunCompletedAt;
    if (completedAt) await act(async () => client.visitThread(task.threadId, completedAt));
    return task;
  }
  const shelf = () => element<HTMLButtonElement>(".side-done .side-done__main");
  const heading = () => element("#sidebar-tasks").textContent;
  const row = (id: string) => document.querySelector(`.side-task[data-thread-id="${id}"]`);

  it("keeps a read task listed until it is Done, then opens Done in place without moving Tabs", async () => {
    await mount("/");
    const task = await readTask();
    expect(row(task.threadId)).not.toBeNull();
    await act(async () => client.setTaskDone(task.threadId, true));
    expect(row(task.threadId)).toBeNull();
    const count = doneTaskList(client.getSnapshot())!.total;
    expect(shelf().getAttribute("aria-label")).toBe(
      `Done, ${count} ${count === 1 ? "task" : "tasks"}`,
    );
    const tabs = element(".side-section--tabs");
    await click(shelf());
    expect(heading()).toBe("Done");
    expect(row(task.threadId)).not.toBeNull();
    expect(element(".side-day__title").textContent).toBe("Today");
    expect(element(".side-section--tabs")).toBe(tabs);
    await click(element('[aria-label="Back to Tasks"]'));
    expect(heading()).toBe("Tasks");
    await click(shelf());
    await act(async () =>
      element(".side-section--tasks").dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
      ),
    );
    expect(heading()).toBe("Tasks");
  });

  it("moves on to the next task when the open one is marked Done, and stays for any other", async () => {
    const doable = (snapshot: TranscriptFixtureSnapshot) => {
      const list = taskList(snapshot);
      return [...list.working, ...list.ready].filter(
        (item) => item.canBeDone && !taskUnderWay(heldThread(snapshot, item.threadId)!),
      );
    };
    let open: TaskRow | undefined;
    await mount((source) => {
      open = doable(source.getSnapshot())[0];
      return `/tasks/${open?.threadId}`;
    });
    if (!open) throw new Error("The mock lists no task that can be marked Done");
    const next = taskAfter(openTasks(), open.threadId);
    expect(next).not.toBeNull();
    await click(element(`[aria-label="Mark Done: ${open.title}"]`));
    await until("Done never moved on to the next task", () =>
      expect(history.at(-1)).toMatchObject({ path: `/tasks/${next}`, type: "PUSH" }),
    );

    const other = doable(client.getSnapshot()).find((item) => item.threadId !== next)!;
    const entries = history.length;
    await click(element(`[aria-label="Mark Done: ${other.title}"]`));
    await until("The other task never moved to Done", () =>
      expect(doneRows().some((item) => item.threadId === other.threadId)).toBe(true),
    );
    expect(history.slice(entries)).toEqual([]);
  });

  it("names tasks the Host moved quietly, moves them back, and stops telling once seen", async () => {
    await mount("/");
    const task = await readTask();
    await act(async () => client.moveQuietly(task.threadId));
    expect(doneRows().some((item) => item.threadId === task.threadId)).toBe(true);
    const chip = element<HTMLButtonElement>(".side-done__moved");
    expect(chip.textContent).toBe("+1");
    expect(chip.getAttribute("aria-label")).toBe("1 task moved to Done for you");
    await click(chip);
    expect(element(".quiet-moved__title").textContent).toBe("Moved to Done for you");
    expect(element(".quiet-moved__name").textContent).toBe(task.title);
    await click(element(`[aria-label="Move back: ${task.title}"]`));
    expect(openTasks().ready.some((item) => item.threadId === task.threadId)).toBe(true);
    expect(document.querySelector(".quiet-moved")).toBeNull();
    expect(document.querySelector(".side-done__moved")).toBeNull();

    // A second move is told again, until Done is opened.
    const again = await readTask();
    await act(async () => client.moveQuietly(again.threadId));
    expect(element(".side-done__moved").textContent).toBe("+1");
    await click(shelf());
    await click(element('[aria-label="Back to Tasks"]'));
    expect(document.querySelector(".side-done__moved")).toBeNull();
  });
});

describe("narrow screens", () => {
  it("≤ 900px: the drawer's button carries how many tasks need you", async () => {
    await mount("/", { width: 820 });
    const button = element<HTMLButtonElement>(".conv-header .drawer-btn");
    expect(button.getAttribute("aria-label")).toMatch(/need you/u);
  });

  it("≤ 700px: a place opens full screen with the conversation as a sheet", async () => {
    await mount((source) => `/tasks/${delegating(source)}${tabSearch(pageTab(source))}`, {
      width: 390,
    });
    expect(element(".workspace").className).toContain("workspace--phone-stage");
    expect(element(".thread").className).toContain("thread--sheet");
  });
});

describe("native places", () => {
  it("a phone's tab row shows its display through the shared watch reader", async () => {
    await mount("/");
    const phone = placeList(client.getSnapshot()).find((item) => item.kind === "phone")!;
    await click(element(`.side-tab[data-place-key="${phone.key}"] .side-tab__main`));
    await until("The phone's display was never shown", () =>
      expect(element(".place .computer-watch__app").textContent).toBe(phone.title),
    );
    expect(element(".place .computer-watch__stop").textContent).toBe("Stop");
  });
});

describe("a missing task", () => {
  it("a missing task says it isn't available, with its place intact, and Back goes home", async () => {
    await mount((source) => {
      const missingId = createId("thread");
      const read = source.getSnapshot.bind(source);
      let held: TranscriptFixtureSnapshot | null = null;
      let published: TranscriptFixtureSnapshot | null = null;
      vi.spyOn(source, "getSnapshot").mockImplementation(() => {
        const next = read();
        if (next !== held) {
          held = next;
          published = { ...next, threadLookups: { ...next.threadLookups, [missingId]: "missing" } };
        }
        return published!;
      });
      return `/tasks/${missingId}${tabSearch(pageTab(source))}`;
    });
    expect(element(".ref-unavailable").textContent).toContain("This isn't available");
    expect(placeParams(history.at(-1)!.search)).toBe(placeParams(tabSearch(pageTab())));
    expect(element(".place").getAttribute("data-place-key")).toBe(pageTab().key);
    await click(
      [...document.querySelectorAll<HTMLButtonElement>(".ref-unavailable button")].find(
        (button) => button.textContent === "Back",
      )!,
    );
    expect(history.at(-1)!.path).toBe("/");
    expect(placeParams(history.at(-1)!.search)).toBe(placeParams(tabSearch(pageTab())));
    expect(element(".place").getAttribute("data-place-key")).toBe(pageTab().key);
  });
});

describe("a link arriving at the start page", () => {
  const address = "https://storage.example/docs/mounts";
  const state = { startId: "reply-link", startAddress: address, startOpen: true, startFrom: null };
  const replyTask = "/tasks/thr_00000000-0000-4000-8000-000000000002";
  function remember(source: MockHostClient, choice: unknown) {
    const snapshot = source.getSnapshot();
    localStorage.setItem(
      `opensteer.browse-with.v1:${encodeURIComponent(snapshot.deploymentId!)}:${encodeURIComponent(snapshot.user!.id)}`,
      JSON.stringify(choice),
    );
  }
  /** A page tab browsing as a profile, as the place a start page covers. */
  function profileTab(source: MockHostClient) {
    const place = placeList(source.getSnapshot()).find(
      (item) => item.kind === "page" && item.identity?.kind === "profile",
    );
    if (place?.identity?.kind !== "profile") throw new Error("The mock lists no profile tab");
    return { key: place.key, profileId: place.identity.profileId };
  }
  async function replyLink() {
    let link!: HTMLAnchorElement;
    await vi.waitFor(
      () => {
        const found = [...document.querySelectorAll<HTMLAnchorElement>(".md-prose a")].find(
          (anchor) => anchor.textContent === "storage mount guide",
        );
        expect(found, "The reply's website link never appeared").toBeDefined();
        link = found!;
      },
      { timeout: 1_000 },
    );
    return link;
  }
  /** Every open answers only when the test releases it, in the order asked. */
  function holdOpens(source: MockHostClient) {
    const gates: ReturnType<typeof deferred<void>>[] = [];
    const real = source.openTab;
    const open = vi.spyOn(source, "openTab").mockImplementation(async (target) => {
      const gate = deferred<void>();
      gates.push(gate);
      await withTimeout(gate.promise, 2_000, {
        timeoutError: () => new Error("A held tab open was never released."),
      });
      return real(target);
    });
    return { open, release: (index: number) => act(async () => gates[index]!.resolve()) };
  }

  it("only the newest of rapid reply links shows its tab, even when an older one answers first", async () => {
    let held!: ReturnType<typeof holdOpens>;
    await mount((source) => {
      remember(source, { kind: "profile", profileId: profileTab(source).profileId });
      held = holdOpens(source);
      return replyTask;
    });
    const link = await replyLink();
    // Each click asks in its own turn.
    act(() => {
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    act(() => {
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(held.open).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[aria-label="Opening tab"]')?.textContent).toContain(address);
    expect(document.querySelector('[aria-label="Opening tab"] .spinner')).not.toBeNull();
    const before = history.length;
    // The older answer lands first: it shows nothing, and it spoils nothing for the newer one.
    await held.release(0);
    const older = await held.open.mock.results[0]!.value;
    // The older tab is listed: that is when it would have been shown.
    await until("The older answer's tab was never listed", () =>
      element(`.side-tab[data-place-key="${older.tabId}"]`),
    );
    expect(history.length).toBe(before);
    expect(new URLSearchParams(history.at(-1)!.search).get("tab")).not.toBe(older.tabId);
    await held.release(1);
    const newest = await held.open.mock.results[1]!.value;
    expect(newest.tabId).not.toBe(older.tabId);
    await vi.waitFor(
      () =>
        expect(
          new URLSearchParams(history.at(-1)!.search).get("tab"),
          "The newest link's tab was never shown",
        ).toBe(newest.tabId),
      { timeout: 1_000 },
    );
  });

  it("opens once in StrictMode, consumes only its trigger, and never pulls back a person who left", async () => {
    let held!: ReturnType<typeof holdOpens>;
    await mount(
      (source) => {
        // A profile has its own computer; Guest with two to choose from would be asked which.
        remember(source, { kind: "profile", profileId: profileTab(source).profileId });
        held = holdOpens(source);
        return { pathname: "/", search: "?panel=browser", state };
      },
      { strict: true },
    );
    // An address the person typed is typed in their history too.
    expect(held.open).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ kind: "page", url: address }),
      { typed: true },
    );
    expect(historyState).toEqual({ ...state, startOpen: false });
    expect(element<HTMLInputElement>(".start-page__input").value).toBe(address);
    // Leaving before the answer is a newer choice: the late tab is not shown.
    await act(async () => goTo!("/"));
    const before = history.length;
    await held.release(0);
    const late = await held.open.mock.results[0]!.value;
    // The late tab is listed: that is when it would have been shown.
    await until("The late answer's tab was never listed", () =>
      element(`.side-tab[data-place-key="${late.tabId}"]`),
    );
    expect(history.length).toBe(before);
    expect(new URLSearchParams(history.at(-1)!.search).has("panel")).toBe(false);
    // Back to the consumed arrival: its address again, never a second open.
    await act(async () => goTo!(-1));
    await until("Back never returned to the arrival's address", () =>
      expect(element<HTMLInputElement>(".start-page__input").value).toBe(address),
    );
    expect(held.open).toHaveBeenCalledTimes(1);
  });

  it("consumes an unavailable arrival but keeps its address and refusal", async () => {
    let open!: MockInstance<MockHostClient["openTab"]>;
    await mount((source) => {
      open = vi.spyOn(source, "openTab");
      remember(source, { kind: "profile", profileId: "missing-profile" });
      return { pathname: "/", search: "?panel=browser", state };
    });
    expect(open).not.toHaveBeenCalled();
    expect(element<HTMLInputElement>(".start-page__input").value).toBe(address);
    expect(document.querySelector(".start-page__refusal")).not.toBeNull();
    expect(historyState).toEqual({ ...state, startOpen: false });
  });

  it("browses as the tab the start page covers, ahead of a remembered Guest", async () => {
    let open!: MockInstance<MockHostClient["openTab"]>;
    let covered!: ReturnType<typeof profileTab>;
    await mount((source) => {
      covered = profileTab(source);
      remember(source, { kind: "guest" });
      open = vi.spyOn(source, "openTab");
      return {
        pathname: "/",
        search: "?panel=browser",
        state: { ...state, startFrom: `panel=browser&tab=${covered.key}` },
      };
    });
    await vi.waitFor(() => expect(open, "The arrival never opened").toHaveBeenCalled(), {
      timeout: 1_000,
    });
    expect(open).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ url: address, profileId: covered.profileId }),
      { typed: true },
    );
  });

  it("a reply link from an open start page browses as the tab it covers", async () => {
    let open!: MockInstance<MockHostClient["openTab"]>;
    let covered!: ReturnType<typeof profileTab>;
    await mount((source) => {
      covered = profileTab(source);
      remember(source, { kind: "guest" });
      open = vi.spyOn(source, "openTab");
      return {
        pathname: replyTask,
        search: "?panel=browser",
        state: { startId: "new-tab", startFrom: `panel=browser&tab=${covered.key}` },
      };
    });
    await click(await replyLink());
    expect(open).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ url: address, profileId: covered.profileId }),
      { typed: true },
    );
  });
});

it("keeps the person on their tab when a docked task moves tabs, and jumps from its live card", async () => {
  await mount((source) => {
    const places = placeList(source.getSnapshot());
    const acting = places.find((place) => place.title === "Le Petit Jardin")!;
    const threadId = acting.occupants[0]!.threadId;
    return `/tasks/${threadId}?panel=browser&tab=${acting.key}`;
  });
  const places = placeList(client.getSnapshot());
  const acting = places.find((place) => place.title === "Le Petit Jardin")!;
  const reading = places.find((place) => place.title === "Your reading list")!;
  const threadId = acting.occupants[0]!.threadId;
  const shownTab = () => element<HTMLElement>(".browser-view").dataset.browserTab;
  const liveCard = () => document.querySelector(".conv-header .viewfinder");
  const composer = element("[data-composer-input]");
  const run = client
    .getSnapshot()
    .runQueue.find((entry) => entry.threadId === threadId && entry.status === "running")!;
  const actingViewer = client.tabViewer(acting.key);
  if (actingViewer?.kind !== "page") throw new Error("Expected page viewer");

  await act(async () => {
    client.actInPlace(threadId, reading.key);
    client.enterPlace(run.id, threadId, {
      place: {
        kind: "browser",
        sessionId: BrowserSessionIdSchema.parse(actingViewer.sessionId),
        surfaceId: BrowserSurfaceIdSchema.parse(reading.key),
      },
      title: reading.title,
      site: null,
    });
  });

  expect(shownTab(), "The stage must stay on the person's tab").toBe(acting.key);
  expect(liveCard()?.getAttribute("aria-label")).toContain(`Show ${reading.title}`);

  await click(liveCard()!);
  expect(shownTab()).toBe(reading.key);
  expect(element("[data-composer-input]")).toBe(composer);
});
