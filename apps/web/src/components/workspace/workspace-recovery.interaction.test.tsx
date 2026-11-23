// @vitest-environment happy-dom
import { runPlaceDestination } from "@opensteer/client/host";
import { BrowserProfileIdSchema, type TabTarget } from "@opensteer/core";
import { act } from "react";
import { withTimeout } from "@opensteer/shared/withTimeout";

import { describe, expect, it, vi } from "vitest";
import type {
  DesktopPersonalTabCommand,
  DesktopWebLinkDelivery,
} from "@opensteer/protocol/desktop";

import {
  placeList,
  taskList,
  workerAssignment,
  type TranscriptFixtureSnapshot,
} from "@opensteer/client/host";

import { AppShell } from "../app-shell.js";

import {
  root,
  client,
  goTo,
  history,
  mount,
  element,
  click,
  placeParams,
  isMockPage,
  pageTab,
  tabSearch,
  deferred,
  write,
  typeInto,
  pressEnter,
  firstTaskId,
  setRoot,
  resetHistory,
  storedMessageRecords,
  until,
  microtasksDrained,
} from "./workspace.interaction.test-support.js";
import { composerText } from "../composer-editor.test-support.js";

/** The place the workspace shows now, as its address names it. */
const shownPlace = () => new URLSearchParams(history.at(-1)?.search ?? "").get("tab");
const chipTitles = () =>
  [...document.querySelectorAll(".context-chip__title")].map((chip) => chip.textContent);
/** Messages this page saved and has not yet seen answered. */
const savedSends = () =>
  storedMessageRecords().filter((raw) => raw.includes('"thread.sendMessage"'));
