// @vitest-environment happy-dom
import { act } from "react";

import { describe, expect, it, vi, type MockInstance } from "vitest";

import {
  browserTabStrip,
  placeList,
  type HostSnapshot,
  type PlaceItem,
} from "@opensteer/client/host";
import {
  BrowserSurfaceIdSchema,
  createId,
  ThreadIdSchema,
  WorkspaceIdSchema,
} from "@opensteer/core";
import { WorkspaceTabLineageSchema } from "@opensteer/protocol";
import type { DesktopWorkspaceTabCommand } from "@opensteer/protocol/desktop";

import { tabOrder } from "./tab-order.js";

import {
  root,
  client,
  history,
  mount,
  settle,
  element,
  click,
  pageTab,
  tabSearch,
  write,
  typeInto,
  pressEnter,
  setRoot,
} from "./workspace.interaction.test-support.js";
describe("personal browser tab groups", () => {
  async function mountSaved() {
    await mount((source) => {
      const read = source.getSnapshot;
      const projections = new WeakMap<HostSnapshot, HostSnapshot>();
      vi.spyOn(source, "getSnapshot").mockImplementation(() => {
        const snapshot = read();
        const held = projections.get(snapshot);
        if (held) return held;
        const saved: HostSnapshot = {
          ...snapshot,
          workspaceTabRestoreVersion: 1,
          workspaceTabs: snapshot.browserSessions.map((session) =>
            WorkspaceTabLineageSchema.parse({
              id: session.id,
              revision: session.tabCatalog?.revision ?? 0,
              createdAt: session.createdAt ?? "2026-10-19T12:00:00.000Z",
              session: {
                id: session.id,
                access: session.access,
                origin: session.origin,
                placement: session.placement,
                profileId: session.profileId,
                runtimeId: session.runtimeId,
                state: session.state,
                workspaceId: session.workspaceId,
                createdAt: session.createdAt ?? "2026-10-19T12:00:00.000Z",
                updatedAt: session.createdAt ?? "2026-10-19T12:00:00.000Z",
              },
              tabs: (session.tabCatalog?.tabs ?? []).map((tab) => ({
                ...tab,
                kind: "browser",
                sessionId: session.id,
                state: "live",
              })),
            }),
          ),
        };
        projections.set(snapshot, saved);
        return saved;
      });
      return "/";
    });
  }

  const group = () => client.getSnapshot().browserTabGroups!.groups[0]!;
  const row = (place: PlaceItem) =>
    element(`.side-tab[data-place-key="${place.key}"] .side-tab__main`);
  const action = (label: string) => {
    const found = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === label,
    );
    if (!found) throw new Error(`Missing menu action ${label}`);
    return found;
  };
  async function menu(place: PlaceItem) {
    await act(async () =>
      row(place).dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 40,
          clientY: 300,
        }),
      ),
    );
    await settle();
  }
  const header = () => element<HTMLButtonElement>(".side-tab-group__main");
  async function edit() {
    await click(element(".side-tab-group .side-row-action"));
  }
  async function create(place: PlaceItem) {
    await menu(place);
    await click(action("Add to group"));
    await click(action("New group"));
    expect(document.activeElement).toBe(element('[aria-label="Group title"]'));
    await typeInto(element('[aria-label="Group title"]'), "Research");
    await pressEnter(element('[aria-label="Group title"]'));
  }
  it("creates, joins, edits, collapses without moving the page, and ungroups without closing", async () => {
    await mountSaved();
    const tabs = placeList(client.getSnapshot()).filter((place) => place.kind === "browser");
    const first = tabs[0]!;
    const second = tabs.find((place) => place.browser?.sessionId !== first.browser?.sessionId)!;
    await create(first);
    expect(group().title).toBe("Research");
    await menu(second);
    await click(action("Add to group"));
    await click(action("Research"));
    expect(group().tabIds).toHaveLength(2);
    await click(row(first));
    const page = element(".place");
    const location = history.at(-1);
    await edit();
    await typeInto(element('[aria-label="Group title"]'), "Reading");
    await click(element('[aria-label="purple"]'));
    await pressEnter(element('[aria-label="Group title"]'));
    expect(group()).toMatchObject({ title: "Reading", color: "purple" });
    await click(header());
    expect(header().getAttribute("aria-expanded")).toBe("false");
    expect(header().getAttribute("aria-current")).toBe("true");
    expect(document.querySelector(`.side-tab[data-place-key="${first.key}"]`)).toBeNull();
    expect(element(".place")).toBe(page);
    expect(history.at(-1)).toBe(location);
    const visible = tabOrder(
      placeList(client.getSnapshot()),
      client.getSnapshot().browserTabGroups,
    );
    expect(visible).not.toContainEqual(first);
    expect(visible).not.toContainEqual(second);
    expect(visible.map((place) => place.key)).toEqual(
      [...document.querySelectorAll<HTMLElement>(".side-tab[data-place-key]")].map(
        (item) => item.dataset.placeKey,
      ),
    );
    await click(header());
    expect(row(first)).toBeDefined();
    await edit();
    await click(action("Ungroup"));
    expect(client.getSnapshot().browserTabGroups!.groups).toEqual([]);
    expect(row(first)).toBeDefined();
    expect(row(second)).toBeDefined();
  });
  it("keeps collapsed tabs mentionable and attachable in the full strip order", async () => {
    await mountSaved();
    const places = placeList(client.getSnapshot());
    const web = places.filter((place) => place.kind === "browser");
    const first = web[0]!;
    const later = web.find((place) => place.browser?.sessionId !== first.browser?.sessionId)!;
    await act(async () => {
      await client.groupBrowserTabs(groupIds(first, later), { title: "Mention me" });
    });
    await settle();
    await click(header());
    expect(document.querySelector(`.side-tab[data-place-key="${first.key}"]`)).toBeNull();
    const expected = browserTabStrip(
      placeList(client.getSnapshot()),
      client.getSnapshot().browserTabGroups,
    )
      .ordered.filter((place) => place.availability !== "unavailable")
      .map((place) => place.title);
    const field = element<HTMLTextAreaElement>("[data-composer-input]");
    await write(field, "@");
    expect(
      [...document.querySelectorAll(".mention-list .place-pick__title")].map(
        (node) => node.textContent,
      ),
    ).toEqual(expected);
    const option = [
      ...document.querySelectorAll<HTMLButtonElement>(".mention-list .place-pick"),
    ].find((node) => node.querySelector(".place-pick__title")?.textContent === first.title)!;
    await click(option);
    await settle(100);
    expect(element(".context-chip__title").textContent).toBe(first.title);
    await click(element('.composer__attach[aria-label="Attach"]'));
    expect(
      [...document.querySelectorAll(".popover--attach .place-pick__title")].map(
        (node) => node.textContent,
      ),
    ).toEqual(expected);
  });
  it("keeps group order and the target's last member during optimistic joins", async () => {
    await mountSaved();
    const tabs = placeList(client.getSnapshot())
      .filter((place) => place.kind === "browser")
      .slice(0, 3);
    for (const [index, place] of tabs.entries())
      await act(async () => {
        await client.groupBrowserTabs(groupIds(place), { title: `Group ${index}` });
      });
    const before = client.getSnapshot().browserTabGroups!;
    let reject: (error: Error) => void = () => undefined;
    Object.defineProperty(client.rpc, "commands.dispatch", {
      configurable: true,
      value: vi.fn().mockImplementationOnce(
        () =>
          new Promise((_resolve, fail) => {
            reject = fail;
          }),
      ),
    });
    let pending: Promise<unknown> = Promise.resolve();
    await act(async () => {
      pending = client
        .groupBrowserTabs(groupIds(tabs[1]!), { groupId: before.groups[1]!.id })
        .catch(() => undefined);
    });
    try {
      expect(client.getSnapshot().browserTabGroups!.groups.map((group) => group.id)).toEqual(
        before.groups.map((group) => group.id),
      );
      expect(client.getSnapshot().browserTabGroups!.groups[1]!.tabIds).toEqual(
        before.groups[1]!.tabIds,
      );
    } finally {
      await act(async () => {
        reject(new Error("offline"));
        await pending;
      });
    }
  });
  it("opens both tab submenus by hover and ArrowRight, closes with ArrowLeft, and dismisses on another row", async () => {
    await mountSaved();
    const place = placeList(client.getSnapshot()).find((place) => place.kind === "browser")!;
    await menu(place);
    for (const [label, name] of [
      ["Open this page in…", "Open this page in"],
      ["Add to group", "Add to group"],
    ]) {
      const trigger = action(label!);
      await act(async () =>
        trigger.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowRight" }),
        ),
      );
      await settle();
      const submenu = element(`[role="menu"][aria-label="${name}"]`);
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      await act(async () =>
        element("button", submenu).dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowLeft" }),
        ),
      );
      await settle();
      expect(document.querySelector(`[role="menu"][aria-label="${name}"]`)).toBeNull();
      expect(document.activeElement).toBe(trigger);
      await act(async () =>
        trigger.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })),
      );
      await settle();
      expect(document.querySelector(`[role="menu"][aria-label="${name}"]`)).not.toBeNull();
      await act(async () =>
        action("Reload").dispatchEvent(new PointerEvent("pointerover", { bubbles: true })),
      );
      await settle();
      expect(document.querySelector(`[role="menu"][aria-label="${name}"]`)).toBeNull();
    }
  });
  it("native tab commands follow the visible strip", async () => {
    let receive: ((command: DesktopWorkspaceTabCommand) => void) | null = null;
    vi.stubGlobal("opensteerDesktop", {
      getLocalVisibility: async () => true,
      onLocalVisibilityChanged: () => () => undefined,
      setBadgeCount: vi.fn(async () => undefined),
      onWorkspaceTabCommand: (listener: typeof receive) => {
        receive = listener;
        return () => {
          receive = null;
        };
      },
    });
    await mountSaved();
    const tabs = placeList(client.getSnapshot()).filter((place) => place.kind === "browser");
    await create(tabs[0]!);
    await click(row(tabs[0]!));
    await click(header());
    const order = tabOrder(placeList(client.getSnapshot()), client.getSnapshot().browserTabGroups);
    expect(receive).not.toBeNull();
    await act(async () => receive?.({ type: "select-tab", index: 1 }));
    await settle();
    expect(element(".place").getAttribute("data-place-key")).toBe(order[0]!.key);
    await act(async () => receive?.({ type: "next-tab" }));
    await settle();
    expect(element(".place").getAttribute("data-place-key")).toBe(order[1]!.key);
    await act(async () => receive?.({ type: "previous-tab" }));
    await settle();
    expect(element(".place").getAttribute("data-place-key")).toBe(order[0]!.key);
  });
  it("replays pending changes over a newer agent revision and rolls back only the failing edit", async () => {
    await mountSaved();
    const place = placeList(client.getSnapshot()).find((place) => place.kind === "browser")!;
    await create(place);
    const original = client.rpc["commands.dispatch"];
    let reject: (error: Error) => void = () => undefined;
    Object.defineProperty(client.rpc, "commands.dispatch", {
      configurable: true,
      value: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((_resolve, fail) => {
              reject = fail;
            }),
        )
        .mockImplementation(original),
    });
    let failed: Promise<void> = Promise.resolve();
    await act(async () => {
      failed = client
        .updateBrowserTabGroup(group().id, { title: "Pending" })
        .catch(() => undefined);
    });
    expect(header().textContent).toContain("Pending");
    const held = client.getSnapshot().browserTabGroups!;
    await act(async () =>
      client.applyBrowserTabLayout({
        revision: held.revision + 10,
        groups: held.groups.map((group) => ({ ...group, title: "From agent", color: "cyan" })),
      }),
    );
    expect(header().textContent).toContain("Pending");
    await click(header());
    expect(header().getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      reject(new Error("offline"));
      await failed;
    });
    expect(header().textContent).toContain("From agent");
    expect(header().getAttribute("aria-expanded")).toBe("false");
    expect(group().color).toBe("cyan");
  });
  // Failure modes: hidden members inflate counts or are closed without appearing;
  // live-only tabs offer durable organization despite having no saved tab row.
  it("counts and closes only the group's sidebar members", async () => {
    await mountSaved();
    const first = placeList(client.getSnapshot()).find((place) => place.kind === "browser")!;
    const id = groupIds(first)[0]!;
    const hidden = BrowserSurfaceIdSchema.parse("surface_outside-bootstrap");
    await act(async () =>
      client.applyBrowserTabLayout({
        revision: 12,
        groups: [
          {
            id: createId("browserTabGroup"),
            title: "Visible",
            color: "blue",
            collapsed: true,
            tabIds: [BrowserSurfaceIdSchema.parse(id), hidden],
          },
        ],
      }),
    );
    expect(header().getAttribute("aria-label")).toBe("Visible, 1 tabs");
    expect(element(".side-tab-group__count").textContent).toBe("1");
    const close = vi.spyOn(client, "closeWorkspaceTabs");
    await edit();
    await click(action("Close group"));
    const confirmation = document.querySelector('[role="dialog"] .btn--danger');
    if (confirmation) await click(confirmation);
    expect(close).toHaveBeenCalledExactlyOnceWith([id]);
  });
  it("hides organization controls for live-only browser tabs even when a layout exists", async () => {
    await mount((source) => {
      const snapshot = source.getSnapshot();
      const live = placeList(snapshot).find((place) => place.kind === "browser")!;
      vi.spyOn(source, "getSnapshot").mockReturnValue({
        ...snapshot,
        workspaceTabs: [],
        browserTabGroups: {
          revision: 1,
          groups: [
            {
              id: createId("browserTabGroup"),
              title: "Live only",
              color: "blue",
              collapsed: false,
              tabIds: groupIds(live).map((id) => BrowserSurfaceIdSchema.parse(id)),
            },
          ],
        },
      });
      return "/";
    });
    const live = placeList(client.getSnapshot()).find((place) => place.kind === "browser")!;
    expect(live.workspaceTab).toBeUndefined();
    expect(client.getSnapshot().browserTabGroups).toBeDefined();
    await menu(live);
    const labels = [...document.querySelectorAll('[role="menuitem"]')].map((item) =>
      item.textContent?.trim(),
    );
    expect(labels).not.toContain("Add to group");
    expect(labels).not.toContain("Remove from group");
  });
  it("closes exactly the group members and confirms when an agent uses them", async () => {
    await mountSaved();
    const tabs = placeList(client.getSnapshot()).filter((place) => place.kind === "browser");
    const first = tabs[0]!;
    const second = tabs[2]!;
    const getId = (place: PlaceItem) =>
      place.destination.kind === "browser" ? place.destination.tabId! : "";
    await act(async () => {
      await client.groupBrowserTabs([getId(first), getId(second)], { title: "Closing" });
    });
    await settle();
    const before = placeList(client.getSnapshot());
    const close = vi.spyOn(client, "closeWorkspaceTabs");
    await edit();
    await click(action("Close group"));
    const confirmation = document.querySelector('[role="dialog"] .btn--danger');
    if (confirmation) await click(confirmation);
    expect(close).toHaveBeenCalledExactlyOnceWith(groupIds(first, second));
    const after = placeList(client.getSnapshot());
    expect(after.map((place) => place.key)).toEqual(
      before
        .filter((place) => place.key !== first.key && place.key !== second.key)
        .map((place) => place.key),
    );
    expect(client.getSnapshot().browserTabGroups!.groups).toEqual([]);
  });
  function groupIds(...places: PlaceItem[]) {
    return places.map((place) =>
      place.destination.kind === "browser" ? place.destination.tabId! : "",
    );
  }
  it("renders a new group made by an agent across browser sessions while native places stay below the divider", async () => {
    await mountSaved();
    const places = placeList(client.getSnapshot());
    const first = places.find((place) => place.kind === "browser")!;
    const second = places.find(
      (place) => place.kind === "browser" && place.browser?.sessionId !== first.browser?.sessionId,
    )!;
    await act(async () =>
      client.applyBrowserTabLayout({
        revision: 12,
        groups: [
          {
            id: createId("browserTabGroup"),
            title: "Agent research",
            color: "green",
            collapsed: false,
            tabIds: groupIds(first, second).map((id) => BrowserSurfaceIdSchema.parse(id)),
          },
        ],
      }),
    );
    expect(header().textContent).toContain("Agent research");
    expect(document.querySelectorAll(".side-tab--grouped")).toHaveLength(2);
    expect(
      [...document.querySelectorAll<HTMLElement>(".side-tab[data-group='native']")].map(
        (row) => row.dataset.placeKey,
      ),
    ).toEqual(places.filter((place) => place.kind !== "browser").map((place) => place.key));
    expect(document.querySelector(".side-tab--grouped[data-group='native']")).toBeNull();
  });
  it("adopts agent layouts, ignores stale reads, rolls back failures, and hides groups for old Hosts", async () => {
    await mountSaved();
    const place = placeList(client.getSnapshot()).find((place) => place.kind === "browser")!;
    await create(place);
    const initial = client.getSnapshot().browserTabGroups!;
    const external = {
      revision: initial.revision + 10,
      groups: initial.groups.map((group) => ({
        ...group,
        title: "From agent",
        color: "cyan" as const,
      })),
    };
    await act(async () => client.applyBrowserTabLayout(external));
    expect(header().textContent).toContain("From agent");
    await act(async () => client.applyBrowserTabLayout(initial));
    expect(header().textContent).toContain("From agent");
    let reject: (error: Error) => void = () => undefined;
    Object.defineProperty(client.rpc, "commands.dispatch", {
      configurable: true,
      value: vi.fn().mockImplementationOnce(
        () =>
          new Promise((_resolve, fail) => {
            reject = fail;
          }),
      ),
    });
    await click(header());
    expect(header().getAttribute("aria-expanded")).toBe("false");
    await act(async () => reject(new Error("offline")));
    expect(header().getAttribute("aria-expanded")).toBe("true");
    expect(document.body.textContent).toContain("offline");
    await act(async () => client.applyBrowserTabLayout(undefined));
    expect(document.querySelector(".side-tab-group")).toBeNull();
    expect(row(place)).toBeDefined();
    await menu(place);
    expect(
      [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim()),
    ).not.toContain("Add to group");
  });
});

