import { seedBrowserSession } from "@opensteer/client/test-support";
import { seedBrowserSnapshot } from "@opensteer/client/test-support";
import type { PersonalTabLineage, HostClient } from "@opensteer/client/host";
// @vitest-environment happy-dom
import { act } from "react";

import { describe, expect, it, vi } from "vitest";

import { mockTeamId, mockTeamChannelId, mockTeamUserId } from "@opensteer/client/team";
import { doneTaskList, placeList, taskList, type HostSnapshot } from "@opensteer/client/host";
import {
  BrowserSurfaceIdSchema,
  BrowserSessionIdSchema,
  createId,
  TeamAgentRequestIdSchema,
  ThreadIdSchema,
  TeamMessageIdSchema,
} from "@opensteer/core";
import { createBrowserSessionId } from "@opensteer/protocol";

import { rememberPlace } from "./navigation.js";

import {
  root,
  client,
  teamHost,
  teamSession,
  historyState,
  historyKey,
  deferred,
  history,
  goTo,
  resize,
  mount,
  settle,
  element,
  click,
  placeParams,
  pageTab,
  tabSearch,
  firstTaskId,
  setRoot,
  resetHistory,
} from "./workspace.interaction.test-support.js";
/** The task that handed work to another, which the mock's family and task line belong to. */
function delegating(source: { getSnapshot(): HostSnapshot }): string {
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

  it("returns to the canonical browser tab and conversation with one push", async () => {
    let threadId = "";
    await mount((source) => {
      const snapshot = source.getSnapshot();
      threadId = snapshot.threads.find((thread) => thread.purpose === "task")!.id;
      const place = pageTab(source);
      if (place.destination.kind !== "browser") throw new Error("Missing browser place");
      return `/tasks/${threadId}?panel=browser&browser=${place.destination.sessionId}`;
    });
    const canonical = history.at(-1)!;
    expect(canonical).toMatchObject({ path: `/tasks/${threadId}`, type: "REPLACE" });
    const selectedTab = new URLSearchParams(canonical.search).get("browserTab");
    expect(selectedTab).toBeTruthy();
    const place = placeList(client.getSnapshot()).find(
      (item) => item.destination.kind === "browser" && item.destination.tabId === selectedTab,
    );
    if (!place) throw new Error("Canonical browser tab is missing from places");
    expect(element(".place").getAttribute("data-place-key")).toBe(place.key);

    await openSettingsFromWorkspace();
    expect(history.at(-1)).toMatchObject({ path: "/settings/general", type: "REPLACE" });
    await click(element<HTMLAnchorElement>('.settings-navigation__link[href="/settings/account"]'));
    expect(history.at(-1)).toMatchObject({ path: "/settings/account", type: "PUSH" });

    const beforeBack = history.length;
    await click(element(".settings-navigation__back"));
    await settle(100);
    expect(history.slice(beforeBack)).toEqual([
      { path: `/tasks/${threadId}`, search: canonical.search, type: "PUSH" },
    ]);
    expect(element(".thread")).toBeTruthy();
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
    await settle();
    expect(history.slice(-2)).toEqual([
      { path: "/computers", search: "", type: "PUSH" },
      { path: "/settings/devices", search: "", type: "REPLACE" },
    ]);
    expect(element(".settings-layout")).toBeTruthy();

    const beforeBack = history.length;
    await click(element(".settings-navigation__back"));
    await settle(100);
    expect(history.slice(beforeBack)).toEqual([
      { path: `/tasks/${threadId}`, search: "", type: "PUSH" },
    ]);
    expect(element(".thread")).toBeTruthy();
  });

  it("returns to a conversation-only address without reopening the remembered browser", async () => {
    let threadId = "";
    await mount((source) => {
      const read = source.getSnapshot.bind(source);
      let base: HostSnapshot | undefined;
      let restoring: HostSnapshot | undefined;
      vi.spyOn(source, "getSnapshot").mockImplementation(() => {
        const current = read();
        if (current !== base || !restoring) {
          base = current;
          restoring = { ...current, tabRestoreVersion: 1 };
        }
        return restoring;
      });
      const snapshot = source.getSnapshot();
      threadId = snapshot.threads.find((thread) => thread.purpose === "task")!.id;
      return `/tasks/${threadId}${tabSearch(pageTab(source))}`;
    });
    const place = pageTab();
    if (place.destination.kind !== "browser") throw new Error("Missing browser place");
    const snapshot = client.getSnapshot();
    rememberPlace(
      { deploymentId: snapshot.deploymentId, userId: snapshot.user!.id },
      place.destination,
    );
    const conversationOnly = snapshot.threads.find(
      (thread) => thread.purpose === "task" && thread.id !== threadId,
    )!;
    await act(async () => goTo!(`/tasks/${conversationOnly.id}`));
    await settle();
    expect(history.at(-1)).toMatchObject({
      path: `/tasks/${conversationOnly.id}`,
      search: "",
      type: "PUSH",
    });
    expect(document.querySelector(".place")).toBeNull();

    await openSettingsFromWorkspace();
    const beforeBack = history.length;
    await click(element(".settings-navigation__back"));
    await settle(100);
    expect(history.slice(beforeBack)).toEqual([
      { path: `/tasks/${conversationOnly.id}`, search: "", type: "PUSH" },
    ]);
    expect(element(".thread")).toBeTruthy();
    expect(document.querySelector(".place")).toBeNull();
  });

  it("returns a directly opened Settings window to Home with one push", async () => {
    await mount("/settings/ai-engines");
    expect(element(".settings-layout")).toBeTruthy();
    const beforeBack = history.length;
    await click(element(".settings-navigation__back"));
    await settle(100);
    const [home, ...named] = history.slice(beforeBack);
    expect(home).toEqual({ path: "/", search: "", type: "PUSH" });
    // Home names its blank draft in place; nothing else moves.
    expect(named.every((step) => step.type === "REPLACE" && step.path === "/")).toBe(true);
    expect(element(".thread")).toBeTruthy();
  });
});