describe("the review's findings", () => {
  it("F4 the pill's Retry, not the task, asks the connection to recover", async () => {
    await mount((source) => {
      const thread = source
        .getSnapshot()
        .threads.find((entry) => entry.listed && entry.purpose === "task")!;
      const getConnection = source.connection.getSnapshot.bind(source.connection);
      const unreachable = new WeakMap<object, ReturnType<typeof getConnection>>();
      vi.spyOn(source.connection, "getSnapshot").mockImplementation(() => {
        const real = getConnection();
        let shown = unreachable.get(real);
        if (!shown) {
          shown = {
            ...real,
            phase: "recovering",
            showInterruption: true,
            trying: false,
            issue: { code: "connection", reason: "unreachable" },
          };
          unreachable.set(real, shown);
        }
        return shown;
      });
      return `/tasks/${thread.id}`;
    });
    const retry = vi.spyOn(client.connection, "retry");
    expect(element(".connection-pill__label").textContent).toMatch(/^Can't reach /u);
    expect(document.querySelector(".thread__connection")).toBeNull();
    await click(element(".connection-pill__action"));
    expect(retry).toHaveBeenCalledExactlyOnceWith();
  });
  it("1 · a send's late answer never resets, refollows or overwrites the next draft's places", async () => {
    await mount((source) => `/${tabSearch(pageTab(source))}`);
    const place = pageTab();
    const other = placeList(client.getSnapshot()).find(
      (item) => item.key !== place.key && isMockPage(item),
    )!;
    await until("The shown page never became the chip", () =>
      expect(chipTitles()).toEqual([place.title]),
    );
    const answer = deferred<void>();
    const real = client.dispatch.bind(client);
    const started = Promise.withResolvers<void>();
    vi.spyOn(client, "dispatch").mockImplementation(async (...args) => {
      if (args[0].type === "thread.sendMessage") {
        started.resolve();
        await answer.promise;
      }
      return real(...args);
    });
    await write(element<HTMLElement>("[data-composer-input]"), "First");
    await click(element(".composer__send"));
    await until("The first send never reached the Host", () => started.promise);
    // The person goes Back once the new task is on screen: its conversation, committed.
    await until("The new task never opened", () => {
      const path = history.at(-1)!.path;
      expect(path).toMatch(/^\/tasks\//u);
      const threadId = decodeURIComponent(path.slice("/tasks/".length));
      element(`.side-task[data-thread-id="${threadId}"] .side-task__main[aria-current="page"]`);
    });
    await act(async () => goTo!(-1));
    // The next draft is its own from the press: it follows the page, then freezes on typing.
    const field = await until("The next draft never followed the page", () => {
      expect(history.at(-1)!.path).toBe("/");
      expect(chipTitles()).toEqual([place.title]);
      return element<HTMLElement>("[data-composer-input]");
    });
    await write(field, "Second draft typed before acknowledgement");
    await click(element(`.side-tab[data-place-key="${other.key}"] .side-tab__main`));
    // A frozen draft's chips are its own state, so the render showing the other tab is final.
    await until("The other tab was never shown", () => expect(shownPlace()).toBe(other.key));
    expect(element(".context-chip__title").textContent).toBe(place.title);
    // Removed while the first send waits: a choice of the second draft's that sticks.
    await click(element(".context-chip__remove"));
    expect(savedSends()).toHaveLength(1);
    await act(async () => answer.resolve());
    // The outbox lets the saved message go only once it has handled the Host's answer.
    await until("The first send's answer was never handled", () =>
      expect(savedSends()).toEqual([]),
    );
    expect(history.at(-1)!.path).toBe("/");
    expect(composerText(element("[data-composer-input]"))).toBe(
      "Second draft typed before acknowledgement",
    );
    expect(document.querySelector(".context-chip")).toBeNull();
  });

  it("2 · an explicit pick still being read holds Send, can be cancelled, and never lands in a later draft", async () => {
    await mount((source) => {
      const snapshot = source.getSnapshot();
      const task = snapshot.threads.find((thread) => thread.listed && thread.purpose === "task")!;
      return `/tasks/${task.id}${tabSearch(pageTab(source))}`;
    });
    const place = pageTab();
    const viewer = client.tabViewer(place.key);
    if (viewer?.kind !== "page") throw new Error("The page was never shown");
    const candidate = await client.readBrowserContextCandidate(viewer.sessionId, place.key);
    const reading = deferred<typeof candidate>();
    vi.spyOn(client, "readBrowserContextCandidate").mockImplementationOnce(() => reading.promise);
    const field = element<HTMLElement>("[data-composer-input]");
    await write(field, "Compare these");
    await click(element('.composer__attach[aria-label="Attach"]'));
    await click(
      [...document.querySelectorAll<HTMLButtonElement>(".popover--attach .place-pick")].find(
        (button) => button.textContent?.includes(place.title),
      )!,
    );
    // Picked and still being read: it stands as a chip, and the message waits for it.
    await until("The pick never stood as a chip being read", () =>
      expect(element(".context-chip--pending").getAttribute("aria-busy")).toBe("true"),
    );
    expect(element<HTMLButtonElement>(".composer__send").disabled).toBe(true);
    await click(element(".context-chip__remove"));
    const dispatch = vi.spyOn(client, "dispatch");
    dispatch.mockImplementationOnce(async () => ({ type: "thread.sendMessage" }) as never);
    await click(element(".composer__send"));
    await until("Send never reached the Host", () => expect(dispatch).toHaveBeenCalled());
    const sent = dispatch.mock.calls[0]?.[0] as { content: readonly { type: string }[] };
    expect(sent.content.map((part) => part.type)).toEqual(["text"]);
    // The answer arrives for a draft that is gone; the empty reply takes nothing from it.
    await act(async () => reading.resolve(candidate));
    // The read's answer is handled by a promise chain with no timer: it has run by now.
    await microtasksDrained();
    expect(document.querySelector(".context-chip")).toBeNull();
  });

  it("3 · a delayed open from the start page keeps the conversation chosen meanwhile, and loses to a newer place choice", async () => {
    await mount((source) => {
      // A profile has its own computer; Guest with two to choose from would be asked which.
      const snapshot = source.getSnapshot();
      localStorage.setItem(
        `opensteer.browse-with.v1:${encodeURIComponent(snapshot.deploymentId!)}:${encodeURIComponent(snapshot.user!.id)}`,
        JSON.stringify({ kind: "profile", profileId: snapshot.browserProfiles[0]!.id }),
      );
      return "/";
    });
    const real = client.openTab;
    const gates = [deferred<void>(), deferred<void>()];
    let opens = 0;
    const open = vi.spyOn(client, "openTab").mockImplementation(async (target) => {
      await withTimeout(gates[opens++]!.promise, 2_000, {
        timeoutError: () => new Error("The start page's open was never released."),
      });
      return real(target);
    });
    await click(element('.side-section--tabs .side-head__action[aria-label="New tab"]'));
    expect(element(".place").className).toContain("place--launcher");
    await typeInto(element<HTMLInputElement>(".start-page__input"), "example.com");
    await pressEnter(element(".start-page__input"));
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "page", url: "https://example.com/" }),
      { typed: true },
    );
    // Choosing a conversation meanwhile keeps the start page in the middle until the tab is listed.
    const threadId = firstTaskId();
    await click(element(`.side-task[data-thread-id="${threadId}"] .side-task__main`));
    expect(history.at(-1)!.path).toBe(`/tasks/${threadId}`);
    expect(element(".place").className).toContain("place--launcher");
    await act(async () => gates[0]!.resolve());
    // The answer shows its tab in place of the start page and keeps the conversation now open.
    const opened = await act(async () => open.mock.results[0]!.value);
    await until("The opened tab never took the start page's place", () =>
      expect(shownPlace()).toBe(opened.tabId),
    );
    expect(history.at(-1)!.path).toBe(`/tasks/${threadId}`);
    // Asked again, then another place chosen before the answer: the choice stands.
    await click(element('.side-section--tabs .side-head__action[aria-label="New tab"]'));
    await typeInto(element<HTMLInputElement>(".start-page__input"), "example.org");
    await pressEnter(element(".start-page__input"));
    const chosen = placeList(client.getSnapshot()).find(
      (item) => item.kind === "page" && item.key !== opened.tabId,
    )!;
    await click(element(`.side-tab[data-place-key="${chosen.key}"] .side-tab__main`));
    const before = history.length;
    await act(async () => gates[1]!.resolve());
    // The late answer's tab is listed: that is when it would have taken the middle.
    const late = await act(async () => open.mock.results[1]!.value);
    await until("The late answer's tab was never listed", () =>
      element(`.side-tab[data-place-key="${late.tabId}"]`),
    );
    expect(history.length).toBe(before);
    expect(element(".place").getAttribute("data-place-key")).toBe(chosen.key);
    expect(history.at(-1)!.path).toBe(`/tasks/${threadId}`);
  });

  it("4 · Automations links keep the place in the middle", async () => {
    await mount((source) => `/automations${tabSearch(pageTab(source))}`);
    const sameMiddle = await until("The page never took the middle", () =>
      element(`.place[data-place-key="${pageTab().key}"]`),
    );
    await click(element(".automation-row"));
    expect(history.at(-1)!.path).toMatch(/^\/automations\/./u);
    expect(placeParams(history.at(-1)!.search)).toBe(placeParams(tabSearch(pageTab())));
    expect(element(".place")).toBe(sameMiddle);
    // And back to the list from the detail's own link.
    await click(element(".page__back"));
    expect(history.at(-1)!.path).toBe("/automations");
    expect(placeParams(history.at(-1)!.search)).toBe(placeParams(tabSearch(pageTab())));
  });

  it("5 · a phone's place offers Hide computer: one entry back to the conversation, draft kept", async () => {
    await mount(
      (source) => {
        const task = source
          .getSnapshot()
          .threads.find((thread) => thread.listed && thread.purpose === "task")!;
        return `/tasks/${task.id}${tabSearch(pageTab(source))}`;
      },
      { width: 390 },
    );
    const field = element<HTMLElement>("[data-composer-input]");
    await write(field, "Keep this");
    const before = history.length;
    await click(element('.thread__sheet-row [aria-label="Hide computer"]'));
    expect(history.length).toBe(before + 1);
    expect(new URLSearchParams(history.at(-1)!.search).has("panel")).toBe(false);
    expect(document.querySelector(".place")).toBeNull();
    expect(element("[data-composer-input]")).toBe(field);
    expect(composerText(field)).toBe("Keep this");
  });

  it("6 · putting the conversation away lets go of its viewfinder's picture", async () => {
    const leases = new Map<string, number>();
    await mount((source) => {
      const retain = source.retainBrowserWatch;
      vi.spyOn(source, "retainBrowserWatch").mockImplementation((sessionId, surfaceId) => {
        const key = `${sessionId}:${surfaceId}`;
        leases.set(key, (leases.get(key) ?? 0) + 1);
        const release = retain(sessionId, surfaceId);
        return () => {
          leases.set(key, (leases.get(key) ?? 0) - 1);
          release();
        };
      });
      // A working Run acting in a page, which its viewfinder pictures; another page in the middle.
      const run = source.getSnapshot().runQueue.find((candidate) => candidate.status === "running");
      const [acting, other] = placeList(source.getSnapshot()).filter((item) => isMockPage(item));
      source.actInPlace(run!.threadId, acting!.key);
      return `/tasks/${run!.threadId}${tabSearch(other!)}`;
    });
    // The viewfinder takes its lease in an effect after mount; under a loaded
    // suite that can outlast any fixed pause, so each step waits for the lease
    // count it expects — exactly that count, never a looser one.
    const leaseBecomes = (key: () => string, count: number) =>
      until(`The viewfinder's lease never became ${count}`, () =>
        expect(leases.get(key())).toBe(count),
      );
    let viewfinderKey = "";
    await leaseBecomes(() => {
      // The viewfinder names its tab; its picture is leased through the session it is shown in.
      const tabId = element<HTMLButtonElement>(".viewfinder").dataset.placeKey!;
      const viewer = client.tabViewer(tabId);
      viewfinderKey = viewer?.kind === "page" ? `${viewer.sessionId}:${tabId}` : "";
      return viewfinderKey;
    }, 1);
    // The docked head holds no controls of its own; the computer's bar puts the
    // conversation away and brings it back from the same spot.
    expect(document.querySelector(".conv-header__actions")).toBeNull();
    await click(element(".place .chat-toggle"));
    await leaseBecomes(() => viewfinderKey, 0);
    expect(document.querySelector(".place .chat-toggle")).toBeNull();
    await click(element(".place .chat-btn"));
    await leaseBecomes(() => viewfinderKey, 1);
    expect(element(".place .chat-toggle").getAttribute("aria-expanded")).toBe("true");
  });

  it("7 · the phone browser's menu offers Fit when the page is another size", async () => {
    const rect = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      return this.closest(".browser-stage")
        ? ({
            bottom: 640,
            height: 640,
            left: 0,
            right: 390,
            top: 0,
            width: 390,
            x: 0,
            y: 0,
          } as DOMRect)
        : rect.call(this);
    });
    await mount((source) => `/${tabSearch(pageTab(source))}`, { width: 390 });
    await click(
      await until("The browser's options were never offered", () =>
        element('.place [aria-label="Browser options"]'),
      ),
    );
    // The open menu follows the page: Fit appears once the page's size is known.
    await until("Fit was never offered for a page of another size", () =>
      expect(
        [...document.querySelectorAll(".popover [role=menuitem]")].map((item) =>
          item.textContent?.trim(),
        ),
      ).toEqual(expect.arrayContaining(["Back", "Forward", "Reload", "Fit page to view"])),
    );
  });

  it("8 · ⌘K below the drawer breakpoint opens the drawer with Search focused", async () => {
    await mount("/", { width: 820 });
    element<HTMLElement>("[data-composer-input]").focus();
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "k", metaKey: true }),
      );
    });
    const sidebar = element<HTMLElement>("#app-sidebar");
    await until("⌘K never opened the drawer with Search focused", () => {
      expect(sidebar.className).toContain("sidebar--open");
      expect(sidebar.inert).toBe(false);
      expect(document.activeElement?.id).toBe("sidebar-search");
    });
  });

  it("9 · closing a focused tab hands focus to its neighbour, a tab work holds included", async () => {
    await mount("/");
    for (const used of [false, true]) {
      const place = placeList(client.getSnapshot()).find(
        (item) => item.occupants.length > 0 === used,
      )!;
      const close = element<HTMLButtonElement>(
        `.side-tab[data-place-key="${place.key}"] .side-tab__close`,
      );
      close.focus();
      await click(close);
      // No question first: a closed tab comes back with Reopen closed tab.
      await until("The closed tab never handed focus to its neighbour", () => {
        expect(close.isConnected).toBe(false);
        expect(document.activeElement).not.toBe(document.body);
        expect(document.activeElement?.closest(".side-tab, .side-new, .side-head")).not.toBeNull();
      });
      expect(document.querySelector(".dialog")).toBeNull();
    }
  });

  it("10 · the count's exact request is focused once its panel can render, behind another one or late", async () => {
    // Behind: the task's own request is first; the counted one waits below it.
    await mount((source) => {
      const waiting = source.getSnapshot().waitingRequests[0]!;
      return {
        pathname: `/tasks/${waiting.request.originatingThreadId}`,
        state: { focusRequest: waiting.request.id },
      };
    });
    const target = await until("The counted request was never focused", () => {
      const focused = document.activeElement?.closest("[data-request-id]") ?? null;
      expect(focused).not.toBeNull();
      return focused;
    });
    expect(target?.closest(".request-card")).not.toBeNull();
    const focusedId = target?.getAttribute("data-request-id");
    expect(
      client.getSnapshot().waitingRequests.some(({ request }) => request.id === focusedId),
    ).toBe(true);
    act(() => root?.unmount());
    setRoot(null);
    client.dispose();
    resetHistory();
    document.body.replaceChildren();
    // Late: the conversation opens before the request's body has loaded.
    let hidden: { readonly threadId: string; readonly requestId: string } | null = null;
    const listeners = new Set<() => void>();
    await mount((source) => {
      const snapshot = source.getSnapshot();
      const [threadId, requests] = Object.entries(snapshot.requests).find(([, list]) =>
        list.some(
          (request) => request.status === "pending" && request.presentation.kind === "choice",
        ),
      )!;
      const request = requests.find(
        (item) => item.status === "pending" && item.presentation.kind === "choice",
      )!;
      hidden = { requestId: request.id, threadId };
      // Held back from the snapshot, one stable copy per real one, until it "loads".
      const subscribe = source.subscribe;
      vi.spyOn(source, "subscribe").mockImplementation((listener) => {
        listeners.add(listener);
        const off = subscribe(listener);
        return () => {
          listeners.delete(listener);
          off();
        };
      });
      const real = source.getSnapshot;
      let copy: {
        readonly from: TranscriptFixtureSnapshot;
        readonly to: TranscriptFixtureSnapshot;
      } | null = null;
      vi.spyOn(source, "getSnapshot").mockImplementation(() => {
        const base = real();
        if (hidden === null) return base;
        const { requestId } = hidden;
        if (copy?.from !== base)
          copy = {
            from: base,
            to: {
              ...base,
              requests: {
                ...base.requests,
                [threadId]: (base.requests[threadId] ?? []).filter((item) => item.id !== requestId),
              },
            },
          };
        return copy.to;
      });
      return { pathname: `/tasks/${threadId}`, state: { focusRequest: request.id } };
    });
    // The conversation is open, with its composer; the asked-for request has not loaded.
    await until("The conversation never opened", () => element(".thread [data-composer-input]"));
    expect(document.activeElement?.closest("[data-request-id]")).toBeNull();
    const { requestId } = hidden!;
    hidden = null;
    await act(async () => {
      for (const listener of listeners) listener();
    });
    await until("The late request was never focused once it loaded", () =>
      expect(
        document.activeElement?.closest("[data-request-id]")?.getAttribute("data-request-id"),
      ).toBe(requestId),
    );
  });

  it("11 · a place-only choice keeps the conversation's message anchor", async () => {
    let anchor = "";
    await mount((source) => {
      const snapshot = source.getSnapshot();
      // A message the task holds: one it no longer holds says so and leaves the address.
      const [task, message] = snapshot.threads.flatMap((thread) => {
        const held = (snapshot.transcripts[thread.id] ?? []).find(
          (entry) => entry.kind === "message" && entry.published !== false && !entry.streaming,
        );
        return thread.listed && thread.purpose === "task" && held ? [[thread, held] as const] : [];
      })[0]!;
      anchor = message.id;
      return `/tasks/${task.id}?messageId=${anchor}`;
    });
    const place = pageTab();
    await click(element(`.side-tab[data-place-key="${place.key}"] .side-tab__main`));
    expect(new URLSearchParams(history.at(-1)!.search).get("messageId")).toBe(anchor);
    expect(placeParams(history.at(-1)!.search)).toBe(placeParams(tabSearch(place)));
    // Changing conversation leaves it behind.
    await click(element('[aria-label="New task"]'));
    expect(new URLSearchParams(history.at(-1)!.search).has("messageId")).toBe(false);
  });
});

