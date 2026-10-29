// @vitest-environment happy-dom
import { act } from "react";

import { describe, expect, it, vi } from "vitest";

import {
  HostClientRequestError,
  placeList,
  taskList,
  workerAssignment,
  type HostSnapshot,
} from "@opensteer/client/host";
import { BrowserSurfaceIdSchema } from "@opensteer/core";
import { staleBrowserTabInventoryReason } from "@opensteer/protocol";

import { AppShell } from "../app-shell.js";

import {
  root,
  client,
  goTo,
  history,
  mount,
  settle,
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
} from "./workspace.interaction.test-support.js";
describe("the review's findings", () => {
  it("F4 connection Retry explicitly retries the refused realtime channel", async () => {
    await mount((source) => {
      const getSnapshot = source.getSnapshot.bind(source);
      const thread = getSnapshot().threads.find(
        (entry) => entry.listed && entry.id !== getSnapshot().homeThreadId,
      )!;
      const cache = new WeakMap<HostSnapshot, HostSnapshot>();
      vi.spyOn(source, "getSnapshot").mockImplementation(() => {
        const snapshot = getSnapshot();
        let offline = cache.get(snapshot);
        if (!offline) {
          offline = { ...snapshot, connection: "offline" };
          cache.set(snapshot, offline);
        }
        return offline;
      });
      return `/threads/${thread.id}`;
    });
    const refresh = vi.spyOn(client, "refresh").mockResolvedValue();
    expect(element(".thread__connection-label").textContent).toBe("Unavailable");
    await click(element(".thread__connection button"));
    expect(refresh).toHaveBeenCalledExactlyOnceWith({ retryConnection: true });
  });
  it("1 · a send's late answer never resets, refollows or overwrites the next draft's places", async () => {
    await mount((source) => `/${tabSearch(pageTab(source))}`);
    const place = pageTab();
    const other = placeList(client.getSnapshot()).find(
      (item) => item.kind === "browser" && item.key !== place.key && isMockPage(item),
    )!;
    await settle(100);
    const answer = deferred<unknown>();
    vi.spyOn(client, "dispatch").mockImplementationOnce(
      async () => (await answer.promise) as never,
    );
    const field = element<HTMLTextAreaElement>("[data-composer-input]");
    await write(field, "First");
    await click(element(".composer__send"));
    await settle(100);
    // The next draft is its own from the press: it follows the page, then freezes on typing.
    expect(element(".context-chip__title").textContent).toBe(place.title);
    await write(field, "Second draft typed before acknowledgement");
    await click(element(`.side-tab[data-place-key="${other.key}"] .side-tab__main`));
    await settle(100);
    expect(element(".context-chip__title").textContent).toBe(place.title);
    // Removed while the first send waits: a choice of the second draft's that sticks.
    await click(element(".context-chip__remove"));
    await act(async () => answer.resolve({ type: "thread.sendMessage" }));
    await settle(150);
    expect(field.value).toBe("Second draft typed before acknowledgement");
    expect(document.querySelector(".context-chip")).toBeNull();
  });

  it("2 · an explicit pick still being read holds Send, can be cancelled, and never lands in a later draft", async () => {
    await mount((source) => {
      const snapshot = source.getSnapshot();
      const task = snapshot.threads.find(
        (thread) => thread.listed && thread.id !== snapshot.homeThreadId,
      )!;
      return `/threads/${task.id}${tabSearch(pageTab(source))}`;
    });
    const place = pageTab();
    if (place.destination.kind !== "browser" || !place.destination.tabId) throw new Error("tab");
    const candidate = await client.readBrowserContextCandidate(
      place.destination.sessionId,
      place.destination.tabId,
    );
    const reading = deferred<typeof candidate>();
    vi.spyOn(client, "readBrowserContextCandidate").mockImplementationOnce(() => reading.promise);
    const field = element<HTMLTextAreaElement>("[data-composer-input]");
    await write(field, "Compare these");
    await click(element('.composer__attach[aria-label="Attach"]'));
    await click(
      [...document.querySelectorAll<HTMLButtonElement>(".popover--attach .place-pick")].find(
        (button) => button.textContent?.includes(place.title),
      )!,
    );
    await settle(50);
    // Picked and still being read: it stands as a chip, and the message waits for it.
    expect(element(".context-chip--pending").getAttribute("aria-busy")).toBe("true");
    expect(element<HTMLButtonElement>(".composer__send").disabled).toBe(true);
    await click(element(".context-chip__remove"));
    const dispatch = vi.spyOn(client, "dispatch");
    dispatch.mockImplementationOnce(async () => ({ type: "thread.sendMessage" }) as never);
    await click(element(".composer__send"));
    await settle(50);
    const sent = dispatch.mock.calls[0]?.[0] as { content: readonly { type: string }[] };
    expect(sent.content.map((part) => part.type)).toEqual(["text"]);
    // The answer arrives for a draft that is gone; the empty reply takes nothing from it.
    await act(async () => reading.resolve(candidate));
    await settle(100);
    expect(document.querySelector(".context-chip")).toBeNull();
  });

  it("3 · a delayed open from the start page keeps the conversation chosen meanwhile, and loses to a newer place choice", async () => {
    await mount("/");
    const target = placeList(client.getSnapshot()).find((item) => item.kind === "browser")!;
    if (target.destination.kind !== "browser" || !target.destination.tabId)
      throw new Error("Not a browser tab");
    const { sessionId, tabId } = target.destination;
    const opened = deferred<{ readonly sessionId: string; readonly tabId: string }>();
    const open = vi.spyOn(client, "openBrowserTab");
    open.mockImplementationOnce(() => opened.promise as never);
    await click(element('.side-section--tabs .side-head__action[aria-label="New tab"]'));
    expect(element(".place").className).toContain("place--launcher");
    expect(open).not.toHaveBeenCalled();
    await typeInto(element<HTMLInputElement>(".start-page__input"), "example.com");
    await pressEnter(element(".start-page__input"));
    expect(open).toHaveBeenCalledWith(
      { identity: { kind: "guest" } },
      expect.objectContaining({ url: "https://example.com/" }),
    );
    // Choosing a conversation meanwhile keeps the start page as it was.
    const threadId = firstTaskId();
    await click(element(`.side-task[data-thread-id="${threadId}"] .side-task__main`));
    expect(history.at(-1)!.path).toBe(`/threads/${threadId}`);
    expect(element<HTMLInputElement>(".start-page__input").value).toBe("example.com");
    await act(async () => opened.resolve({ sessionId, tabId }));
    await settle(50);
    // The answer shows its tab in place of the start page and keeps the conversation now open.
    expect(history.at(-1)!.path).toBe(`/threads/${threadId}`);
    expect(new URLSearchParams(history.at(-1)!.search).get("browserTab")).toBe(tabId);
    // Asked again, then another place chosen before the answer: the choice stands.
    const late = deferred<{ readonly sessionId: string; readonly tabId: string }>();
    open.mockImplementationOnce(() => late.promise as never);
    await click(element('.side-section--tabs .side-head__action[aria-label="New tab"]'));
    await typeInto(element<HTMLInputElement>(".start-page__input"), "example.org");
    await pressEnter(element(".start-page__input"));
    const chosen = placeList(client.getSnapshot()).find(
      (item) => item.kind === "browser" && item.key !== target.key,
    )!;
    await click(element(`.side-tab[data-place-key="${chosen.key}"] .side-tab__main`));
    const before = history.length;
    await act(async () => late.resolve({ sessionId, tabId }));
    await settle(50);
    expect(history.length).toBe(before);
    expect(element(".place").getAttribute("data-place-key")).toBe(chosen.key);
    expect(history.at(-1)!.path).toBe(`/threads/${threadId}`);
  });

  it("4 · Specialists and Automations links keep the place in the middle", async () => {
    await mount((source) => `/specialists${tabSearch(pageTab(source))}`);
    const place = pageTab();
    const middle = element(".place");
    await click(element(".specialist-card"));
    expect(history.at(-1)!.path).toMatch(/^\/workspaces\//u);
    expect(placeParams(history.at(-1)!.search)).toBe(placeParams(tabSearch(place)));
    expect(element(".place")).toBe(middle);
    act(() => root?.unmount());
    setRoot(null);
    client.dispose();
    resetHistory();
    document.body.replaceChildren();
    await mount((source) => `/automations${tabSearch(pageTab(source))}`);
    await settle(200);
    const sameMiddle = element(".place");
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
    await mount((source) => `/${tabSearch(pageTab(source))}`, { width: 390 });
    const field = element<HTMLTextAreaElement>("[data-composer-input]");
    await write(field, "Keep this");
    const before = history.length;
    await click(element('.thread__sheet-row [aria-label="Hide computer"]'));
    expect(history.length).toBe(before + 1);
    expect(new URLSearchParams(history.at(-1)!.search).has("panel")).toBe(false);
    expect(document.querySelector(".place")).toBeNull();
    expect(element("[data-composer-input]")).toBe(field);
    expect(field.value).toBe("Keep this");
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
      const latest = source.latestPlaceOfThread(source.getSnapshot().homeThreadId!);
      const other = placeList(source.getSnapshot()).find(
        (item) => item.kind === "browser" && item.key !== latest?.placeKey,
      )!;
      return `/${tabSearch(other)}`;
    });
    // The viewfinder takes its lease in an effect after mount; under a loaded
    // suite that can outlast any fixed pause, so each step waits for the lease
    // count it expects — exactly that count, never a looser one.
    const leaseBecomes = (key: () => string, count: number) =>
      vi.waitFor(
        async () => {
          await settle(10);
          expect(leases.get(key())).toBe(count);
        },
        { interval: 0, timeout: 5_000 },
      );
    let viewfinderKey = "";
    await leaseBecomes(() => {
      const [, sessionId, tabId] =
        element<HTMLButtonElement>(".viewfinder").dataset.placeKey!.split(":");
      viewfinderKey = `${sessionId}:${tabId}`;
      return viewfinderKey;
    }, 1);
    await click(element('.conv-header [aria-label="Close conversation"]'));
    await leaseBecomes(() => viewfinderKey, 0);
    await click(element(".chat-btn"));
    await leaseBecomes(() => viewfinderKey, 1);
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
    await settle(300);
    await click(element('.place [aria-label="Browser options"]'));
    expect(
      [...document.querySelectorAll(".popover [role=menuitem]")].map((item) =>
        item.textContent?.trim(),
      ),
    ).toEqual(expect.arrayContaining(["Back", "Forward", "Reload", "Fit page to view"]));
  });

  it("8 · ⌘K below the drawer breakpoint opens the drawer with Search focused", async () => {
    await mount("/", { width: 820 });
    element<HTMLTextAreaElement>("[data-composer-input]").focus();
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "k", metaKey: true }),
      );
    });
    await settle(50);
    const sidebar = element<HTMLElement>("#app-sidebar");
    expect(sidebar.className).toContain("sidebar--open");
    expect(sidebar.inert).toBe(false);
    expect(document.activeElement?.id).toBe("sidebar-search");
  });

  it("9 · closing a focused tab hands focus to its neighbour, with or without the question first", async () => {
    await mount("/");
    const attached = (place: ReturnType<typeof placeList>[number]) =>
      place.destination.kind === "browser"
        ? (client
            .getSnapshot()
            .browserSessions.find(
              (session) =>
                place.destination.kind === "browser" && session.id === place.destination.sessionId,
            )?.attachedRunIds.length ?? 0)
        : 0;
    const quiet = placeList(client.getSnapshot()).find(
      (place) => place.closable && attached(place) === 0,
    )!;
    const close = element<HTMLButtonElement>(
      `.side-tab[data-place-key="${quiet.key}"] .side-tab__close`,
    );
    close.focus();
    await click(close);
    await settle(150);
    expect(close.isConnected).toBe(false);
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.closest(".side-tab, .side-new, .side-head")).not.toBeNull();
    // Held by live work: asked first, then the same rescue.
    const held = placeList(client.getSnapshot()).find(
      (place) => place.closable && attached(place) > 0,
    )!;
    const heldClose = element<HTMLButtonElement>(
      `.side-tab[data-place-key="${held.key}"] .side-tab__close`,
    );
    heldClose.focus();
    await click(heldClose);
    await click(element(".dialog .btn--danger"));
    await settle(150);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("10 · the count's exact request is focused once its panel can render, behind another one or late", async () => {
    // Behind: Opensteer's own request is first; the counted one waits below it.
    await mount((source) => {
      const snapshot = source.getSnapshot();
      const waiting = snapshot.waitingRequests.find(({ assignments }) =>
        assignments.some(({ parentThreadId }) => parentThreadId === snapshot.homeThreadId),
      )!;
      return { pathname: "/", state: { focusRequest: waiting.request.id } };
    });
    await settle(100);
    const target = (history.at(-1) && document.activeElement?.closest("[data-request-id]")) ?? null;
    expect(target).not.toBeNull();
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
      const [threadId, requests] = Object.entries(snapshot.requests).find(
        ([id, list]) =>
          id !== snapshot.homeThreadId &&
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
      let copy: { readonly from: HostSnapshot; readonly to: HostSnapshot } | null = null;
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
      return { pathname: `/threads/${threadId}`, state: { focusRequest: request.id } };
    });
    await settle(100);
    expect(document.activeElement?.closest("[data-request-id]")).toBeNull();
    const { requestId } = hidden!;
    hidden = null;
    await act(async () => {
      for (const listener of listeners) listener();
    });
    await settle(100);
    expect(
      document.activeElement?.closest("[data-request-id]")?.getAttribute("data-request-id"),
    ).toBe(requestId);
  });

  it("11 · a place-only choice keeps the conversation's message anchor", async () => {
    await mount((source) => {
      const snapshot = source.getSnapshot();
      const task = snapshot.threads.find(
        (thread) => thread.listed && thread.id !== snapshot.homeThreadId,
      )!;
      return `/threads/${task.id}?messageId=msg_anchor`;
    });
    const place = pageTab();
    await click(element(`.side-tab[data-place-key="${place.key}"] .side-tab__main`));
    expect(new URLSearchParams(history.at(-1)!.search).get("messageId")).toBe("msg_anchor");
    expect(placeParams(history.at(-1)!.search)).toBe(placeParams(tabSearch(place)));
    // Changing conversation leaves it behind.
    await click(element(".side-home__main"));
    expect(new URLSearchParams(history.at(-1)!.search).has("messageId")).toBe(false);
  });
});