describe("selection actions own exactly their axis, one history entry each", () => {
  it.each([false, true])(
    "recovers a selected browser outside the bounded catalog (remembered: %s)",
    async (remembered) => {
      let destination: { kind: "browser"; sessionId: string; tabId: string };
      const read = vi.fn();
      await mount((source) => {
        const original = source.getSnapshot();
        const selected = pageTab(source);
        if (selected.destination.kind !== "browser" || !selected.destination.tabId)
          throw new Error("Expected browser tab");
        destination = {
          kind: "browser",
          sessionId: selected.destination.sessionId,
          tabId: selected.destination.tabId,
        };
        const group: PersonalTabLineage = {
          id: createBrowserSessionId(),
          revision: 1,
          createdAt: "2026-10-19T12:00:00.000Z",
          session: {
            id: destination.sessionId as PersonalTabLineage["session"]["id"],
            access: "read-write",
            createdAt: "2026-10-19T12:00:00.000Z",
            updatedAt: "2026-10-19T12:00:00.000Z",
            origin: "person",
            placement: {
              kind: "runner",
              runnerId: selected.device!
                .machineId as PersonalTabLineage["session"]["placement"]["runnerId"],
            },
            profileId: null,
            runtimeId: "test",
            state: "failed",
          },
          tabs: [
            {
              kind: "browser",
              id: BrowserSurfaceIdSchema.parse(destination.tabId),
              sessionId: destination.sessionId as PersonalTabLineage["session"]["id"],
              title: selected.title,
              site: selected.site ?? "",
              order: 0,
              openerId: null,
              state: "suspended",
            },
          ],
        };
        let snapshot: HostSnapshot = seedBrowserSnapshot(
          {
            ...original,
            browserSessions: original.browserSessions
              .filter((session) => session.id === destination.sessionId)
              .map((session) =>
                seedBrowserSession(
                  { ...session, state: "failed" as const },
                  { generation: 0, revision: 0, rows: [] },
                ),
              ),
            tabRestoreVersion: 1,
          } as HostSnapshot,
          [],
        );
        vi.spyOn(source, "getSnapshot").mockImplementation(() => snapshot);
        Object.defineProperty(source, "browserTabs", { get: () => snapshot.browserTabs });
        // Outside the bounded catalog, the client holds none of this browser's rows.
        source.browserTabs.clear();
        const listeners = new Set<() => void>();
        vi.spyOn(source, "subscribe").mockImplementation((listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        });
        read.mockImplementation(async () => {
          snapshot = seedBrowserSnapshot(
            seedBrowserSnapshot({ ...snapshot } as HostSnapshot, [group]),
          );
          for (const listener of listeners) listener();
          return group;
        });
        Object.assign(source, { readPersonalTabs: read });
        if (remembered) {
          rememberPlace(
            { deploymentId: original.deploymentId, userId: original.user!.id },
            destination,
          );
          return "/";
        }
        return `/?panel=browser&browser=${destination.sessionId}&browserTab=${destination.tabId}`;
      });
      await settle(60);
      expect(read).toHaveBeenCalledWith(destination!.sessionId);
      const params = new URLSearchParams(history.at(-1)!.search);
      expect(params.get("browserTab")).toBe(destination!.tabId);
      expect(
        placeList(client.getSnapshot()).some(
          (place) =>
            place.destination.kind === "browser" && place.destination.tabId === destination!.tabId,
        ),
      ).toBe(true);
    },
  );
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
    await settle();
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
    await settle(400);
    const viewfinder = element<HTMLButtonElement>(".viewfinder:not(:disabled)");
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
    await settle(1_200);
    // A task finishing is a completion; the middle and the conversation stay put.
    const running = client
      .getSnapshot()
      .threads.find((thread) => thread.status === "running" && thread.listed);
    expect(running).toBeDefined();
    await act(async () => {
      await client.stopRun(running!.id).catch(() => undefined);
    });
    await settle(300);
    expect(history.length).toBe(before);
  });

  it("legacy /live opens Home, keeps an explicit place and invents none", async () => {
    await mount((source) => {
      const target = pageTab(source);
      if (target.destination.kind !== "browser") throw new Error("browser");
      return `/live?browser=${target.destination.sessionId}&browserTab=${target.destination.tabId}`;
    });
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

  it("a browser address without its tab is canonicalised by one replace", async () => {
    await mount((source) => {
      const target = pageTab(source);
      if (target.destination.kind !== "browser") throw new Error("browser");
      return `/tasks/${delegating(source)}?panel=browser&browser=${target.destination.sessionId}`;
    });
    await settle(100);
    const replaces = history.filter((step) => step.type === "REPLACE");
    expect(replaces).toHaveLength(1);
    expect(new URLSearchParams(history.at(-1)!.search).get("browserTab")).not.toBeNull();
  });
});