describe("stopping a task and finishing it: one Stop", () => {
  const menuRow = (label: string) =>
    [
      ...document.querySelectorAll<HTMLButtonElement>(".conversation-menu__actions .picker__row"),
    ].find((node) => node.querySelector(".picker__label")?.textContent === label) ?? null;
  async function openMenu() {
    await click(element(".conv-header__menu"));
    await until("The conversation menu never opened", () => element(".conversation-menu__actions"));
  }
  const thread = (id: string) => client.getSnapshot().threads.find((item) => item.id === id)!;
  const sidebarRow = (id: string) =>
    document.querySelector<HTMLElement>(`.sidebar .side-task[data-thread-id="${id}"]`);
  const button = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent === name || node.getAttribute("aria-label") === name,
    ) ?? null;
  /** A task the person starts themselves, from New task, still running. */
  async function startOwnTask(text: string): Promise<string> {
    // Paced so its scripted run is still working while the person acts on it.
    await mount("/", { latencyMs: 3_000 });
    await write(element<HTMLElement>("[data-composer-input]"), text);
    await click(element(".composer__send"));
    await until("The new task never opened", () =>
      expect(history.at(-1)!.path).toMatch(/^\/tasks\//u),
    );
    const threadId = decodeURIComponent(history.at(-1)!.path.replace("/tasks/", ""));
    expect(workerAssignment(client.getSnapshot().assignments, threadId)).toBeNull();
    expect(thread(threadId).status).toBe("running");
    return threadId;
  }

  it("confirms shared Done on running work, moves on, and keeps the composer to reopen it", async () => {
    const own = await startOwnTask("Compare two coworking passes");
    const setDone = vi.spyOn(client, "setTaskDone");
    await openMenu();
    await click(menuRow("Mark Done")!);
    expect(element('[role="dialog"]').textContent).toContain("Stop and mark Done?");
    expect(element('[role="dialog"]').textContent).toContain(
      "This stops its work and the tasks it handed out, and pauses its schedules.",
    );
    expect(setDone).not.toHaveBeenCalled();
    await click(element('[role="dialog"] .btn--danger'));
    await until("Done never moved the task on", () => {
      expect(thread(own).doneAt).not.toBeNull();
      expect(sidebarRow(own)).toBeNull();
      expect(history.at(-1)!.path).not.toBe(`/tasks/${own}`);
    });
    expect(setDone).toHaveBeenCalledExactlyOnceWith(own, true);
    await act(async () => goTo!(-1));
    await until("The done task's composer never said how to reopen it", () =>
      expect(element(".input-surface__done").textContent).toBe("Done · Sending reopens it"),
    );
    expect(document.querySelector("[data-composer-input]")).not.toBeNull();
    await openMenu();
    await click(menuRow("Reopen")!);
    await until("Reopen never reopened the task", () => {
      expect(thread(own).doneAt).toBeNull();
      expect(document.querySelector(".input-surface__done")).toBeNull();
    });
  });

  it("dismisses Stop when its run ends and never turns that review into a different action", async () => {
    const own = await startOwnTask("Review a short proposal");
    await openMenu();
    await click(menuRow("Stop task…")!);
    expect(element(".conversation-menu__confirm").textContent).toContain("Its run stops now");
    // Another client ends the run while this client is still reading the question.
    await act(async () => client.stopRun(own));
    await until("The ended run never dismissed Stop", () =>
      expect(document.querySelector(".conversation-menu__confirm")).toBeNull(),
    );
    expect(document.querySelector(".conversation-menu__actions")).not.toBeNull();
    expect(menuRow("Mark Done")).not.toBeNull();
    expect(document.querySelector(".shell-error, .toast--error")).toBeNull();
  });

  it("a task stopped from its composer's square moves to Done, never resuming its paused input", async () => {
    const own = await startOwnTask("Price check standing desks");
    await click(button("Stop the run")!);
    await until("Stop never paused the task's input", () =>
      expect(thread(own).inputQueuePaused).toBe(true),
    );
    const resume = vi.spyOn(client, "resumeThreadInputQueue");
    await openMenu();
    await click(menuRow("Mark Done")!);
    await until("Mark Done never finished the task", () => {
      expect(thread(own).doneAt).not.toBeNull();
      expect(thread(own).inputQueuePaused).toBe(false);
    });
    expect(resume).not.toHaveBeenCalled();
  });

  it("delegated work no task list holds offers Mark Done from its title menu", async () => {
    const parent = await startOwnTask("Plan a team offsite");
    const source = thread(parent);
    let worker = "";
    await act(async () => {
      worker = (
        await client.createThread({
          accessMode: source.accessMode,
          environmentId: source.environmentId,
          harnessInstanceId: source.harnessInstanceId,
          modelSelection: source.modelSelection,
          parentThreadId: parent,
          title: "Shortlist venues",
        })
      ).id;
    });
    expect(thread(worker).listed).toBe(false);
    await act(async () => goTo!(`/tasks/${worker}`));
    await until("The delegated task never opened", () => {
      expect(history.at(-1)!.path).toBe(`/tasks/${worker}`);
      element(".conv-header__menu");
    });
    await openMenu();
    await click(menuRow("Mark Done")!);
    await until("Mark Done never finished the delegated task", () =>
      expect(thread(worker).doneAt).not.toBeNull(),
    );
    await openMenu();
    expect(menuRow("Reopen")).not.toBeNull();
  });

  it("work still under way offers Mark Done", async () => {
    await mount("/");
    const list = taskList(client.getSnapshot());
    const underWay = list.working.filter(
      (row) => row.tone === "waiting" || row.tone === "needs-you",
    );
    expect(underWay.length).toBeGreaterThan(0);
    for (const row of underWay) expect(row.stopped).toBe(false);
    await until("Work under way was never offered Mark Done", () => {
      for (const row of underWay)
        expect(sidebarRow(row.threadId)?.querySelector(".side-row-action")).not.toBeNull();
    });
  });
});