describe("stopping a task and finishing it: one Stop", () => {
  const menuRow = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>(".switcher__actions .picker__row")].find(
      (node) => node.querySelector(".picker__label")?.textContent === label,
    ) ?? null;
  async function openMenu() {
    await click(element(".conv-header__switcher"));
    await settle(40);
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
    await mount("/new", { latencyMs: 3_000 });
    await write(element<HTMLTextAreaElement>("[data-composer-input]"), text);
    await click(element(".composer__send"));
    for (let tries = 0; tries < 40 && !history.at(-1)!.path.startsWith("/threads/"); tries += 1)
      await settle(50);
    const threadId = decodeURIComponent(history.at(-1)!.path.replace("/threads/", ""));
    expect(workerAssignment(client.getSnapshot().assignments, threadId)).toBeNull();
    expect(thread(threadId).status).toBe("running");
    return threadId;
  }

  it("Chat offers no Done action", async () => {
    await mount("/");
    await openMenu();
    expect(menuRow("Mark Done")).toBeNull();
    expect(menuRow("Reopen")).toBeNull();
  });

  it("confirms shared Done on running work, freezes sending and reopens the composer", async () => {
    const own = await startOwnTask("Compare two coworking passes");
    const setDone = vi.spyOn(client, "setTaskDone");
    await openMenu();
    await click(menuRow("Mark Done")!);
    expect(element(".switcher__confirm").textContent).toContain("Stop and mark Done?");
    expect(element(".switcher__confirm").textContent).toContain(
      "This stops its work and the tasks it handed out, and pauses its schedules.",
    );
    expect(setDone).not.toHaveBeenCalled();
    await click(element(".switcher__confirm .btn--danger"));
    await settle(100);
    expect(setDone).toHaveBeenCalledExactlyOnceWith(own, true);
    expect(thread(own).doneAt).not.toBeNull();
    expect(sidebarRow(own)).toBeNull();
    expect(document.body.textContent).toContain("This task is Done");
    expect(document.querySelector("[data-composer-input]")).toBeNull();
    expect(document.querySelector(".composer__send")).toBeNull();
    await expect(
      client.dispatch({
        type: "thread.sendMessage",
        threadId: own,
        content: [{ type: "text", text: "Do more" }],
        idempotencyKey: "done-refuses-message",
      }),
    ).rejects.toThrow("This task is Done. Reopen it first.");
    await click(button("Reopen")!);
    await settle(100);
    expect(thread(own).doneAt).toBeNull();
    expect(document.querySelector("[data-composer-input]")).not.toBeNull();
    expect(sidebarRow(own)).not.toBeNull();
  });

  it("dismisses Stop when its run ends and never turns that review into a different action", async () => {
    const own = await startOwnTask("Review a short proposal");
    await openMenu();
    await click(menuRow("Stop task…")!);
    expect(element(".switcher__confirm").textContent).toContain("Its run stops now");
    // Another client ends the run while this client is still reading the question.
    await act(async () => client.stopRun(own));
    await settle(100);
    expect(document.querySelector(".switcher__confirm")).toBeNull();
    expect(document.querySelector(".switcher__search")).not.toBeNull();
    expect(menuRow("Mark Done")).not.toBeNull();
    expect(document.querySelector(".shell-error, .toast--error")).toBeNull();
  });

  it("a task stopped from its composer's square moves to Done from its row, still paused", async () => {
    const own = await startOwnTask("Price check standing desks");
    expect(sidebarRow(own)?.querySelector(".side-row-action")).not.toBeNull();
    await click(button("Stop the run")!);
    await settle(100);
    expect(thread(own).inputQueuePaused).toBe(true);
    const resume = vi.spyOn(client, "resumeThreadInputQueue");
    const action = element<HTMLButtonElement>(".side-row-action", sidebarRow(own)!);
    expect(action.getAttribute("aria-label")).toBe(`Mark Done: ${thread(own).title}`);
    await click(action);
    await settle(100);
    expect(sidebarRow(own)).toBeNull();
    expect(resume).not.toHaveBeenCalled();
    expect(thread(own).inputQueuePaused).toBe(false);
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
          workspaceId: source.workspaceId,
        })
      ).id;
    });
    expect(thread(worker).listed).toBe(false);
    await act(async () => goTo!(`/threads/${worker}`));
    await settle(100);
    await openMenu();
    await click(menuRow("Mark Done")!);
    await settle(100);
    expect(thread(worker).doneAt).not.toBeNull();
    await openMenu();
    expect(menuRow("Reopen")).not.toBeNull();
  });

  it("work still under way offers Mark Done", async () => {
    await mount("/");
    await settle(100);
    const list = taskList(client.getSnapshot());
    const underWay = list.working.filter(
      (row) => row.tone === "waiting" || row.tone === "needs-you",
    );
    expect(underWay.length).toBeGreaterThan(0);
    for (const row of underWay) {
      expect(row.stopped).toBe(false);
      expect(sidebarRow(row.threadId)?.querySelector(".side-row-action")).not.toBeNull();
    }
  });
});