describe("the conversation survives layout changes", () => {
  it("keeps the draft, the textarea and its focus through Hide and Show computer", async () => {
    await mount((source) => `/${tabSearch(pageTab(source))}`);
    const place = pageTab();
    const field = element<HTMLTextAreaElement>("[data-composer-input]");
    field.focus();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        field,
        "Keep this",
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: ".", metaKey: true }));
    });
    await settle();
    expect(document.querySelector(".place")).toBeNull();
    expect(element("[data-composer-input]")).toBe(field);
    expect(field.value).toBe("Keep this");
    expect(document.activeElement).toBe(field);
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: ".", metaKey: true }));
    });
    await settle();
    expect(element(".place").getAttribute("data-place-key")).toBe(place.key);
    expect(element("[data-composer-input]")).toBe(field);
    expect(field.value).toBe("Keep this");
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
    await settle();
    expect(element(".workspace__conversation").contains(document.activeElement)).toBe(true);
  });
});

describe("breakpoints change layout, never the conversation", () => {
  it("keeps the textarea, its draft, the chip and focus from 1440 to 820 to 390 and back", async () => {
    await mount((source) => `/${tabSearch(pageTab(source))}`);
    const place = pageTab();
    await settle(100);
    const field = element<HTMLTextAreaElement>("[data-composer-input]");
    field.focus();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        field,
        "Still here",
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const before = history.length;
    for (const width of [820, 390, 1100, 1440]) {
      await resize(width);
      expect(element("[data-composer-input]")).toBe(field);
      expect(field.value).toBe("Still here");
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
    await settle(300);
    expect(face.isConnected).toBe(false);
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(
      element(`.side-tab[data-place-key="${place.key}"] .side-tab__main`),
    );
  });
});

describe("the Needs you pill", () => {
  it("opens the Needs you list, loads older asks, and opens one in the task it waits in", async () => {
    let askTask = "";
    await mount((source) => {
      askTask = source.getSnapshot().threads.find((thread) => thread.purpose === "task")!.id;
      const older = {
        kind: "team-ask" as const,
        teamId: createId("deployment"),
        requestId: createId("teamAgentRequest"),
        createdAt: new Date().toISOString(),
        consentExpiresAt: new Date(Date.now() + 86400000).toISOString(),
        presentation: {
          asker: {
            teamUserId: createId("user"),
            displayName: "Older teammate",
            actor: "agent" as const,
          },
          bodyMarkdown: "Review the older ask",
          attachments: [],
          destination: {
            teamId: createId("deployment"),
            channelId: createId("teamChannel"),
            threadRootId: TeamMessageIdSchema.parse("1"),
          },
          audience: {
            teamName: "Acme",
            channelName: "review",
            channelKind: "private" as const,
            memberCount: 2,
            peopleOnly: false,
          },
        },
        task: {
          threadId: ThreadIdSchema.parse(askTask),
          messageId: createId("message"),
          revision: 0,
        },
      };
      const getSnapshot = source.getSnapshot.bind(source);
      const page = getSnapshot().needsYou!;
      let current: HostSnapshot = {
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
      button.textContent?.includes("Older teammate"),
    );
    expect(row).toBeDefined();
    await click(row!);
    // No dialog of its own: the ask is answered in its task.
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
    await settle(50);
    expect(element(".place .computer-watch__app").textContent).toBe(phone.title);
    expect(element(".place .computer-watch__stop").textContent).toBe("Stop");
  });
});

describe("a channel and back", () => {
  it("searches a channel from its button and from ⌘F", async () => {
    await mount(`/teams/${mockTeamId}/c/${mockTeamChannelId}`, { team: true });
    const scoped = { path: `/teams/${mockTeamId}/search`, search: `?in=${mockTeamChannelId}` };
    await click(element('.channel button[aria-label^="Search"]'));
    expect(history.at(-1)).toMatchObject(scoped);

    await act(async () => goTo!(-1));
    await settle();
    const find = new KeyboardEvent("keydown", { key: "f", metaKey: true, cancelable: true });
    await act(async () => {
      window.dispatchEvent(find);
    });
    expect(find.defaultPrevented).toBe(true);
    await settle();
    expect(history.at(-1)).toMatchObject(scoped);
  });

  it("switches to each side's exact address and follows Back and Forward", async () => {
    await mount((source) => `/tasks/${delegating(source)}${tabSearch(pageTab(source))}`, {
      team: true,
    });
    const task = history.at(-1)!;
    const team = () => element('.side-switch [role="radio"]:not([data-value="tasks"])');
    const tasks = () => element('.side-switch [role="radio"][data-value="tasks"]');
    const entries = history.length;
    await click(team());
    expect(history.slice(entries).filter((step) => step.type === "PUSH")).toHaveLength(1);
    expect(history.at(-1)!.path).toMatch(/^\/teams\/[^/]+\/c\/[^/]+$/u);
    expect(team().getAttribute("aria-checked")).toBe("true");
    const channel = history.at(-1)!;
    await click(tasks());
    expect(history.at(-1)).toEqual({ ...task, type: "PUSH" });
    expect(tasks().getAttribute("aria-checked")).toBe("true");
    const reselected = history.length;
    const selectedKey = historyKey;
    await click(tasks());
    expect(history.length).toBe(reselected);
    expect(historyKey).toBe(selectedKey);
    await click(team());
    expect(history.at(-1)).toEqual({ ...channel, type: "PUSH" });
    await act(async () => goTo!(-1));
    expect(history.at(-1)).toEqual({ ...task, type: "POP" });
    expect(tasks().getAttribute("aria-checked")).toBe("true");
    await act(async () => goTo!(1));
    expect(history.at(-1)).toEqual({ ...channel, type: "POP" });
    expect(team().getAttribute("aria-checked")).toBe("true");
  });

  it("remembers a team's thread across a round trip through Tasks", async () => {
    await mount((source) => `/tasks/${delegating(source)}${tabSearch(pageTab(source))}`, {
      team: true,
    });
    const task = history.at(-1)!;
    const host = teamHost!;
    const message = host.post({ channelId: mockTeamChannelId, bodyMarkdown: "Thread bookmark" });
    const thread = `/teams/${mockTeamId}/c/${mockTeamChannelId}/t/${message.id}`;
    await act(async () => goTo!(thread));
    expect(
      element('.side-switch [role="radio"][aria-checked="true"]').getAttribute("data-value"),
    ).toBe(mockTeamId);
    await click(element('.side-switch [role="radio"][data-value="tasks"]'));
    expect(history.at(-1)).toEqual({ ...task, type: "PUSH" });
    await click(element(`.side-switch [role="radio"][data-value="${mockTeamId}"]`));
    expect(history.at(-1)).toMatchObject({ path: thread, search: "", type: "PUSH" });
  });

  it("returns to Tasks without a tab opening that finished while the team was shown", async () => {
    let task = "";
    await mount(
      (source) => {
        task = `/tasks/${delegating(source)}`;
        return `${task}?panel=browser&pendingBrowserTab=opening`;
      },
      { team: true },
    );
    await click(element(`.side-switch [role="radio"][data-value="${mockTeamId}"]`));
    await click(element('.side-switch [role="radio"][data-value="tasks"]'));
    expect(history.at(-1)).toMatchObject({ path: task, search: "?panel=browser", type: "PUSH" });
  });

  it("remembers a knowledge query and hash while settings and the directory leave both bookmarks alone", async () => {
    await mount((source) => `/tasks/${delegating(source)}${tabSearch(pageTab(source))}`, {
      team: true,
    });
    const task = history.at(-1)!;
    const knowledge = `/teams/${mockTeamId}/knowledge?q=bookmark#topic`;
    await act(async () => goTo!(knowledge));
    await act(async () => goTo!("/settings/general"));
    await click(element(".settings-navigation__back"));
    await click(element('.side-switch [role="radio"][data-value="tasks"]'));
    expect(history.at(-1)).toEqual({ ...task, type: "PUSH" });
    await click(element(`.side-switch [role="radio"][data-value="${mockTeamId}"]`));
    expect(history.at(-1)).toMatchObject({
      path: `/teams/${mockTeamId}/knowledge`,
      search: "?q=bookmark",
      hash: "#topic",
      type: "PUSH",
    });
    await act(async () => goTo!("/teams"));
    expect(
      element('.side-switch [role="radio"][aria-checked="true"]').getAttribute("data-value"),
    ).toBe(mockTeamId);
    await click(element(`.side-switch [role="radio"][data-value="${mockTeamId}"]`));
    expect(history.at(-1)).toMatchObject({
      path: `/teams/${mockTeamId}/knowledge`,
      search: "?q=bookmark",
      hash: "#topic",
    });
  });

  it("restores this window's bookmarks after reload without redirecting an incoming team link", async () => {
    await mount((source) => `/tasks/${delegating(source)}${tabSearch(pageTab(source))}`, {
      team: true,
    });
    const task = history.at(-1)!;
    await act(async () => goTo!(`/teams/${mockTeamId}/knowledge?q=saved`));
    await act(async () => root!.unmount());
    setRoot(null);
    resetHistory();
    const incoming = `/teams/${mockTeamId}/c/${mockTeamChannelId}`;
    await mount(incoming, { sameHost: true, team: true });
    expect(history).toEqual([{ path: incoming, search: "", type: "POP" }]);
    await click(element('.side-switch [role="radio"][data-value="tasks"]'));
    expect(history.at(-1)).toEqual({ ...task, type: "PUSH" });
    await click(element(`.side-switch [role="radio"][data-value="${mockTeamId}"]`));
    expect(history.at(-1)).toEqual({ path: incoming, search: "", type: "PUSH" });
  });

  it("keeps only passive launcher return state when restoring a side", async () => {
    let from = "";
    await mount(
      (source) => {
        from = tabSearch(pageTab(source)).slice(1);
        return {
          pathname: `/tasks/${delegating(source)}`,
          search: "?panel=browser",
          state: {
            startFrom: from,
            startId: "consumed",
            startAddress: "https://example.com",
            startOpen: false,
            focusRequest: "consumed",
          },
        };
      },
      { team: true },
    );
    await click(element(`.side-switch [role="radio"][data-value="${mockTeamId}"]`));
    await click(element('.side-switch [role="radio"][data-value="tasks"]'));
    expect(historyState).toEqual({ startFrom: from });
    const entries = history.length;
    const selectedKey = historyKey;
    await click(element('.side-switch [role="radio"][data-value="tasks"]'));
    expect(history.length).toBe(entries);
    expect(historyKey).toBe(selectedKey);
    await act(async () =>
      element(".start-page").dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(placeParams(history.at(-1)!.search)).toBe(placeParams(`?${from}`));
  });

  it("does not graft a remembered place onto a direct team address at startup", async () => {
    await mount(
      (source) => {
        const snapshot = source.getSnapshot();
        rememberPlace(
          { deploymentId: snapshot.deploymentId, userId: snapshot.user!.id },
          pageTab(source).destination,
        );
        const read = source.getSnapshot.bind(source);
        let held: HostSnapshot | null = null;
        let published: HostSnapshot | null = null;
        vi.spyOn(source, "getSnapshot").mockImplementation(() => {
          const next = read();
          if (next !== held) {
            held = next;
            published = { ...next, tabRestoreVersion: 1 };
          }
          return published!;
        });
        return `/teams/${mockTeamId}/c/${mockTeamChannelId}`;
      },
      { team: true },
    );
    expect(history).toEqual([
      { path: `/teams/${mockTeamId}/c/${mockTeamChannelId}`, search: "", type: "POP" },
    ]);
    expect(document.querySelector(".place")).toBeNull();
  });

  it.each(["team", "settings", "task"])(
    "fences a deferred place result when navigating to %s, preserving same-side task changes",
    async (target) => {
      const gate = deferred<Awaited<ReturnType<NonNullable<HostClient["reopenPersonalTab"]>>>>();
      const reopen = vi.fn(() => gate.promise);
      vi.stubGlobal("opensteerDesktop", {
        getLocalVisibility: async () => true,
        onLocalVisibilityChanged: () => () => undefined,
        setBadgeCount: vi.fn(async () => undefined),
      });
      await mount((source) => `/tasks/${delegating(source)}`, {
        team: true,
        hostClient: (source) => {
          const read = source.getSnapshot.bind(source);
          let held: HostSnapshot | null = null;
          let published: HostSnapshot | null = null;
          vi.spyOn(source, "getSnapshot").mockImplementation(() => {
            const next = read();
            if (next !== held) {
              held = next;
              published = { ...next, tabReopenAvailable: true };
            }
            return published!;
          });
          Object.assign(source, { reopenPersonalTab: reopen });
          return source;
        },
      });
      await act(async () =>
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "t", metaKey: true, shiftKey: true, bubbles: true }),
        ),
      );
      expect(reopen).toHaveBeenCalledOnce();
      const pathname =
        target === "team"
          ? `/teams/${mockTeamId}/c/${mockTeamChannelId}`
          : target === "settings"
            ? "/settings/general"
            : `/tasks/${client.getSnapshot().threads.find((thread) => thread.purpose === "task" && thread.id !== delegating(client))!.id}`;
      await act(async () => goTo!(pathname));
      const channel = history.at(-1)!;
      const entries = history.length;
      const place = pageTab();
      const destination = place.destination;
      if (destination.kind !== "browser") throw new Error("Expected browser place");
      await act(async () =>
        gate.resolve({
          type: "tab.reopen",
          sessionId: BrowserSessionIdSchema.parse(destination.sessionId),
          tabId: BrowserSurfaceIdSchema.parse(destination.tabId),
          layout: { revision: 0, groups: [] },
        }),
      );
      if (target === "task") {
        expect(history).toHaveLength(entries + 1);
        expect(history.at(-1)!.path).toBe(pathname);
        expect(placeParams(history.at(-1)!.search)).toBe(placeParams(tabSearch(place)));
      } else {
        expect(history).toHaveLength(entries);
        expect(history.at(-1)).toEqual(channel);
        expect(document.querySelector(".place")).toBeNull();
      }
    },
  );

  it.each(["removed", "viewer-changed"] as const)(
    "clears a confirmed %s team's bookmark, preserving it while offline",
    async (ended) => {
      await mount(`/teams/${mockTeamId}/knowledge?q=keep`, { team: true });
      await click(element('.side-switch [role="radio"][data-value="tasks"]'));
      await act(async () => teamSession!.disconnect());
      await click(element(`.side-switch [role="radio"][data-value="${mockTeamId}"]`));
      expect(history.at(-1)).toMatchObject({
        path: `/teams/${mockTeamId}/knowledge`,
        search: "?q=keep",
      });
      await click(element('.side-switch [role="radio"][data-value="tasks"]'));
      await act(async () => teamSession!.remove(ended));
      const key = Object.keys(sessionStorage).find((key) =>
        key.startsWith("opensteer.workspace.sides.v1:"),
      )!;
      expect(JSON.parse(sessionStorage.getItem(key)!).bookmarks[mockTeamId]).toBeUndefined();
      await click(element(`.side-switch [role="radio"][data-value="${mockTeamId}"]`));
      expect(history.at(-1)!.path).toBe(`/teams/${mockTeamId}/`);
      expect(history.at(-1)!.search).toBe("");
    },
  );

  it.each(["deployment", "personal-user", "team-viewer"])(
    "scopes stored bookmarks to the %s",
    async (changed) => {
      await mount(
        (source) => {
          const snapshot = source.getSnapshot();
          const key = `opensteer.workspace.sides.v1:${encodeURIComponent(changed === "deployment" ? "other" : snapshot.deploymentId!)}:${encodeURIComponent(changed === "personal-user" ? "other" : snapshot.user!.id)}`;
          sessionStorage.setItem(
            key,
            JSON.stringify({
              side: "tasks",
              bookmarks: {
                tasks: {
                  pathname: `/tasks/${delegating(source)}`,
                  search: tabSearch(pageTab(source)),
                  hash: "",
                  startFrom: null,
                  viewer: null,
                },
                [mockTeamId]: {
                  pathname: `/teams/${mockTeamId}/knowledge`,
                  search: "?q=private",
                  hash: "",
                  startFrom: null,
                  viewer: changed === "team-viewer" ? "other" : mockTeamUserId,
                },
              },
            }),
          );
          return changed === "team-viewer"
            ? `/tasks/${delegating(source)}`
            : `/teams/${mockTeamId}/c/${mockTeamChannelId}`;
        },
        { team: true },
      );
      await click(
        element(
          `.side-switch [role="radio"][data-value="${changed === "team-viewer" ? mockTeamId : "tasks"}"]`,
        ),
      );
      expect(history.at(-1)!.search).not.toContain("browserTab");
      expect(history.at(-1)!.search).not.toContain("private");
      expect(history.at(-1)!.path).toBe(
        changed === "team-viewer" ? `/teams/${mockTeamId}/c/${mockTeamChannelId}` : "/",
      );
    },
  );

  it("remembers in memory when session storage is refused", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation((key) => {
      if (key.startsWith("opensteer.workspace.sides.v1:")) throw new Error("Storage refused");
      return null;
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage refused");
    });
    await mount((source) => `/tasks/${delegating(source)}${tabSearch(pageTab(source))}`, {
      team: true,
    });
    const task = history.at(-1)!;
    await click(element(`.side-switch [role="radio"][data-value="${mockTeamId}"]`));
    await click(element('.side-switch [role="radio"][data-value="tasks"]'));
    expect(history.at(-1)).toEqual({ ...task, type: "PUSH" });
  });

  it("a missing task redirects home with its place intact", async () => {
    await mount((source) => {
      const missingId = createId("thread");
      const read = source.getSnapshot.bind(source);
      let held: HostSnapshot | null = null;
      let published: HostSnapshot | null = null;
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
    expect(history.at(-1)!.path).toBe("/");
    expect(placeParams(history.at(-1)!.search)).toBe(placeParams(tabSearch(pageTab())));
    expect(element(".place").getAttribute("data-place-key")).toBe(pageTab().key);
  });

  it("keeps the team last shown named while on Tasks, across a reload", async () => {
    await mount("/", { team: { second: "Beacon" } });
    const named = () =>
      document.querySelector('.side-switch [role="radio"].is-recent')?.getAttribute("aria-label");
    const choose = (label: string) =>
      click(element(`.side-switch [role="radio"][aria-label^="${label}"]`));
    expect(named()).toMatch(/^Acme/u);
    await choose("Beacon");
    await click(element('.side-switch [data-value="tasks"]'));
    expect(element('.side-switch [aria-checked="true"]').getAttribute("data-value")).toBe("tasks");
    expect(named()).toMatch(/^Beacon/u);

    act(() => root?.unmount());
    setRoot(null);
    document.body.replaceChildren();
    await mount("/", { team: { second: "Beacon" }, sameHost: true });
    expect(element('.side-switch [aria-checked="true"]').getAttribute("data-value")).toBe("tasks");
    expect(named()).toMatch(/^Beacon/u);
  });

  it("a tab opened from a channel docks the channel beside its page, and Back fills the window again", async () => {
    await mount("/", { team: true });
    await click(element('.side-switch [role="radio"]:not([data-value="tasks"])'));
    await click(element(".team-row[data-channel-id] .team-row__main"));
    const channel = history.at(-1)!;
    expect(document.querySelector(".place")).toBeNull();
    const place = pageTab();
    await click(element(`.side-tab[data-place-key="${place.key}"] .side-tab__main`));
    expect(history.at(-1)!.path).toBe(channel.path);
    expect(element(".place").getAttribute("data-place-key")).toBe(place.key);
    expect(element(".workspace__conversation .channel")).toBeTruthy();

    await act(async () => goTo!(-1));
    await settle();
    expect(history.at(-1)).toMatchObject({ path: channel.path, search: channel.search });
    expect(document.querySelector(".place")).toBeNull();
  });
  it("the input source opens its team message after Open task", async () => {
    await mount("/", {
      team: true,
      hostClient: (source) => {
        const taskId = delegating(source),
          originalRead = source.getSnapshot;
        const origin = {
          teamId: mockTeamId,
          channelId: mockTeamChannelId,
          threadRootId: TeamMessageIdSchema.parse("1"),
        };
        let held: HostSnapshot | null = null,
          published: HostSnapshot | null = null;
        Object.defineProperty(source, "getSnapshot", {
          value: () => {
            const snapshot = originalRead();
            if (snapshot !== held) {
              held = snapshot;
              const ask = Object.values(snapshot.transcripts)
                .flat()
                .find((entry) => entry.kind === "message" && entry.messageKind === "input");
              published = {
                ...snapshot,
                transcripts: {
                  ...snapshot.transcripts,
                  [taskId]: [...(ask ? [ask] : []), ...(snapshot.transcripts[taskId] ?? [])].map(
                    (entry) =>
                      entry.kind === "message" && entry.messageKind === "input"
                        ? {
                            ...entry,
                            teamSource: {
                              ...origin,
                              messageId: origin.threadRootId,
                              audience: {
                                teamName: "Team",
                                channelName: "general",
                                channelKind: "public",
                                memberCount: 2,
                                peopleOnly: false,
                              },
                            },
                          }
                        : entry,
                  ),
                },
                threads: snapshot.threads.map((thread) =>
                  thread.id === taskId ? { ...thread, teamOrigin: origin } : thread,
                ),
              };
            }
            return published!;
          },
        });
        const rpc = source.rpc;
        Object.defineProperty(source, "rpc", {
          value: new Proxy(rpc, {
            get(target, property) {
              if (property === "teams.threadTask.get")
                return async () => ({
                  ok: true,
                  data: { taskId: ThreadIdSchema.parse(delegating(source)) },
                });
              return Reflect.get(target, property);
            },
          }),
        });
        return source;
      },
    });
    const taskId = delegating(client),
      host = teamHost!;
    const channelId = host.bootstrap.sidebar.channels[0]!.channel.id;
    const root = host.post({ channelId, bodyMarkdown: "Ask my agent" });
    host.setRequest({
      id: TeamAgentRequestIdSchema.parse(createId("teamAgentRequest")),
      kind: "self",
      consentExpiresAt: null,
      ownerUserId: host.userId,
      channelId,
      threadRootId: root.id,
      triggerMessageId: root.id,
      state: "working",
      steps: [],
      createdAt: root.createdAt,
      acceptedAt: root.createdAt,
      expiresAt: "2027-01-01T00:00:00Z",
      finishedAt: null,
      replyMessageId: null,
      failureCode: null,
      changeSeq: root.changeSeq,
    });
    await act(async () =>
      goTo!(`/teams/${host.teamId}/c/${channelId}/t/${root.id}${tabSearch(pageTab())}`),
    );
    await act(async () => {
      await vi.waitFor(
        () => expect(document.querySelector(".agent-card__controls button")).not.toBeNull(),
        { timeout: 1000 },
      );
    });
    const before = history.at(-1)!;
    const open = [...document.querySelectorAll<HTMLButtonElement>(".thread-pane button")].find(
      (button) => button.textContent === "Open task",
    );
    expect(open).toBeTruthy();
    await click(open!);
    expect(history.at(-1)!.path).toBe(`/tasks/${taskId}`);
    await click(element(".team-input-source"));
    expect(history.at(-1)).toMatchObject({
      path: before.path,
      search: before.search,
    });
    expect(element(".workspace__conversation .thread-pane")).toBeTruthy();
    expect(element(".place")).toBeTruthy();
  });
});