describe("a person's own view of an app on this Mac, in the desktop app", () => {
  const deploymentId = "dep_00000000-0000-4000-8000-000000000001";
  const desktopDeployment = {
    access: "owner",
    activeOrigin: "http://127.0.0.1:4310",
    canonicalOrigin: "http://127.0.0.1:4310",
    id: deploymentId,
    kind: "personal",
    lastUsedAt: null,
    name: "Mac mini",
    onThisComputer: true,
    routes: [],
  } as unknown as NonNullable<Parameters<typeof AppShell>[0]["desktopDeployment"]>;
  const deploymentAccess = {
    // As main's snapshot always carries them: signed in, this Mac's Opensteer in the account.
    account: { available: true, status: "signed-in" },
    personalAccountLink: { status: "linked" },
    deployments: [],
    selectedDeploymentId: deploymentId,
    personalSetup: {
      deploymentId,
      environmentId: "env_00000000-0000-4000-8000-000000000001",
      state: "ready",
    },
  } as unknown as NonNullable<Parameters<typeof AppShell>[0]["deploymentAccess"]>;

  it("offers Use on this Mac beside View only for this Mac's app alone, with the exact view and app", async () => {
    const useComputerViewOnThisMac = vi.fn(async () => ({ activated: true as const }));
    const desktopBridge = {
      setBadgeCount: vi.fn(async () => undefined),
      useComputerViewOnThisMac,
    } as unknown as NonNullable<Parameters<typeof AppShell>[0]["desktopBridge"]>;
    await mount("/?panel=browser", {
      shell: { deploymentAccess, desktopBridge, desktopDeployment },
    });
    expect(
      document.querySelector(".web-tab-notice"),
      "the Mac app's Start page called itself a web browser",
    ).toBeNull();
    await click(element(".start-tile[aria-label^='Notes on']"));
    await until("Notes was never shown as an owner view", () =>
      expect(element(".owner-view__view-only").textContent).toBe("View only"),
    );
    const notesKey = element(".place").getAttribute("data-place-key");
    const use = element<HTMLButtonElement>(".owner-view__use");
    expect(use.textContent).toBe("Use on this Mac");
    await click(use);
    const view = client
      .getSnapshot()
      .machines.flatMap((machine) => machine.computerUse?.ownerViews ?? [])
      .find((candidate) => candidate.state === "ready")!;
    expect(useComputerViewOnThisMac).toHaveBeenCalledWith({
      viewId: view.viewId,
      generation: view.generation,
      deploymentId,
      machineId: "rnr_11111111-1111-4111-8111-111111111111",
      app: expect.objectContaining({ bundleId: "com.apple.Notes" }),
    });
    // Another Mac's app is never brought forward from here.
    await click(element('.side-section--tabs .side-head__action[aria-label="New tab"]'));
    await click(element(".start-tile[aria-label^='Keynote on Studio']"));
    await until("Keynote was never shown as an owner view", () => {
      expect(element(".place").getAttribute("data-place-key")).not.toBe(notesKey);
      expect(element(".owner-view__view-only").textContent).toBe("View only");
    });
    expect(document.querySelector(".owner-view__use")).toBeNull();
  });

  it("never offers it without the desktop's bridge, whatever the computer", async () => {
    await mount("/?panel=browser", { shell: { deploymentAccess, desktopDeployment } });
    expect(element(".web-tab-notice").textContent).toContain("You’re in a web browser");
    await click(element(".start-tile[aria-label^='Notes on']"));
    await until("Notes was never shown as an owner view", () =>
      expect(element(".owner-view__view-only").textContent).toBe("View only"),
    );
    expect(document.querySelector(".owner-view__use")).toBeNull();
  });
});