describe("task marks", () => {
  const flights = "thr_b21e07d4-9c3a-4f62-8e1d-73a5c0f4d912";
  const travel = "wsp_00000000-0000-4000-8000-000000000800";
  async function press(target: Element, key: string) {
    await act(async () =>
      target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })),
    );
    await settle();
  }
  async function picker() {
    await click(element(".conv-header__switcher"));
    await click(element('[data-action="change-icon"]'));
  }
  it.each(["chat", "thread"])("keeps Chat's identity through its %s URL", async (route) => {
    let search = "";
    await mount((source) => {
      search = `${tabSearch(pageTab(source))}&messageId=chat-message&focusRequest=chat-request`;
      return `${route === "chat" ? "/" : `/threads/${source.getSnapshot().homeThreadId}`}${search}`;
    });
    expect(history.at(-1)).toMatchObject({ path: "/", search });
    if (route === "thread") expect(history.at(-1)?.type).toBe("REPLACE");
    expect(element(".conv-header__name").textContent).toBe("Chat");
    expect(element(".conv-header .chat-orb")).toBeDefined();
    expect(document.querySelector(".conv-header .task-mark")).toBeNull();
    await click(element(".conv-header__switcher"));
    expect(document.querySelector('[data-action="change-icon"]')).toBeNull();
    expect(document.querySelector('[aria-label="Rename task"]')).toBeNull();
  });
  it("uses a specialist's identity and excludes edits for its home Thread", async () => {
    await mount((source) => {
      const read = source.getSnapshot;
      const cache = new WeakMap<HostSnapshot, HostSnapshot>();
      vi.spyOn(source, "getSnapshot").mockImplementation(() => {
        const snapshot = read();
        let held = cache.get(snapshot);
        if (!held) {
          held = {
            ...snapshot,
            workspaces: snapshot.workspaces.map((workspace) =>
              workspace.id === travel ? { ...workspace, homeThreadId: flights } : workspace,
            ),
          };
          cache.set(snapshot, held);
        }
        return held;
      });
      return `/threads/${flights}`;
    });
    expect(history.at(-1)?.path).toBe(`/threads/${flights}`);
    expect(element(".conv-header__name").textContent).toBe("Travel");
    expect(element(".conv-header__mark .workspace-orb").getAttribute("data-color")).toBe("blue");
    expect(document.querySelector(".conv-header__mark .task-mark")).toBeNull();
    await click(element(".conv-header__switcher"));
    expect(document.querySelector('[data-action="change-icon"]')).toBeNull();
    expect(document.querySelector('[aria-label="Rename task"]')).toBeNull();
    await press(element(".conv-header__switcher"), "Escape");
    await act(async () =>
      element(`.side-task[data-thread-id="${flights}"]`).dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      ),
    );
    expect(document.querySelector('[data-action="change-icon"]')).toBeNull();
  });
  it.each(["main", "specialist", "unknown"])(
    "attributes an assignment to its %s owner without changing its task mark",
    async (owner) => {
      let catalogResolved = owner !== "unknown";
      const released = vi.fn();
      let observed: MockInstance;
      await mount((source) => {
        observed = vi.spyOn(source, "observeThread").mockReturnValue(released);
        const read = source.getSnapshot;
        const cache = new WeakMap<HostSnapshot, HostSnapshot>();
        vi.spyOn(source, "getSnapshot").mockImplementation(() => {
          const snapshot = read();
          let held = cache.get(snapshot);
          if (!held) {
            const original = Object.values(snapshot.assignments)[0]!;
            const assignment = {
              ...original,
              ...(owner === "unknown"
                ? { status: "completed" as const, finishedAt: original.createdAt }
                : {}),
              workerThread: {
                ...original.workerThread,
                ...(owner === "main"
                  ? {}
                  : {
                      id: ThreadIdSchema.parse(flights),
                      workspaceId: WorkspaceIdSchema.parse(travel),
                      title: "Tokyo flights in May",
                      icon: "plane" as const,
                      color: "lime" as const,
                    }),
              },
            };
            held = {
              ...snapshot,
              assignments: { ...snapshot.assignments, [assignment.id]: assignment },
              threads: snapshot.threads.filter(
                (thread) => owner !== "unknown" || thread.id !== flights,
              ),
              workspaces: snapshot.workspaces.filter(
                (workspace) => catalogResolved || workspace.id !== travel,
              ),
              transcripts: Object.fromEntries(
                Object.entries(snapshot.transcripts).map(([id, entries]) => [
                  id,
                  entries.map((entry) =>
                    entry.kind === "assignment" && entry.assignment.id === assignment.id
                      ? { ...entry, assignment }
                      : entry,
                  ),
                ]),
              ),
            };
            cache.set(snapshot, held);
          }
          return held;
        });
        return "/";
      });
      // The line draws only the task's own mark; who does it is in its name and tooltip.
      const card = () => element(".task-line__open");
      expect(card().querySelector(".chat-orb, .workspace-orb")).toBeNull();
      if (owner === "unknown") {
        expect(card().textContent).not.toContain("Opensteer");
        expect(card().getAttribute("aria-label")).not.toContain("Opensteer");
        expect(card().getAttribute("title")).not.toContain("Opensteer");
        expect(observed!).toHaveBeenCalledWith(flights);
      } else {
        const name = owner === "main" ? "Opensteer" : "Travel";
        expect(card().getAttribute("title")).toContain(name);
        expect(card().getAttribute("aria-label")).toContain(name);
      }
      const mark = element(".task-line .task-mark").outerHTML;
      catalogResolved = true;
      await act(async () => {
        await client.dispatch({
          type: "workspace.color.set",
          workspaceId: travel,
          color: "purple",
          idempotencyKey: `card-owner-colour-${owner}`,
        });
      });
      await settle();
      expect(element(".task-line .task-mark").outerHTML).toBe(mark);
      expect(card().querySelector(".chat-orb, .workspace-orb")).toBeNull();
      if (owner !== "main") {
        expect(card().getAttribute("title")).toContain("Travel");
        expect(card().getAttribute("aria-label")).toContain("Travel");
      }
      if (owner === "unknown") expect(released).toHaveBeenCalled();
    },
  );
  it("shows a task's subject and separate working state in its row, header and search", async () => {
    await mount(`/threads/${flights}`);
    expect(
      element(`.side-task[data-thread-id="${flights}"] .task-mark`).getAttribute("data-icon"),
    ).toBe("plane");
    expect(
      element(`.side-task[data-thread-id="${flights}"] .task-state`).getAttribute("data-state"),
    ).toBe("working");
    expect(element(".conv-header .task-mark").getAttribute("data-icon")).toBe("plane");
    expect(element(".conv-header").textContent).toContain("Travel");
    // Working shows on the task's mark and is spoken with its name, never as a word beside it.
    expect(element(".conv-header__mark [data-state]").getAttribute("data-state")).toBe("working");
    expect(element(".conv-header__switcher").getAttribute("aria-label")).toContain("working");
    expect(element(".conv-header").textContent).not.toContain("Working");
    await click(element(".conv-header__switcher"));
    expect(
      element(`.switcher__row[aria-current="true"] .task-mark`).getAttribute("data-icon"),
    ).toBe("plane");
    expect(element(".task-mark").getAttribute("aria-hidden")).toBe("true");
  });
  it("updates every occupant in place on an icon-only edit, keeping the acting task hue", async () => {
    await mount(`/threads/${flights}`);
    const place = pageTab();
    await act(async () => client.actInPlace(flights, place.key));
    await settle();
    const occupants = () => [
      ...document.querySelectorAll(`.occupant-mark[data-thread-id="${flights}"]`),
    ];
    expect(occupants().length).toBeGreaterThan(0);
    expect(occupants().every((el) => el.querySelector('.task-mark[data-icon="plane"]'))).toBe(true);
    await act(async () => {
      await client.dispatch({
        type: "thread.icon.set",
        threadId: flights,
        icon: "hotel",
        idempotencyKey: "occupant-icon-edit",
      });
    });
    expect(occupants().every((el) => el.querySelector('.task-mark[data-icon="hotel"]'))).toBe(true);
    expect(occupants()[0]?.getAttribute("aria-label")).toContain("working");
    expect(occupants()[0]?.querySelector(".task-badge")).toBeNull();
  });
  it("makes overflow occupants keyboard reachable by task name", async () => {
    await mount("/");
    const place = pageTab();
    const ids = [
      ...new Set(
        client
          .getSnapshot()
          .runQueue.filter((run) => run.status === "running" || run.status === "waiting")
          .map((run) => run.threadId),
      ),
    ].slice(0, 4);
    expect(ids).toHaveLength(4);
    await act(async () => {
      for (const id of ids) client.actInPlace(id, place.key);
    });
    await settle();
    const more = element<HTMLButtonElement>(
      `.side-tab[data-place-key="${place.key}"] .occupant-marks__more`,
    );
    more.focus();
    await click(more);
    const menu = element('[role="menu"][aria-label^="Tasks at "]');
    const task = element<HTMLElement>('[role="menuitem"][data-thread-id]', menu);
    expect(task.getAttribute("aria-label")).toContain(place.title);
    const id = task.getAttribute("data-thread-id");
    await click(task);
    expect(history.at(-1)?.path).toBe(
      id === client.getSnapshot().homeThreadId ? "/" : `/threads/${id}`,
    );
  });
  it("opens Change icon from the sidebar context menu and returns keyboard focus to its row", async () => {
    await mount(`/threads/${flights}`);
    const row = element<HTMLElement>(`.side-task[data-thread-id="${flights}"] .side-task__main`);
    row.focus();
    await act(async () =>
      row.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "F10",
          shiftKey: true,
        }),
      ),
    );
    await click(element('[data-action="change-icon"]'));
    const options = document.querySelectorAll(".workspace-icon-picker__grid button");
    (options[0] as HTMLElement).focus();
    await press(options[0]!, "ArrowRight");
    expect(document.activeElement).toBe(options[1]);
    await press(options[1]!, "Escape");
    expect(document.activeElement).toBe(row);
  });
  it("edits from the header with keyboard search, locks Use default and restores focus", async () => {
    await mount(`/threads/${flights}`);
    const dispatch = vi.spyOn(client, "dispatch");
    const opener = element(".conv-header__switcher");
    await picker();
    expect(document.querySelector('[aria-label="Initials"]')).toBeNull();
    expect(document.querySelectorAll(".workspace-icon-picker__grid button")).toHaveLength(130);
    const search = element<HTMLInputElement>('[aria-label="Search icons"]');
    expect(document.activeElement).toBe(search);
    await typeInto(search, "hotel");
    await press(search, "Enter");
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.icon.set", threadId: flights, icon: "hotel" }),
    );
    expect(element(".conv-header .task-mark").getAttribute("data-icon")).toBe("hotel");
    expect(document.activeElement).toBe(opener);
    await picker();
    await click(element('[aria-label="Use default"]'));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.icon.set", icon: null }),
    );
    expect(element(".conv-header .task-mark").getAttribute("data-icon")).toBe("document");
    await picker();
    await press(element('[aria-label="Search icons"]'), "Escape");
    expect(document.activeElement).toBe(opener);
  });
  it("keeps a refused icon edit reviewable and restores its authoritative mark", async () => {
    await mount(`/threads/${flights}`);
    vi.spyOn(client, "dispatch").mockRejectedValueOnce(new Error("Icon refused"));
    await picker();
    await click(element('[aria-label="Hotel"]'));
    expect(document.body.textContent).toContain("Icon refused");
    expect(element(".conv-header .task-mark").getAttribute("data-icon")).toBe("plane");
  });
  it("changes a specialist's colour without repainting its tasks", async () => {
    await mount("/workspaces/wsp_00000000-0000-4000-8000-000000000800");
    const dispatch = vi.spyOn(client, "dispatch");
    await click(element(".workspace-icon-chooser"));
    expect(document.querySelectorAll('[aria-label="Colour"] button')).toHaveLength(7);
    await click(element('[aria-label="Purple"]'));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "workspace.color.set", color: "purple" }),
    );
    expect(element(".workspace-icon-chooser .workspace-orb").getAttribute("data-color")).toBe(
      "purple",
    );
    expect(
      element(`.side-task[data-thread-id="${flights}"] .task-mark`).getAttribute("data-color"),
    ).toBe("lime");
  });
  it("excludes Chat and hides task mark edits for an older Host", async () => {
    await mount("/");
    await click(element(".conv-header__switcher"));
    expect(document.querySelector('[data-action="change-icon"]')).toBeNull();
    act(() => root?.unmount());
    setRoot(null);
    client.dispose();
    document.body.replaceChildren();
    let last: HostSnapshot | null = null;
    let held: HostSnapshot | null = null;
    await mount(`/threads/${flights}`, {
      hostClient: (source) =>
        new Proxy(source, {
          get(target, name) {
            if (name === "getSnapshot")
              return () => {
                const current = target.getSnapshot();
                if (current !== last) {
                  last = current;
                  held = { ...current, taskMarksAvailable: false };
                }
                return held!;
              };
            const value = Reflect.get(target, name);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
    });
    await click(element(".conv-header__switcher"));
    expect(document.querySelector('[data-action="change-icon"]')).toBeNull();
  });
});
