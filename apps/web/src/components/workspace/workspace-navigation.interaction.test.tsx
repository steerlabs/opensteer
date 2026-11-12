import { seedBrowserSession } from "@opensteer/client/test-support";
import { seedBrowserSnapshot } from "@opensteer/client/test-support";
import type { PersonalTabLineage } from "@opensteer/client/host";
// @vitest-environment happy-dom
import { act } from "react";

import { describe, expect, it, vi } from "vitest";

import { placeList, type HostSnapshot } from "@opensteer/client/host";
import { BrowserSurfaceIdSchema } from "@opensteer/core";
import { createBrowserSessionId } from "@opensteer/protocol";

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
      { path: "/settings/devices/computers", search: "", type: "REPLACE" },
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
      // A Host that restores workspace tabs, as current Hosts do: the remembered
      // place reopens once at launch, and must not reopen on return from Settings.
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
  it("counts what needs you, lines each ask, and opens All tasks at Needs you without moving the middle", async () => {
    await mount((source) => `/${tabSearch(pageTab(source))}`);
    const place = pageTab();
    const count = client.getSnapshot().needsYou!.count;
    const pill = element<HTMLButtonElement>(".side-needs");
    expect(pill.textContent).toContain(String(count));
    // The amber line is the request's own title; who proposed it stays on the request.
    for (const line of document.querySelectorAll(".side-task__ask")) {
      expect(line.textContent).not.toContain("Proposed by");
      expect(line.closest(".side-task__main")?.getAttribute("aria-label")).toContain(
        line.textContent,
      );
    }
    const before = history.length;
    await click(pill);
    expect(history.length).toBe(before + 1);
    expect(history.at(-1)!.path).toBe("/tasks");
    expect(new URLSearchParams(history.at(-1)!.search).get("filter")).toBe("needs-you");
    expect(placeParams(history.at(-1)!.search)).toBe(placeParams(tabSearch(place)));
    expect(element(".place").getAttribute("data-place-key")).toBe(place.key);
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
  it("Back after jumping into a channel restores the conversation and the page beside it", async () => {
    await mount((source) => `/tasks/${delegating(source)}${tabSearch(pageTab(source))}`, {
      team: true,
    });
    const place = pageTab();
    const before = history.at(-1)!;
    const entries = history.length;
    // Switching sides is the sidebar's own business: nothing navigates.
    await click(element('.side-switch__option:not([data-value="tasks"])'));
    expect(history.length).toBe(entries);
    await click(element(".team-row__main"));
    expect(history.length).toBe(entries + 1);
    expect(history.at(-1)!.path).toMatch(/^\/teams\/[^/]+\/c\/[^/]+$/u);
    // The channel fills the window; the page leaves the middle, and its tab stays in Tabs.
    expect(document.querySelector(".place")).toBeNull();
    expect(element(`.side-tab[data-place-key="${place.key}"]`)).toBeTruthy();

    await act(async () => goTo!(-1));
    await settle();
    expect(history.at(-1)).toMatchObject({
      path: before.path,
      search: before.search,
      type: "POP",
    });
    expect(element(".place").getAttribute("data-place-key")).toBe(place.key);
    expect(element(".thread")).toBeTruthy();
  });

  it("a tab opened from a channel docks the channel beside its page, and Back fills the window again", async () => {
    await mount("/", { team: true });
    await click(element('.side-switch__option:not([data-value="tasks"])'));
    await click(element(".team-row__main"));
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
});