describe("a desktop that is its own computer in another Mac's Opensteer", () => {
  it("opens Guest from a reply's web link, New tab, Open this page in and another app's link on this Mac, not on the hosting Mac", async () => {
    const deploymentId = "dep_00000000-0000-4000-8000-000000000001";
    const studio = "rnr_88888888-8888-4888-8888-888888888888";
    const status = {
      available: true,
      computerName: "Studio Mac",
      deploymentId,
      mayRunAgents: false,
      platform: "macos",
      runAgents: false,
      runner: {
        detail: "Running.",
        enrolled: true,
        environmentId: null,
        runnerId: studio,
        state: "running",
      },
      schemaVersion: 4,
    };
    const statusAnswered = deferred<void>();
    let deliver: ((command: DesktopPersonalTabCommand) => void) | null = null;
    const deliveries: DesktopWebLinkDelivery[] = [];
    const desktopBridge = {
      setBadgeCount: vi.fn(async () => undefined),
      getLocalExecutionStatus: vi.fn(async () => {
        await statusAnswered.promise;
        return status;
      }),
      onLocalExecutionStatusChanged: () => () => undefined,
      bindDeviceSession: vi.fn(async () => "already-bound" as const),
      onPersonalTabCommand: (listener: typeof deliver) => {
        deliver = listener;
        return () => {
          deliver = null;
        };
      },
      webLinkDelivery: vi.fn(async (input: DesktopWebLinkDelivery) => {
        deliveries.push(input);
        if (!input.bind) return null;
        const { id, ...request } = input.bind;
        return {
          ...webLink,
          id,
          request: { deploymentId: input.deploymentId, userId: input.userId, ...request },
        };
      }),
    } as unknown as NonNullable<Parameters<typeof AppShell>[0]["desktopBridge"]>;
    const webLink = {
      type: "open-web-url",
      id: "ffb4fd5c-8840-45ce-9497-42f387acb291",
      url: "https://example.net/",
    } as const;
    const desktopDeployment = {
      access: "owner",
      activeOrigin: "https://mac-mini.example",
      canonicalOrigin: "https://mac-mini.example",
      id: deploymentId,
      kind: "personal",
      lastUsedAt: null,
      name: "Mac mini",
      onThisComputer: false,
      routes: [],
    } as unknown as NonNullable<Parameters<typeof AppShell>[0]["desktopDeployment"]>;
    // Every page this window opens, whether by tab.open from a link or by openTab.
    const open = vi.fn<(target: TabTarget) => void>();
    await mount(
      (source) => {
        const snapshot = source.getSnapshot();
        localStorage.setItem(
          `opensteer.browse-with.v1:${encodeURIComponent(snapshot.deploymentId!)}:${encodeURIComponent(snapshot.user!.id)}`,
          '{"kind":"guest"}',
        );
        const openTab = source.openTab;
        vi.spyOn(source, "openTab").mockImplementation((target) => {
          open(target);
          return openTab(target);
        });
        const dispatch = source.dispatch.bind(source);
        vi.spyOn(source, "dispatch").mockImplementation((command) => {
          if (command.type === "tab.open") open(command.target as TabTarget);
          return dispatch(command);
        });
        return "/tasks/thr_00000000-0000-4000-8000-000000000002";
      },
      { shell: { desktopBridge, desktopDeployment } },
    );
    // Until this Mac says whether it is a computer here, no link from another app is taken to bind.
    await until("The app never asked whether this Mac is a computer here", () => {
      expect(desktopBridge.getLocalExecutionStatus).toHaveBeenCalled();
      element(".md-prose a");
    });
    expect(deliver).toBeNull();
    await act(async () => statusAnswered.resolve());
    await until("The answer never let links from other apps in", () =>
      expect(deliver).not.toBeNull(),
    );
    const here = (url: unknown) => ({ kind: "page", url, guest: true, computerId: studio });
    const link = [...document.querySelectorAll<HTMLAnchorElement>(".md-prose a")].find(
      (anchor) => anchor.textContent === "storage mount guide",
    )!;
    await click(link);
    expect(open).toHaveBeenLastCalledWith(here("https://storage.example/docs/mounts"));
    await click(element('.side-section--tabs .side-head__action[aria-label="New tab"]'));
    await typeInto(element<HTMLInputElement>(".start-page__input"), "example.com");
    await pressEnter(element(".start-page__input"));
    expect(open).toHaveBeenLastCalledWith(here("https://example.com/"));
    // A profile tab's menu: Open this page in… ▸ Guest.
    const profileTab = placeList(client.getSnapshot()).find(
      (place) => place.kind === "page" && place.identity?.kind === "profile",
    )!;
    await act(async () =>
      element(`.side-tab[data-place-key="${profileTab.key}"]`).dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 40,
          clientY: 300,
        }),
      ),
    );
    const openIn = await until("The tab's menu never offered Open this page in", () => {
      const item = [...document.querySelectorAll<HTMLElement>(".popover [role=menuitem]")].find(
        (node) => node.querySelector(".picker__label")?.textContent === "Open this page in…",
      );
      expect(item).toBeDefined();
      return item!;
    });
    await act(async () => openIn.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })));
    const guest = await until("Open this page in never offered Guest", () => {
      const item = [
        ...element('[role="menu"][aria-label="Open this page in"]').querySelectorAll<HTMLElement>(
          "button",
        ),
      ].find((node) => node.querySelector(".picker__label")?.textContent === "Guest");
      expect(item).toBeDefined();
      return item!;
    });
    const opened = open.mock.calls.length;
    await click(guest);
    await vi.waitFor(() => expect(open, "Open in never opened").toHaveBeenCalledTimes(opened + 1), {
      timeout: 1_000,
    });
    expect(open).toHaveBeenLastCalledWith(here(expect.any(String)));
    // A link clicked in another app, with Opensteer as the Mac's default browser.
    await vi.waitFor(() => expect(deliver, "The link receiver never subscribed").not.toBeNull(), {
      timeout: 1_000,
    });
    await act(async () => deliver!({ ...webLink, generation: deliveries[0]!.generation }));
    await vi.waitFor(() => expect(open).toHaveBeenLastCalledWith(here(webLink.url)), {
      timeout: 1_000,
    });
  });
});

