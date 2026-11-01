// @vitest-environment happy-dom
import { act } from "react";

import { describe, expect, it, vi } from "vitest";

import { placeList, taskAttention, taskList, type HostSnapshot } from "@opensteer/client/host";
import { BrowserSurfaceIdSchema } from "@opensteer/core";
import { createBrowserSessionId, type WorkspaceTabLineage } from "@opensteer/protocol";

import { rememberPlace } from "./navigation.js";

import {
  root,
  client,
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
      threadId = snapshot.threads.find((thread) => thread.id !== snapshot.homeThreadId)!.id;
      const place = pageTab(source);
      if (place.destination.kind !== "browser") throw new Error("Missing browser place");
      return `/threads/${threadId}?panel=browser&browser=${place.destination.sessionId}`;
    });
    const canonical = history.at(-1)!;
    expect(canonical).toMatchObject({ path: `/threads/${threadId}`, type: "REPLACE" });
    const selectedTab = new URLSearchParams(canonical.search).get("browserTab");
    expect(selectedTab).toBeTruthy();
    const place = placeList(client.getSnapshot()).find(
      (item) => item.destination.kind === "browser" && item.destination.tabId === selectedTab,
    );
    if (!place) throw new Error("Canonical browser tab is missing from places");
    expect(element(".place").getAttribute("data-place-key")).toBe(place.key);

    await openSettingsFromWorkspace();
    expect(history.at(-1)).toMatchObject({ path: "/settings/ai-engines", type: "REPLACE" });
    await click(element<HTMLAnchorElement>('.settings-navigation__link[href="/settings/account"]'));
    expect(history.at(-1)).toMatchObject({ path: "/settings/account", type: "PUSH" });

    const beforeBack = history.length;
    await click(element(".settings-navigation__back"));
    await settle(100);
    expect(history.slice(beforeBack)).toEqual([
      { path: `/threads/${threadId}`, search: canonical.search, type: "PUSH" },
    ]);
    expect(element(".thread")).toBeTruthy();
    expect(element(".place").getAttribute("data-place-key")).toBe(place.key);
  });

  it("returns past a replaced legacy computers alias without looping", async () => {
    let threadId = "";
    await mount((source) => {
      const snapshot = source.getSnapshot();
      threadId = snapshot.threads.find((thread) => thread.id !== snapshot.homeThreadId)!.id;
      return `/threads/${threadId}`;
    });
    await act(async () => goTo!("/computers"));
    await settle();
    expect(history.slice(-2)).toEqual([
      { path: "/computers", search: "", type: "PUSH" },
      { path: "/settings/computers", search: "", type: "REPLACE" },
    ]);
    expect(element(".settings-layout")).toBeTruthy();

    const beforeBack = history.length;
    await click(element(".settings-navigation__back"));
    await settle(100);
    expect(history.slice(beforeBack)).toEqual([
      { path: `/threads/${threadId}`, search: "", type: "PUSH" },
    ]);
    expect(element(".thread")).toBeTruthy();
  });

  it("returns to a conversation-only address without reopening the remembered browser", async () => {
    let threadId = "";
    await mount((source) => {
      // A Host that restores workspace tabs, as current Hosts do: the remembered
      // place reopens once at launch, and must not reopen on return from Settings.
      const read = source.getSnapshot.bind(source);
      let base: HostSnapshot | undefined;
      let restoring: HostSnapshot | undefined;
      vi.spyOn(source, "getSnapshot").mockImplementation(() => {
        const current = read();
        if (current !== base || !restoring) {
          base = current;
          restoring = { ...current, workspaceTabRestoreVersion: 1 };
        }
        return restoring;
      });
      const snapshot = source.getSnapshot();
      threadId = snapshot.threads.find((thread) => thread.id !== snapshot.homeThreadId)!.id;
      return `/threads/${threadId}${tabSearch(pageTab(source))}`;
    });
    const place = pageTab();
    if (place.destination.kind !== "browser") throw new Error("Missing browser place");
    const snapshot = client.getSnapshot();
    rememberPlace(
      { deploymentId: snapshot.deploymentId, userId: snapshot.user!.id },
      place.destination,
    );
    const conversationOnly = snapshot.threads.find(
      (thread) => thread.id !== snapshot.homeThreadId && thread.id !== threadId,
    )!;
    await act(async () => goTo!(`/threads/${conversationOnly.id}`));
    await settle();
    expect(history.at(-1)).toMatchObject({
      path: `/threads/${conversationOnly.id}`,
      search: "",
      type: "PUSH",
    });
    expect(document.querySelector(".place")).toBeNull();

    await openSettingsFromWorkspace();
    const beforeBack = history.length;
    await click(element(".settings-navigation__back"));
    await settle(100);
    expect(history.slice(beforeBack)).toEqual([
      { path: `/threads/${conversationOnly.id}`, search: "", type: "PUSH" },
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
    expect(history.slice(beforeBack)).toEqual([{ path: "/", search: "", type: "PUSH" }]);
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
        const group: WorkspaceTabLineage = {
          id: createBrowserSessionId(),
          revision: 1,
          createdAt: "2026-10-19T12:00:00.000Z",
          session: {
            id: destination.sessionId as WorkspaceTabLineage["session"]["id"],
            access: "full-control",
            createdAt: "2026-10-19T12:00:00.000Z",
            updatedAt: "2026-10-19T12:00:00.000Z",
            origin: "workspace",
            placement: {
              kind: "runner",
              runnerId: selected.device!
                .machineId as WorkspaceTabLineage["session"]["placement"]["runnerId"],
            },
            profileId: null,
            runtimeId: "test",
            state: "failed",
            workspaceId: original.homeWorkspaceId as WorkspaceTabLineage["session"]["workspaceId"],
          },
          tabs: [
            {
              kind: "browser",
              id: BrowserSurfaceIdSchema.parse(destination.tabId),
              sessionId: destination.sessionId as WorkspaceTabLineage["session"]["id"],
              title: selected.title,
              site: selected.site ?? "",
              order: 0,
              openerId: null,
              state: "suspended",
            },
          ],
        };
        let snapshot: HostSnapshot = {
          ...original,
          browserSessions: original.browserSessions
            .filter((session) => session.id === destination.sessionId)
            .map((session) => ({
              ...session,
              state: "failed" as const,
              tabCatalog: { generation: 0, revision: 0, tabs: [] },
            })),
          workspaceTabRestoreVersion: 1,
          workspaceTabs: [],
        };
        vi.spyOn(source, "getSnapshot").mockImplementation(() => snapshot);
        const listeners = new Set<() => void>();
        vi.spyOn(source, "subscribe").mockImplementation((listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        });
        read.mockImplementation(async () => {
          snapshot = { ...snapshot, workspaceTabs: [group] };
          for (const listener of listeners) listener();
          return group;
        });
        Object.assign(source, { readWorkspaceTabs: read });
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
    expect(history.at(-1)).toMatchObject({ path: `/threads/${threadId}`, type: "PUSH" });
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
    const occupant = place.occupants.find((value) => !value.home)!;
    const before = history.length;
    await click(
      element(
        `.side-tab[data-place-key="${place.key}"] .occupant-mark[data-thread-id="${occupant.threadId}"]`,
      ),
    );
    expect(history.length).toBe(before + 1);
    expect(history.at(-1)!.path).toBe(`/threads/${occupant.threadId}`);
    expect(placeParams(history.at(-1)!.search)).toBe(placeParams(tabSearch(place)));
  });

  it("a task in the header's family: only the conversation", async () => {
    await mount((source) => `/${tabSearch(pageTab(source))}`);
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
    expect(target.getAttribute("aria-label")).toMatch(/, (Working|Needs you)$/u);
    const before = history.length;
    await click(target);
    expect(history.length).toBe(before + 1);
    expect(history.at(-1)!.path).toMatch(/^\/threads\//u);
    expect(placeParams(history.at(-1)!.search)).toBe(placeParams(tabSearch(place)));
    expect(element(".place")).toBe(middle);
  });

  it("task line in Chat: only the conversation", async () => {
    await mount((source) => `/${tabSearch(pageTab(source))}`);
    const place = pageTab();
    const card = element<HTMLAnchorElement>(".task-line__open");
    const before = history.length;
    await click(card);
    expect(history.length).toBe(before + 1);
    expect(history.at(-1)!.path).toMatch(/^\/threads\//u);
    expect(placeParams(history.at(-1)!.search)).toBe(placeParams(tabSearch(place)));
  });

  it("viewfinder: only the place, and it opens Work from Talk", async () => {
    await mount("/");
    await settle(400);
    const viewfinder = element<HTMLButtonElement>(".viewfinder:not(:disabled)");
    const key = viewfinder.dataset.placeKey!;
    const before = history.length;
    await click(viewfinder);
    expect(history.length).toBe(before + 1);
    expect(history.at(-1)!.path).toBe("/");
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

  it("legacy /live opens Chat, keeps an explicit place and invents none", async () => {
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
    expect(history.at(-1)).toMatchObject({ path: "/", search: "", type: "REPLACE" });
  });

  it("a browser address without its tab is canonicalised by one replace", async () => {
    await mount((source) => {
      const target = pageTab(source);
      if (target.destination.kind !== "browser") throw new Error("browser");
      return `/?panel=browser&browser=${target.destination.sessionId}`;
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
    await mount((source) => `/new${tabSearch(pageTab(source))}`);
    expect(document.querySelector(".conv-header--area .conv-header__actions")).toBeNull();
    await click(element(".conv-header--area .conv-header__menu"));
    const expand = [
      ...document.querySelectorAll<HTMLButtonElement>(".popover--conversation-menu button"),
    ].find((button) => button.textContent?.startsWith("Expand chat"));
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
    const occupant = place.occupants.find((value) => !value.home)!;
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

describe("the Tasks count", () => {
  it("counts tasks, not requests, and opens the first one at its request without moving the middle", async () => {
    // From a task with nothing asked, so the first ask is somewhere else.
    await mount((source) => {
      const asked = new Set(taskAttention(source.getSnapshot()).map((ask) => ask.threadId));
      const quiet = source
        .getSnapshot()
        .threads.find(
          (thread) =>
            thread.listed &&
            thread.id !== source.getSnapshot().homeThreadId &&
            !asked.has(thread.id),
        )!;
      return `/threads/${quiet.id}${tabSearch(pageTab(source))}`;
    });
    const place = pageTab();
    const asks = taskAttention(client.getSnapshot());
    // One per task that needs you — the same rows that wear the amber line, and Opensteer's "!".
    const amberRows =
      document.querySelectorAll(".side-task__ask").length +
      document.querySelectorAll(".side-home .side-bang").length;
    const pill = element<HTMLButtonElement>(".side-needs");
    expect(pill.textContent).toContain(String(asks.length));
    expect(amberRows).toBe(asks.length);
    // The amber line is the request's own title; who proposed it stays on the request.
    for (const line of document.querySelectorAll(".side-task__ask")) {
      expect(line.textContent).not.toContain("Proposed by");
      expect(line.closest(".side-task__main")?.getAttribute("aria-label")).toContain(
        line.textContent,
      );
    }
    const before = history.length;
    await click(pill);
    await settle(80);
    expect(history.length).toBe(before + 1);
    const first =
      asks.find((ask) => ask.threadId === client.getSnapshot().homeThreadId) ?? asks[0]!;
    expect(history.at(-1)!.path).toBe(
      first.threadId === client.getSnapshot().homeThreadId ? "/" : `/threads/${first.threadId}`,
    );
    expect(placeParams(history.at(-1)!.search)).toBe(placeParams(tabSearch(place)));
    expect(
      document.activeElement?.closest(`[data-request-id="${first.requestId}"]`),
    ).not.toBeNull();
  });
});

describe("narrow screens", () => {
  it("≤ 900px: the drawer's button carries how many tasks need you", async () => {
    await mount("/", { width: 820 });
    const button = element<HTMLButtonElement>(".conv-header .drawer-btn");
    expect(button.getAttribute("aria-label")).toMatch(/need you/u);
  });

  it("≤ 700px: a place opens full screen with the conversation as a sheet", async () => {
    await mount((source) => `/${tabSearch(pageTab(source))}`, { width: 390 });
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

describe("sidebar Done shelf", () => {
  async function mountWithDone() {
    await mount("/");
    const task = taskList(client.getSnapshot()).ready.find((item) => item.canBeDone)!;
    expect(task).toBeDefined();
    const read = client.getSnapshot().threadReadStates[task.threadId];
    if (read?.unreadSequence)
      await act(async () => client.markThreadRead(task.threadId, read.unreadSequence!));
    await act(async () => client.setTaskDone(task.threadId, true));
    return task.threadId;
  }
  const shelf = () => element<HTMLButtonElement>(".side-done button");
  const row = (id: string) => document.querySelector(`.side-task[data-thread-id="${id}"]`);

  it("defaults closed, shows Done rows on toggle and remembers the choice across remount", async () => {
    await mountWithDone();
    const done = taskList(client.getSnapshot()).done;
    expect(done.length).toBeGreaterThan(0);
    expect(shelf().getAttribute("aria-expanded")).toBe("false");
    expect(shelf().getAttribute("aria-label")).toBe(
      `Done, ${done.length} ${done.length === 1 ? "task" : "tasks"}`,
    );
    expect(row(done[0]!.threadId)).toBeNull();
    await click(shelf());
    expect(shelf().getAttribute("aria-expanded")).toBe("true");
    expect(row(done[0]!.threadId)).not.toBeNull();
    expect(localStorage.getItem("opensteer.sidebar-done-open")).toBe("true");
    await act(async () => root!.unmount());
    client.dispose();
    await mountWithDone();
    expect(shelf().getAttribute("aria-expanded")).toBe("true");
    expect(row(done[0]!.threadId)).not.toBeNull();
    await click(shelf());
    expect(row(done[0]!.threadId)).toBeNull();
    expect(localStorage.getItem("opensteer.sidebar-done-open")).toBe("false");
  });

  it("opens even when the preference cannot be saved", async () => {
    await mountWithDone();
    const done = taskList(client.getSnapshot()).done[0]!;
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    await click(shelf());
    expect(shelf().getAttribute("aria-expanded")).toBe("true");
    expect(row(done.threadId)).not.toBeNull();
  });

  it("hides the shelf when no Done tasks exist", async () => {
    await mountWithDone();
    for (const done of taskList(client.getSnapshot()).done)
      await act(async () => client.setTaskDone(done.threadId, false));
    expect(document.querySelector(".side-done")).toBeNull();
    expect(element("#sidebar-tasks").textContent).toBe("Tasks");
  });

  it.each([false, true])(
    "renders the Tasks section only when its Done-only list has rows: %s",
    async (hasDone) => {
      await mount((source) => {
        const snapshot = source.getSnapshot();
        const task = taskList(snapshot).ready[0]!;
        const entry = snapshot.tasks!.entries.find(({ thread }) => thread.id === task.threadId)!;
        vi.spyOn(source, "getSnapshot").mockReturnValue({
          ...snapshot,
          activeTasks: [],
          tasks: {
            ...snapshot.tasks!,
            entries: hasDone
              ? [
                  {
                    ...entry,
                    thread: { ...entry.thread, doneAt: new Date().toISOString(), status: "idle" },
                  },
                ]
              : [],
          },
          threadReadStates: {},
        });
        return "/";
      });
      expect(document.querySelector("#sidebar-tasks") !== null).toBe(hasDone);
      expect(document.querySelector(".side-done") !== null).toBe(hasDone);
      if (hasDone) expect(shelf().getAttribute("aria-label")).toBe("Done, 1 task");
      expect(document.querySelector(".side-section--tasks [data-thread-id]")).toBeNull();
    },
  );

  it("moves a Ready row through Mark Done and Reopen using its context menu", async () => {
    await mountWithDone();
    await click(shelf());
    const task = taskList(client.getSnapshot()).ready.find((item) => item.canBeDone)!;
    expect(task).toBeDefined();
    if (task.unread) {
      const read = client.getSnapshot().threadReadStates[task.threadId]!;
      await act(async () => client.markThreadRead(task.threadId, read.unreadSequence!));
    }
    const choose = async (name: string) => {
      await act(async () =>
        row(task.threadId)!.dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
        ),
      );
      const action = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (node) => node.textContent?.trim() === name,
      )!;
      expect(action).toBeDefined();
      await click(action);
    };
    const before = row(task.threadId);
    await choose("Mark Done");
    // The row keeps its element across the move, so focus and its slide survive.
    expect(row(task.threadId)).toBe(before);
    expect(
      element(".side-done").compareDocumentPosition(row(task.threadId)!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      taskList(client.getSnapshot()).done.some((item) => item.threadId === task.threadId),
    ).toBe(true);
    await choose("Reopen");
    expect(row(task.threadId)).toBe(before);
    expect(
      taskList(client.getSnapshot()).ready.some((item) => item.threadId === task.threadId),
    ).toBe(true);
    expect(
      row(task.threadId)!.compareDocumentPosition(element(".side-done")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("indicates an open Done conversation while closed without changing the preference", async () => {
    const id = await mountWithDone();
    await act(async () => goTo!(`/threads/${id}`));
    expect(shelf().getAttribute("aria-current")).toBe("true");
    expect(element(".side-done").classList.contains("is-filled")).toBe(true);
    expect(row(id)).toBeNull();
    expect(shelf().getAttribute("aria-expanded")).toBe("false");
    expect(localStorage.getItem("opensteer.sidebar-done-open")).toBeNull();
    await click(shelf());
    expect(shelf().hasAttribute("aria-current")).toBe(false);
    expect(element(`[data-thread-id="${id}"] a`).getAttribute("aria-current")).toBe("page");
  });

  it("loads earlier tasks with busy state and allows another attempt after failure", async () => {
    let reject!: (error: Error) => void;
    let load!: ReturnType<typeof vi.spyOn>;
    await mount((source) => {
      const read = source.getSnapshot.bind(source);
      let previous: HostSnapshot | undefined;
      let next: HostSnapshot;
      vi.spyOn(source, "getSnapshot").mockImplementation(() => {
        const snapshot = read();
        if (previous !== snapshot) {
          previous = snapshot;
          next = {
            ...snapshot,
            tasks: snapshot.tasks
              ? { ...snapshot.tasks, window: { ...snapshot.tasks.window, hasMore: true } }
              : null,
          };
        }
        return next;
      });
      load = vi
        .spyOn(source, "loadEarlierTasks")
        .mockImplementationOnce(
          () =>
            new Promise<void>((_resolve, fail) => {
              reject = fail;
            }),
        )
        .mockResolvedValue(undefined);
      return "/";
    });
    await click(element(".side-section--tasks .sidebar__more"));
    expect(load).toHaveBeenCalledTimes(1);
    const more = element<HTMLButtonElement>(".side-section--tasks .sidebar__more");
    expect(more.disabled).toBe(true);
    expect(more.textContent).toBe("Loading…");
    await act(async () => reject(new Error("Earlier tasks unavailable")));
    expect(more.disabled).toBe(false);
    expect(more.textContent).toBe("Show more");
    await click(more);
    expect(load).toHaveBeenCalledTimes(2);
    expect(more.disabled).toBe(false);
  });

  it("redirects a stale Tasks address to Chat", async () => {
    await mount("/tasks");
    expect(history.at(-1)?.path).toBe("/");
    expect(element(".side-home__main").getAttribute("aria-current")).toBe("page");
    expect(document.querySelector('[aria-label="All tasks"]')).toBeNull();
  });
});