it("silently renews a stale close review and keeps the browser alive", async () => {
  await mount("/");
  const session = client
    .getSnapshot()
    .browserSessions.find(
      (candidate) =>
        candidate.state === "ready" &&
        candidate.attachedRunIds.length > 0 &&
        candidate.tabCatalog?.tabs.length,
    )!;
  const tab = session.tabCatalog!.tabs[0]!;
  const close = vi.spyOn(client, "closeBrowserTab").mockRejectedValueOnce(
    new HostClientRequestError({
      code: "conflict",
      status: 409,
      reason: staleBrowserTabInventoryReason,
      message: "Tab inventory changed",
    }),
  );
  await click(element(`[data-place-key="browser:${session.id}:${tab.id}"] .side-tab__close`));
  await click(element(".dialog .btn--danger"));
  await settle(100);
  expect(close).toHaveBeenCalledOnce();
  expect(document.querySelector(".dialog")).not.toBeNull();
  expect(
    client.getSnapshot().browserSessions.find((candidate) => candidate.id === session.id)?.state,
  ).toBe("ready");
  expect(document.querySelector(".toast--error")).toBeNull();
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
    await click(element(".start-tile[aria-label^='Notes on']"));
    await settle(80);
    expect(element(".owner-view__view-only").textContent).toBe("View only");
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
    await click(element(".start-tile[aria-label^='Keynote on']"));
    await settle(80);
    expect(element(".owner-view__view-only").textContent).toBe("View only");
    expect(document.querySelector(".owner-view__use")).toBeNull();
  });

  it("never offers it without the desktop's bridge, whatever the computer", async () => {
    await mount("/?panel=browser", { shell: { deploymentAccess, desktopDeployment } });
    await click(element(".start-tile[aria-label^='Notes on']"));
    await settle(80);
    expect(element(".owner-view__view-only").textContent).toBe("View only");
    expect(document.querySelector(".owner-view__use")).toBeNull();
  });
});