describe("the v7 web review's findings", () => {
  async function openTile(label: string) {
    if (!document.querySelector(".start-page")) {
      await click(element('.side-section--tabs .side-head__action[aria-label="New tab"]'));
    }
    await click(element(`.start-tile[aria-label^='${label}']`));
    await until(`${label} never took the middle`, () => {
      expect(document.querySelector(".start-page")).toBeNull();
      element(".place .owner-view");
    });
  }

  it("M2 · the person's own view of the phone a task holds leaves the task's viewfinder on its own session", async () => {
    const threadId = "thr_00000000-0000-4000-8000-000000000903";
    await mount(`/tasks/${threadId}`);
    await until("The task's viewfinder never showed its phone", () =>
      element(".viewfinder .place-canvas"),
    );
    const runId = client.getSnapshot().runQueue.find((run) => run.threadId === threadId)!.id;
    const before = client.runPlace(runId)!;
    const destination = runPlaceDestination(before, client.getSnapshot());
    expect(client.getSnapshot().tabs.get(before.data.tabId)?.kind).toBe("phone");
    expect(document.querySelector(".viewfinder .place-canvas")).not.toBeNull();
    await openTile("Pixel 7");
    expect(element(".owner-view")).toBeTruthy();
    const phones = placeList(client.getSnapshot()).filter((item) => item.kind === "phone");
    // One phone is one tab: the person's own view is in front of the task still using it.
    expect(phones).toHaveLength(1);
    expect(phones[0]!.destination).toEqual(destination);
    expect(phones[0]!.occupants.map((occupant) => occupant.threadId)).toContain(threadId);
    expect(runPlaceDestination(client.runPlace(runId)!, client.getSnapshot())).toEqual(destination);
    // The phone is in the middle now, so the conversation's viewfinder steps aside for it.
    expect(document.querySelector(".viewfinder .computer-watch")).toBeNull();
  });

  it("a phone's tab stays live through its task's end until the person closes it", async () => {
    const threadId = "thr_00000000-0000-4000-8000-000000000903";
    await mount(`/tasks/${threadId}`);
    await until("The task's viewfinder never showed its phone", () =>
      element(".viewfinder .place-canvas"),
    );
    const phone = () => placeList(client.getSnapshot()).find((place) => place.kind === "phone");
    const held = phone()!;
    const session = client
      .getSnapshot()
      .machines.find((machine) => machine.id === held.device.machineId)
      ?.computerUse?.sessions.find((candidate) => candidate.display)!;
    const activate = vi.spyOn(client, "activateTab");
    await act(async () => goTo!({ pathname: "/", search: `?panel=browser&tab=${held.key}` }));
    await until("The phone's own view never took the middle", () => element(".place .owner-view"));
    expect(activate).toHaveBeenCalledExactlyOnceWith(held.key, { wake: true });
    const address = history.at(-1);
    const shown = client.tabViewer(held.key);

    await act(async () => {
      await client.dispatch({
        idempotencyKey: "stop-held-session",
        sessionId: session.sessionId,
        type: "integration.computer.session.stop",
      });
    });
    // The client has seen the agent's session end: that is when it could have moved the tab.
    await until("The agent's session never ended", () =>
      expect(
        client
          .getSnapshot()
          .machines.flatMap((machine) => machine.computerUse?.sessions ?? [])
          .some((candidate) => candidate.sessionId === session.sessionId),
      ).toBe(false),
    );
    // The agent stopping is not an event for the tab: same address, and the person's view stays.
    expect(history.at(-1)).toEqual(address);
    expect(client.tabViewer(held.key)?.kind).toBe(shown?.kind);
    expect(element(".place .owner-view")).toBeTruthy();

    const activations = activate.mock.calls.length;
    await act(async () => client.closeTabs([held.key]));
    // The middle moves on to the tab beside it; the closed phone is never opened again.
    await until("The middle never moved on from the closed phone", () => {
      expect(phone()).toBeUndefined();
      expect(history.at(-1)?.search).not.toBe(address?.search);
    });
    expect(activate.mock.calls.slice(activations).map(([id]) => id)).not.toContain(held.key);
  });

  it("M6 · clearing recent sites never fails an owner view the Host is opening", async () => {
    await mount("/?panel=browser");
    // Cleared while the Host opens the view, before its answer is read.
    const activateTab = client.activateTab;
    const activating = vi.spyOn(client, "activateTab").mockImplementation(async (tabId) => {
      const opening = activateTab(tabId);
      await client.browserHistory.clear("bpr_00000000-0000-4000-8000-000000000001");
      return opening;
    });
    await click(element(".start-tile[aria-label^='Calendar on']"));
    await until("Calendar's own view never took the middle", () => {
      expect(element(".owner-view").getAttribute("aria-label")).toContain("Calendar");
      expect(new URLSearchParams(history.at(-1)!.search).has("tab")).toBe(true);
      expect(activating).toHaveBeenCalled();
    });
    // The Host's answer has been read, by the time any failure would have been shown.
    await act(async () => {
      await Promise.allSettled(activating.mock.results.map((result) => result.value));
    });
    await microtasksDrained();
    expect(document.querySelector(".toast--error")).toBeNull();
  });

  it("m1 · typed navigation reaches Host history and its retained icon appears in New tab", async () => {
    const profileId = "bpr_00000000-0000-4000-8000-000000000001";
    await mount((source) => {
      const reading = placeList(source.getSnapshot()).find(
        (item) => item.kind === "page" && item.title === "Your reading list",
      )!;
      return `/${tabSearch(reading)}`;
    });
    await typeInto(
      element<HTMLInputElement>(".browser-address input"),
      "example.com/some/path?q=1",
    );
    await pressEnter(element(".browser-address input"));
    await until("The typed visit never reached Host history with its icon", async () =>
      expect(await client.rpc["browser.history.get"]({ profileId })).toMatchObject({
        ok: true,
        data: {
          entries: [{ url: "https://example.com/some/path?q=1", typedCount: 1, visitCount: 1 }],
          icons: [{ origin: "https://example.com" }],
        },
      }),
    );
    const readIcons = client.browserHistory.ports.icons.bind(client.browserHistory.ports);
    const raster = deferred<Awaited<ReturnType<typeof readIcons>>>();
    vi.spyOn(client.browserHistory.ports, "icons").mockReturnValueOnce(raster.promise);
    await click(element('.side-section--tabs .side-head__action[aria-label="New tab"]'));
    const mark = await until("New tab never showed the typed site", () =>
      element('.start-tile[title="example.com"] .site-mark'),
    );
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(32);
    expect(mark.querySelector("svg")).not.toBeNull();
    expect(mark.textContent).toBe("");
    expect(mark.querySelector("img")).toBeNull();
    const ref = client.browserHistory.iconRef(profileId, "https://example.com")!;
    await act(async () => raster.resolve(await readIcons(profileId, [ref])));
    expect(
      element<HTMLImageElement>('.start-tile[title="example.com"] .site-mark img').getAttribute(
        "src",
      ),
    ).toMatch(/^data:image\/png;base64,/u);
  });

  it("m2 · Clear browsing history and a profile pick leave the keyboard in the search field", async () => {
    const personal = {
      kind: "profile" as const,
      profileId: BrowserProfileIdSchema.parse("bpr_00000000-0000-4000-8000-000000000001"),
    };
    await mount("/?panel=browser");
    await act(async () => {
      await client.openTab({
        kind: "page",
        url: "https://example.com/",
        profileId: personal.profileId,
      });
      await client.browserHistory.load(personal.profileId);
    });
    if (!document.querySelector(".start-page"))
      await click(element('.side-section--tabs .side-head__action[aria-label="New tab"]'));
    const field = element<HTMLInputElement>(".start-page__input");
    const pill = element<HTMLButtonElement>(".start-page__pill");
    // Escape still returns to what opened the menu.
    await click(pill);
    expect(document.querySelector(".popover--profiles")).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    });
    await until("Escape never returned the keyboard to the pill", () =>
      expect(document.activeElement).toBe(pill),
    );
    await click(pill);
    const row = [...document.querySelectorAll<HTMLElement>(".popover--profiles .picker__row")].find(
      (node) => node.querySelector(".picker__label")?.textContent === "Personal",
    )!;
    await click(row);
    expect(document.activeElement).toBe(field);
    const tile = element<HTMLButtonElement>("section[aria-label^='Recent sites'] .start-tile");
    await act(async () => {
      tile.focus();
      tile.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    const clear = await until("The tile's menu never offered Clear browsing history", () => {
      const item = [...document.querySelectorAll<HTMLElement>(".popover [role=menuitem]")].find(
        (node) => node.textContent?.includes("Clear browsing history"),
      );
      expect(item).toBeDefined();
      return item!;
    });
    await click(clear);
    await until("Clearing never removed Recent sites and kept the keyboard in search", () => {
      expect(document.querySelector("section[aria-label^='Recent sites']")).toBeNull();
      expect(document.activeElement).toBe(field);
    });
  });
});

describe("a computer that can't show its apps, on the start page", () => {
  const machine = (name: string) =>
    client.getSnapshot().machines.find((candidate) => candidate.name === name)!;
  const captions = (scope = ".start-page__apps") =>
    [...document.querySelectorAll(`${scope} .start-apps__caption`)].map((node) => node.textContent);
  async function openStartPage() {
    await mount("/?panel=browser");
    if (!document.querySelector(".start-page"))
      await click(element('.side-section--tabs .side-head__action[aria-label="New tab"]'));
  }
  async function setStatus(name: string, status: "online" | "offline" | "update-pending") {
    await act(async () => client.setMachineStatus(machine(name).id, status));
    await until(`The start page never showed ${name} ${status}`, () =>
      expect(captions(".start-apps__away").includes(name)).toBe(status !== "online"),
    );
  }
  /** A computer's readiness changes; the start page folds it once it is drawn so. */
  async function needsOwner(name: string) {
    await act(async () => client.setComputerUseReadiness(machine(name).id, "permission-required"));
    await until(`The start page never folded ${name}`, () =>
      expect(captions(".start-apps__away")).toContain(name),
    );
  }

  it("an offline computer folds into one quiet line after the rest; its apps are found but never opened, and unfold in their own place when it's back", async () => {
    await openStartPage();
    const asked = vi.spyOn(client, "openTab");
    expect(captions()).toEqual(["Mac mini", "Studio Mac", "Phone", "Phone"]);

    await setStatus("Studio Mac", "offline");
    expect(captions()).toEqual(["Mac mini", "Phone", "Phone", "Studio Mac"]);
    expect(captions(".start-apps__away")).toEqual(["Studio Mac"]);
    expect(document.querySelector(".start-tile[aria-label^='Keynote on Studio']")).toBeNull();
    const line = element<HTMLElement>(".start-apps__away .start-apps__row");
    expect(element(".start-apps__status", line).textContent).toBe("Offline");
    // Nothing to do there but wait, so nothing on it is offered.
    expect(line.matches("button, a, [tabindex], [data-start-tile]")).toBe(false);
    expect(line.querySelector("button, a, [tabindex], [data-start-tile]")).toBeNull();

    // Typing still finds Keynote and says why where Enter's action would be; the keyboard passes
    // over it to the search, and choosing it asks nothing.
    const field = element<HTMLInputElement>(".start-page__input");
    // Home's composer has the keyboard; the person clicks into the search.
    await act(async () => field.focus());
    await typeInto(field, "keynote");
    const keynote = [...document.querySelectorAll<HTMLElement>(".start-result")].find(
      (row) => row.querySelector(".start-result__title")?.textContent === "Keynote",
    )!;
    expect(keynote.classList.contains("is-unavailable")).toBe(true);
    expect(element(".start-result__action", keynote).textContent).toBe("Offline");
    const active = () => element(".start-result.is-active .start-result__title").textContent;
    expect(active()).toBe("keynote");
    for (const key of ["ArrowDown", "ArrowUp"])
      await act(async () => {
        field.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
      });
    expect(active()).toBe("keynote");
    await click(keynote);
    expect(asked).not.toHaveBeenCalled();
    expect(document.querySelector(".start-page__refusal")).toBeNull();

    // A phone that goes is named, since its tile no longer is.
    await click(element(".start-page__clear"));
    await setStatus("Pixel 7", "offline");
    expect(captions()).toEqual(["Mac mini", "Phone", "Studio Mac", "Pixel 7"]);

    await setStatus("Studio Mac", "online");
    await setStatus("Pixel 7", "online");
    expect(captions()).toEqual(["Mac mini", "Studio Mac", "Phone", "Phone"]);
    expect(document.querySelector(".start-apps__away")).toBeNull();
    await click(element(".start-tile[aria-label^='Keynote on Studio']"));
    await until("Keynote's own view never took the middle", () =>
      expect(element(".owner-view").getAttribute("aria-label")).toContain("Keynote"),
    );
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("a computer waiting on its owner folds into a line that opens its page, where the steps are", async () => {
    await openStartPage();
    const mini = machine("Mac mini");
    await needsOwner("Mac mini");
    expect(captions()).toEqual(["Studio Mac", "Phone", "Phone", "Mac mini"]);
    const line = element<HTMLButtonElement>(".start-apps__away button.start-apps__row");
    expect(element(".start-apps__status", line).textContent).toBe("Needs permission");
    expect(line.getAttribute("aria-label")).toBe("Mac mini, Needs permission");
    expect(line.title).toBe("Allow Screen Recording on Mac mini to see its apps.");
    // The arrows reach it like any tile.
    expect(line.dataset.startTile).toBe("");

    await setStatus("Pixel 7", "update-pending");
    expect(
      element(".start-apps__away button.start-apps__row:last-child .start-apps__status")
        .textContent,
    ).toBe("Needs update");

    await click(line);
    expect(history.at(-1)!.path).toBe(`/settings/devices/${encodeURIComponent(mini.id)}`);
  });

  it("typed, an app whose computer waits on its owner says so, the keyboard reaches it, and Enter opens the computer's page", async () => {
    await openStartPage();
    const mini = machine("Mac mini");
    await needsOwner("Mac mini");
    const field = element<HTMLInputElement>(".start-page__input");
    await act(async () => field.focus());
    await typeInto(field, "notes");
    // The keyboard reaches the app, past the open Notes window's own row.
    const activeTitle = () =>
      element(".start-result.is-active .start-result__title").textContent ?? "";
    for (let step = 0; step < 3 && activeTitle() !== "Notes"; step++)
      await act(async () => {
        field.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
      });
    const notes = element<HTMLElement>(".start-result.is-active");
    expect(notes.querySelector(".start-result__title")?.textContent).toBe("Notes");
    expect(element(".start-result__action", notes).textContent).toBe("Needs permission");
    expect(notes.getAttribute("aria-disabled")).toBeNull();
    await pressEnter(field);
    expect(history.at(-1)!.path).toBe(`/settings/devices/${encodeURIComponent(mini.id)}`);
  });

  it("a line that stops needing its owner and is only away hands the keyboard to the search field", async () => {
    await openStartPage();
    await needsOwner("Mac mini");
    const line = element<HTMLButtonElement>(".start-apps__away button.start-apps__row");
    await act(async () => line.focus());
    expect(document.activeElement).toBe(line);
    await setStatus("Mac mini", "offline");
    expect(element(".start-apps__away .start-apps__status").textContent).toBe("Offline");
    expect(document.activeElement).toBe(element(".start-page__input"));
  });

  it("a row that folds under the keyboard hands it to the search field; a row that stays keeps it", async () => {
    await openStartPage();
    const keynote = element<HTMLButtonElement>(".start-tile[aria-label^='Keynote on Studio']");
    await act(async () => keynote.focus());
    expect(document.activeElement).toBe(keynote);
    await setStatus("Studio Mac", "offline");
    expect(keynote.isConnected).toBe(false);
    expect(document.activeElement).toBe(element(".start-page__input"));

    const pixel = element<HTMLButtonElement>(".start-tile[aria-label^='Pixel 7']");
    await act(async () => pixel.focus());
    await setStatus("Studio Mac", "online");
    expect(document.activeElement).toBe(pixel);
  });
});