describe("the v7 web review's findings", () => {
  const ownerViews = () =>
    client.getSnapshot().machines.flatMap((machine) => machine.computerUse?.ownerViews ?? []);
  async function openTile(label: string) {
    if (!document.querySelector(".start-page")) {
      await click(element('.side-section--tabs .side-head__action[aria-label="New tab"]'));
    }
    await click(element(`.start-tile[aria-label^='${label}']`));
    await settle(120);
  }

  it("M2 · the person's own view of the phone a task holds leaves the task's viewfinder on its own session", async () => {
    const threadId = "thr_00000000-0000-4000-8000-000000000903";
    await mount(`/threads/${threadId}`);
    await settle(200);
    const before = client.latestPlaceOfThread(threadId);
    expect(before?.placeKey).toMatch(/^phone:/u);
    expect(before?.destination).toMatchObject({
      kind: "phone",
      computerSessionId: expect.any(String),
    });
    expect(document.querySelector(".viewfinder .computer-watch")).not.toBeNull();
    await openTile("Pixel 7");
    expect(element(".owner-view")).toBeTruthy();
    const row = placeList(client.getSnapshot()).find((item) => item.key === before!.placeKey)!;
    // The sidebar keeps the task's row and the person's independent view.
    expect(row.destination).toMatchObject({ kind: "phone", computerSessionId: expect.any(String) });
    expect(row.ownerView).toBeNull();
    expect(
      placeList(client.getSnapshot()).some((place) => place.ownerView?.target.kind === "phone"),
    ).toBe(true);
    expect(row.occupants.map((occupant) => occupant.threadId)).toContain(threadId);
    expect(client.latestPlaceOfThread(threadId)?.destination).toEqual(before!.destination);
    expect(document.querySelector(".viewfinder .computer-watch")).not.toBeNull();
    // The person's view ending is not the task's: its reference stays live.
    const view = ownerViews().find((candidate) => candidate.target.kind === "phone")!;
    await act(async () => {
      await client.closeComputerView(view.viewId, view.generation);
    });
    await settle(60);
    expect(client.latestPlaceOfThread(threadId)?.destination).toEqual(before!.destination);
    expect(document.querySelector(".viewfinder .computer-watch")).not.toBeNull();
  });

  it("M6 · clearing recent sites never fails an owner view the Host already opened", async () => {
    await mount("/?panel=browser");
    // Cleared at the moment the Host has opened the view, before its answer is read.
    let cleared = false;
    const stop = client.subscribe(() => {
      if (cleared) return;
      const opened = ownerViews().some(
        (view) => view.target.kind === "app" && view.target.app.bundleId === "com.apple.iCal",
      );
      if (!opened) return;
      cleared = true;
      client.recentSites.clear({
        kind: "profile",
        profileId: "bpr_00000000-0000-4000-8000-000000000001",
      });
    });
    await click(element(".start-tile[aria-label^='Calendar on']"));
    await settle(120);
    stop();
    expect(cleared).toBe(true);
    expect(document.querySelector(".toast--error")).toBeNull();
    expect(element(".owner-view").getAttribute("aria-label")).toContain("Calendar");
    expect(new URLSearchParams(history.at(-1)!.search).has("computerView")).toBe(true);
  });

  it("m1 · only the load a person's own navigation started joins their recent sites", async () => {
    const personal = {
      kind: "profile" as const,
      profileId: "bpr_00000000-0000-4000-8000-000000000001",
    };
    await mount((source) => {
      const reading = placeList(source.getSnapshot()).find(
        (item) => item.kind === "browser" && item.title === "Your reading list",
      )!;
      return `/${tabSearch(reading)}`;
    });
    const reading = placeList(client.getSnapshot()).find(
      (item) => item.kind === "browser" && item.title === "Your reading list",
    )!;
    if (reading.destination.kind !== "browser" || !reading.destination.tabId)
      throw new Error("Not a browser tab");
    const { sessionId, tabId } = reading.destination;
    const surfaceId = BrowserSurfaceIdSchema.parse(tabId);
    expect(client.recentSites.list(personal)).toEqual([]);
    const input = element<HTMLInputElement>(".browser-address input");
    const submit = async (text: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          text,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        element(".browser-address").dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      });
      await settle();
    };
    const agentGoes = async (url: string) => {
      await act(async () => {
        client.sendBrowserCommand(sessionId, { surfaceId, type: "navigation.go", url });
      });
      await settle(1_100);
    };
    // Revisiting the same URL is a person visit; later agent activity is not.
    const revisited = new URL(input.value).origin;
    await submit(input.value);
    await settle(1_100);
    await agentGoes("https://agent-only.example/private");
    expect(client.recentSites.list(personal).map((site) => site.origin)).toEqual([revisited]);
    // Stopped by the person: the navigation is cancelled, and so is the intent.
    await submit("example.org");
    await click(element(".browser-controls [aria-label='Stop loading']"));
    await settle(60);
    expect(client.recentSites.list(personal).map((site) => site.origin)).toEqual([revisited]);
    await agentGoes("https://agent-again.example/");
    expect(client.recentSites.list(personal).map((site) => site.origin)).toEqual([revisited]);
    // A navigation of the person's own that ends somewhere new is theirs, with its path.
    await submit("example.com/some/path?q=1");
    await settle(1_100);
    expect(client.recentSites.list(personal).map((site) => site.origin)).toEqual([
      "https://example.com",
      revisited,
    ]);
    await agentGoes("https://agent-later.example/");
    expect(client.recentSites.list(personal).map((site) => site.origin)).toEqual([
      "https://example.com",
      revisited,
    ]);
  }, 20_000);

  it("m2 · Clear browsing history and a profile pick leave the keyboard in the search field", async () => {
    const personal = {
      kind: "profile" as const,
      profileId: "bpr_00000000-0000-4000-8000-000000000001",
    };
    await mount("/?panel=browser");
    act(() =>
      client.recentSites.record(personal, "https://example.com/", client.recentSites.epoch),
    );
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
    await settle();
    expect(document.activeElement).toBe(pill);
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
    await settle();
    const clear = [...document.querySelectorAll<HTMLElement>(".popover [role=menuitem]")].find(
      (node) => node.textContent?.includes("Clear browsing history"),
    )!;
    await click(clear);
    await settle(60);
    expect(document.querySelector("section[aria-label^='Recent sites']")).toBeNull();
    expect(document.activeElement).toBe(field);
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
    await settle();
  }

  it("an offline computer folds into one quiet line after the rest; its apps are found but never opened, and unfold in their own place when it's back", async () => {
    await openStartPage();
    const asked = vi.spyOn(client, "openComputerView");
    expect(captions()).toEqual(["Mac mini", "Studio Mac", "Phone"]);

    await setStatus("Studio Mac", "offline");
    expect(captions()).toEqual(["Mac mini", "Phone", "Studio Mac"]);
    expect(captions(".start-apps__away")).toEqual(["Studio Mac"]);
    expect(document.querySelector(".start-tile[aria-label^='Keynote on']")).toBeNull();
    const line = element<HTMLElement>(".start-apps__away .start-apps__row");
    expect(element(".start-apps__status", line).textContent).toBe("Offline");
    // Nothing to do there but wait, so nothing on it is offered.
    expect(line.matches("button, a, [tabindex], [data-start-tile]")).toBe(false);
    expect(line.querySelector("button, a, [tabindex], [data-start-tile]")).toBeNull();

    // Typing still finds Keynote and says why where Enter's action would be; the keyboard passes
    // over it to the search, and choosing it asks nothing.
    const field = element<HTMLInputElement>(".start-page__input");
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
    expect(captions()).toEqual(["Mac mini", "Studio Mac", "Pixel 7"]);

    await setStatus("Studio Mac", "online");
    await setStatus("Pixel 7", "online");
    expect(captions()).toEqual(["Mac mini", "Studio Mac", "Phone"]);
    expect(document.querySelector(".start-apps__away")).toBeNull();
    await click(element(".start-tile[aria-label^='Keynote on']"));
    await settle(120);
    expect(asked).toHaveBeenCalledTimes(1);
    expect(element(".owner-view").getAttribute("aria-label")).toContain("Keynote");
  });

  it("a computer waiting on its owner folds into a line that opens its page, where the steps are", async () => {
    await openStartPage();
    const mini = machine("Mac mini");
    await act(async () => client.setComputerUseReadiness(mini.id, "permission-required"));
    await settle();
    expect(captions()).toEqual(["Studio Mac", "Phone", "Mac mini"]);
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
    expect(history.at(-1)!.path).toBe(`/settings/computers/${encodeURIComponent(mini.id)}`);
  });

  it("typed, an app whose computer waits on its owner says so, the keyboard reaches it, and Enter opens the computer's page", async () => {
    await openStartPage();
    const mini = machine("Mac mini");
    await act(async () => client.setComputerUseReadiness(mini.id, "permission-required"));
    await settle();
    const field = element<HTMLInputElement>(".start-page__input");
    await typeInto(field, "notes");
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
    });
    const notes = element<HTMLElement>(".start-result.is-active");
    expect(notes.querySelector(".start-result__title")?.textContent).toBe("Notes");
    expect(element(".start-result__action", notes).textContent).toBe("Needs permission");
    expect(notes.getAttribute("aria-disabled")).toBeNull();
    await pressEnter(field);
    expect(history.at(-1)!.path).toBe(`/settings/computers/${encodeURIComponent(mini.id)}`);
  });

  it("a line that stops needing its owner and is only away hands the keyboard to the search field", async () => {
    await openStartPage();
    await act(async () =>
      client.setComputerUseReadiness(machine("Mac mini").id, "permission-required"),
    );
    await settle();
    const line = element<HTMLButtonElement>(".start-apps__away button.start-apps__row");
    await act(async () => line.focus());
    expect(document.activeElement).toBe(line);
    await setStatus("Mac mini", "offline");
    expect(element(".start-apps__away .start-apps__status").textContent).toBe("Offline");
    expect(document.activeElement).toBe(element(".start-page__input"));
  });

  it("a row that folds under the keyboard hands it to the search field; a row that stays keeps it", async () => {
    await openStartPage();
    const keynote = element<HTMLButtonElement>(".start-tile[aria-label^='Keynote on']");
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
