// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useNavigate } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import {
  HttpHostClient,
  placeList,
  type HostSnapshot,
  type PlaceItem,
} from "@opensteer/client/host";

import { hostApi } from "@opensteer/protocol";

import { type WorkspaceNavigation } from "./navigation.js";
import { WorkspaceLayout } from "./workspace-layout.js";
import { WorkspaceProvider, useWorkspace, type WorkspaceState } from "./workspace-context.js";

import {
  root,
  client,
  sessionClient,
  history,
  goTo,
  resize,
  mount,
  stubLayout,
  settle,
  element,
  click,
  placeParams,
  pageTab,
  tabSearch,
  write,
  typeInto,
  pressEnter,
  firstTaskId,
  setRoot,
  setClient,
} from "./workspace.interaction.test-support.js";
describe("a conversation chosen before the list redraws", () => {
  it("keeps the tab chosen a moment before in the middle", async () => {
    await mount("/");
    const place = pageTab();
    const threadId = firstTaskId();
    // Both presses land before React redraws the rows for the first.
    await act(async () => {
      element<HTMLButtonElement>(
        `.side-tab[data-place-key="${place.key}"] .side-tab__main`,
      ).click();
      element<HTMLAnchorElement>(
        `.side-task[data-thread-id="${threadId}"] .side-task__main`,
      ).click();
    });
    await settle();
    expect(history.at(-1)!.path).toBe(`/threads/${threadId}`);
    expect(placeParams(history.at(-1)!.search)).toBe(placeParams(tabSearch(place)));
    // A modified click still belongs to the link.
    const other = document.querySelectorAll<HTMLAnchorElement>(".side-task .side-task__main")[1]!;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true });
    await act(async () => {
      other.dispatchEvent(event);
    });
    expect(history.at(-1)!.path).toBe(`/threads/${threadId}`);
  });
});

describe("the dock's slide always settles", () => {
  /** A slide this test finishes or cancels by hand, as the browser would. */
  class Slide {
    readonly finished: Promise<unknown>;
    end!: () => void;
    cancel!: () => void;
    constructor() {
      this.finished = new Promise((resolve, reject) => {
        this.end = () => resolve(this);
        this.cancel = () => reject(new DOMException("Cancelled", "AbortError"));
      });
      // Never an unhandled rejection when the layout no longer listens.
      this.finished.catch(() => undefined);
    }
  }

  it("M4 · leaving desktop docking, a cancelled slide or unmounting never leaves the place settling", async () => {
    stubLayout(1440);
    setClient(new MockHostClient({ latencyMs: 0 }));

    const slides: Slide[] = [];
    vi.spyOn(HTMLElement.prototype, "animate").mockImplementation(function (this: HTMLElement) {
      expect(this.classList.contains("workspace__conversation")).toBe(true);
      const slide = new Slide();
      slides.push(slide);
      return slide as unknown as Animation;
    });
    let workspace!: WorkspaceState;
    let go!: ReturnType<typeof useNavigate>;
    function Probe() {
      workspace = useWorkspace();
      go = useNavigate();
      return null;
    }
    const node = document.createElement("div");
    document.body.append(node);
    setRoot(createRoot(node));
    await act(async () =>
      root?.render(
        <MemoryRouter initialEntries={["/?panel=browser"]}>
          <WorkspaceProvider
            attention={0}
            nav={{} as unknown as WorkspaceNavigation}
            openDrawer={() => undefined}
          >
            <Probe />
            <WorkspaceLayout middle={<div className="middle" />}>
              <div className="conversation" />
            </WorkspaceLayout>
          </WorkspaceProvider>
        </MemoryRouter>,
      ),
    );
    const phase = () => workspace.layout.get();
    const slideStarted = async () => {
      const count = slides.length;
      await settle(40);
      expect(slides.length).toBe(count + 1);
      expect(phase()).toBe("settling");
      return slides.at(-1)!;
    };
    expect(phase()).toBe("settled");

    // Put away, then Hide computer before the slide ends: Talk has no dock to wait for.
    act(() => workspace.dock.close());
    await slideStarted();
    await act(async () => go("/"));
    expect(phase()).toBe("settled");
    await act(async () => go("/?panel=browser"));
    await settle(40);
    expect(phase()).toBe("settled");

    // A slide the browser cancels without starting another settles too.
    act(() => workspace.dock.show());
    const cancelled = await slideStarted();
    await act(async () => cancelled.cancel());
    expect(phase()).toBe("settled");

    // A reversal: the first slide's cancellation is the second's to settle.
    act(() => workspace.dock.close());
    const first = await slideStarted();
    act(() => workspace.dock.show());
    const second = await slideStarted();
    await act(async () => first.cancel());
    expect(phase()).toBe("settling");
    await act(async () => second.end());
    expect(phase()).toBe("settled");

    // Crossing to the phone layout mid-slide settles it.
    act(() => workspace.dock.close());
    await slideStarted();
    await resize(390);
    expect(phase()).toBe("settled");
    await resize(1440);
    expect(phase()).toBe("settled");

    // So does the layout going away mid-slide, and a slide that then ends changes nothing.
    act(() => workspace.dock.show());
    const orphan = await slideStarted();
    act(() => root?.unmount());
    setRoot(null);
    expect(phase()).toBe("settled");
    await act(async () => orphan.end());
    expect(phase()).toBe("settled");
  });
});

it("dismisses a close review when another client closes its target", async () => {
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
  await click(element(`[data-place-key="browser:${session.id}:${tab.id}"] .side-tab__close`));
  expect(document.querySelector(".dialog")).not.toBeNull();
  await act(async () => client.closeBrowserTab(session.id, tab.id, session.tabCatalog!));
  await settle(100);
  expect(document.querySelector(".dialog")).toBeNull();
  expect(document.querySelector(".toast--error")).toBeNull();
});

describe("a reply's live picture belongs to its working Run", () => {
  /** The live picture in the transcript, wherever it is drawn. */
  const pictures = () => [
    ...document.querySelectorAll<HTMLButtonElement>(".transcript .viewfinder"),
  ];
  const picture = () => pictures()[0] ?? null;
  /** The chips of the reply that draws the picture: the row right above it. */
  const chipsAbove = (shown: HTMLElement) =>
    shown.closest(".viewfinder-slot")!.previousElementSibling as HTMLElement;
  const chipTitles = (row: Element) =>
    [...row.querySelectorAll(".surface-chip__title")].map((title) => title.textContent);
  const highlighted = () => [
    ...document.querySelectorAll<HTMLElement>(".transcript .surface-chip--active"),
  ];
  const browserPlaces = () =>
    placeList(client.getSnapshot()).filter(
      (item) => item.kind === "browser" && item.availability === "ready",
    );
  /** Settles until the picture shows `key`, past any hold on the page before it. */
  async function pictureShows(key: string) {
    for (let waited = 0; picture()?.dataset.placeKey !== key; waited += 100) {
      if (waited > 3_000) throw new Error(`The picture never showed ${key}`);
      await settle(100);
    }
  }
  /** Chat's working Run acts in one of its pages, and its reply's picture shows it. */
  async function chatWorkingIn(title: string) {
    const home = client.getSnapshot().homeThreadId!;
    const place = browserPlaces().find((item) => item.title === title)!;
    await act(async () => client.actInPlace(home, place.key));
    await pictureShows(place.key);
    return { home, place };
  }
  function tabOf(place: PlaceItem) {
    const { destination } = place;
    if (destination.kind !== "browser" || !destination.tabId) throw Error("Not a tab");
    const session = client
      .getSnapshot()
      .browserSessions.find((candidate) => candidate.id === destination.sessionId)!;
    return { session, tabId: destination.tabId };
  }

  it("a page whose browser ended leaves no card behind", async () => {
    await mount("/");
    const { place } = await chatWorkingIn("Weekend ideas");
    const { session } = tabOf(place);
    await act(async () => {
      await client
        .dispatch({
          type: "browser.session.close",
          sessionId: session.id,
          idempotencyKey: `end-browser:${session.id}`,
        })
        .catch(() => undefined);
    });
    await settle(200);
    expect(picture()).toBeNull();
    expect(document.querySelector(".viewfinder--ended")).toBeNull();
  });

  it("a finished reply's page never follows the conversation afterwards", async () => {
    await mount("/");
    const { home, place } = await chatWorkingIn("Weekend ideas");
    await act(async () => client.stopRun(home));
    await settle(400);
    expect(picture()).toBeNull();
    expect(highlighted()).toEqual([]);
    // The page stays a chip under the reply that used it, where it was.
    expect(
      [...document.querySelectorAll(".transcript .surface-chip__title")].map((t) => t.textContent),
    ).toContain(place.title);
  });

  it("the working reply draws one picture under its chips, its page's chip highlighted", async () => {
    await mount("/");
    await chatWorkingIn("Weekend ideas");
    expect(pictures()).toHaveLength(1);
    const shown = picture()!;
    const row = chipsAbove(shown);
    expect(row.classList.contains("surface-chips")).toBe(true);
    expect(shown.closest(".turn")).toBe(row.closest(".turn"));
    expect(highlighted()).toHaveLength(1);
    expect(highlighted()[0]!.getAttribute("aria-current")).toBe("true");
    expect(highlighted()[0]!.textContent).toContain(shown.title);
    // Pressing it shows exactly its page in the middle.
    await click(shown);
    expect(element(".place").getAttribute("data-place-key")).toBe(shown.dataset.placeKey);
    // Shown in the middle as well, it stays put rather than vanishing under the pointer.
    expect(picture()?.dataset.placeKey).toBe(shown.dataset.placeKey);
  });

  it("working across two pages, the picture holds before it cuts, and no chip moves", async () => {
    await mount("/");
    const { home, place: first } = await chatWorkingIn("Weekend ideas");
    const second = browserPlaces().find((item) => item.title === "Your reading list")!;
    await act(async () => client.actInPlace(home, second.key));
    await settle(100);
    // Both are this reply's pages; the picture holds on the first for now.
    expect(picture()!.dataset.placeKey).toBe(first.key);
    const before = chipTitles(chipsAbove(picture()!));
    expect(before).toEqual(expect.arrayContaining([first.title, second.title]));
    await act(async () => client.actInPlace(home, first.key));
    await act(async () => client.actInPlace(home, second.key));
    await pictureShows(second.key);
    expect(highlighted()[0]!.textContent).toContain(second.title);
    expect(chipTitles(chipsAbove(picture()!))).toEqual(before);
  });

  it("a page in the row's overflow lends its highlight to +N", async () => {
    await mount("/");
    const { home, place: first } = await chatWorkingIn("Weekend ideas");
    const others = browserPlaces().filter((item) => item.key !== first.key);
    expect(others.length).toBeGreaterThanOrEqual(4);
    for (const place of others.slice(0, 4))
      await act(async () => client.actInPlace(home, place.key));
    await pictureShows(others[3]!.key);
    const more = element<HTMLButtonElement>(".transcript .surface-chip--more");
    expect(more.getAttribute("aria-current")).toBe("true");
    expect(more.classList.contains("surface-chip--active")).toBe(true);
    expect(more.querySelector(".live-dot")).not.toBeNull();
  });

  it("closing the page it is working in takes the picture away and leaves its chip, muted", async () => {
    await mount("/");
    const { place } = await chatWorkingIn("Weekend ideas");
    const { session, tabId } = tabOf(place);
    await act(async () => client.closeBrowserTab(session.id, tabId, session.tabCatalog!));
    await settle(200);
    expect(picture()).toBeNull();
    const chip = [...document.querySelectorAll(".transcript .surface-chip")].find((candidate) =>
      candidate.textContent?.includes(place.title),
    );
    expect(chip?.classList.contains("surface-chip--ended")).toBe(true);
  });

  it("a stopped reply keeps its pages under how it ended", async () => {
    await mount("/");
    const { home, place } = await chatWorkingIn("Weekend ideas");
    await act(async () => client.stopRun(home));
    await settle(400);
    const stopped = [...document.querySelectorAll(".transcript .run-note")].find((note) =>
      note.textContent?.includes("Stopped."),
    )!;
    const row = stopped.nextElementSibling!;
    expect(row.classList.contains("surface-chips")).toBe(true);
    expect(chipTitles(row)).toContain(place.title);
  });

  it("a tab closed in a browser that stays open mutes its chip and takes the picture", async () => {
    await mount("/");
    const { place } = await chatWorkingIn("Your reading list");
    const { session, tabId } = tabOf(place);
    expect(session.tabCatalog!.tabs.length).toBeGreaterThan(1);
    await act(async () => client.closeBrowserTab(session.id, tabId, session.tabCatalog!));
    await settle(200);
    expect(
      client.getSnapshot().browserSessions.find((candidate) => candidate.id === session.id)?.state,
    ).toBe("ready");
    expect(picture()).toBeNull();
    const chip = [...document.querySelectorAll(".transcript .surface-chip")].find((candidate) =>
      candidate.textContent?.includes(place.title),
    );
    expect(chip?.classList.contains("surface-chip--ended")).toBe(true);
  });

  it("a held page that closes gives way at once to the page the Run is in", async () => {
    await mount("/");
    const { home, place: held } = await chatWorkingIn("Your reading list");
    const next = browserPlaces().find((item) => item.title === "Weekend ideas")!;
    await act(async () => client.actInPlace(home, next.key));
    await settle(100);
    expect(picture()!.dataset.placeKey).toBe(held.key);
    const { session, tabId } = tabOf(held);
    await act(async () => client.closeBrowserTab(session.id, tabId, session.tabCatalog!));
    await settle(150);
    // Well inside the hold: the closed page is not kept, and nothing older takes its place.
    expect(picture()!.dataset.placeKey).toBe(next.key);
  });

  it("a reply waiting on the person keeps its picture", async () => {
    const waiting = "thr_00000000-0000-4000-8000-000000000902";
    await mount(`/threads/${waiting}`);
    await settle(200);
    expect(picture()).toBeNull();
    const place = browserPlaces()[0]!;
    await act(async () => client.actInPlace(waiting, place.key));
    await pictureShows(place.key);
    expect(picture()!.closest(".turn")).not.toBeNull();
  });
});

describe("task titles", () => {
  async function headerRename() {
    await click(element(".conv-header__menu"));
    await click(element('[aria-label="Rename task"]'));
  }
  async function key(field: Element, key: string, isComposing = false) {
    await act(async () =>
      field.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, isComposing }),
      ),
    );
    await settle();
  }

  it.each([false, true])(
    "renames an unopened sidebar task in another Workspace (refused: %s)",
    async (refused) => {
      const answer = Promise.withResolvers<void>();
      let target = "";
      let original = "";
      let scopedWorkspace = "";
      const commands: unknown[] = [];
      try {
        await mount(
          (source) => {
            const snapshot = source.getSnapshot();
            const thread = snapshot.threads.find(
              (thread) =>
                thread.listed &&
                thread.role === "work" &&
                thread.workspaceId !== snapshot.homeWorkspaceId,
            )!;
            target = thread.id;
            original = thread.title;
            scopedWorkspace = thread.workspaceId;
            return "/";
          },
          {
            hostClient: (source) =>
              new HttpHostClient({
                baseUrl: "http://mock-host",
                capabilities: ["thread-titles-v1"],
                refreshIntervalMs: 0,
                webSocketFactory: () => ({
                  binaryType: "arraybuffer",
                  readyState: 0,
                  addEventListener() {},
                  close() {},
                  send() {},
                }),
                fetch: async (input, init) => {
                  const url = new URL(input instanceof Request ? input.url : String(input));
                  const name = url.pathname.slice("/v1/rpc/".length) as keyof typeof hostApi;
                  const raw = url.searchParams.get("input") ?? init?.body;
                  const payload: unknown = typeof raw === "string" ? JSON.parse(raw) : {};
                  if (name === "commands.dispatch") {
                    const command = hostApi[name].payload.parse(payload);
                    if (command.type === "thread.rename") {
                      commands.push(command);
                      await answer.promise;
                      if (refused)
                        return Response.json(
                          {
                            ok: false,
                            error: {
                              code: "bad_request",
                              message: "Rename refused",
                              retryable: false,
                            },
                          },
                          { status: 400 },
                        );
                    }
                  }
                  const parsed = hostApi[name].payload.parse(payload);
                  return Response.json(await source.rpc[name](parsed as never));
                },
              }),
          },
        );
        await settle(100);
        const displayed = sessionClient!;
        expect(displayed.getSnapshot().threads.some(({ id }) => id === target)).toBe(false);
        expect(
          displayed
            .getSnapshot()
            .threads.some(({ workspaceId }) => workspaceId === scopedWorkspace),
        ).toBe(false);
        await act(async () => displayed.loadWorkspaceTasks(scopedWorkspace));
        const row = () => element(`[data-thread-id="${target}"]`);
        expect(row().textContent).toContain(original);
        await act(async () =>
          row().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
        );
        await click(element('[role="menuitem"][data-action="rename"]'));
        await typeInto(element('input[aria-label="Task title"]'), "Cross-workspace name");
        await pressEnter(element('input[aria-label="Task title"]'));
        expect(commands).toEqual([
          expect.objectContaining({ type: "thread.rename", threadId: target }),
        ]);
        expect(
          displayed.getSnapshot().tasks?.entries.find(({ thread }) => thread.id === target)?.thread
            .title,
        ).toBe("Cross-workspace name");
        expect(
          displayed
            .getSnapshot()
            .workspaceTasks[scopedWorkspace]?.entries.find(({ thread }) => thread.id === target)
            ?.thread.title,
        ).toBe("Cross-workspace name");
        await act(async () => answer.resolve());
        await settle(100);
        if (refused) {
          expect(document.body.textContent).toContain("Rename refused");
          expect(
            displayed.getSnapshot().tasks?.entries.find(({ thread }) => thread.id === target)
              ?.thread.title,
          ).toBe(original);
          await key(element('input[aria-label="Task title"]'), "Escape");
        }
        expect(row().textContent).toContain(refused ? original : "Cross-workspace name");
        await click(element(".side-task__main", row()));
        await settle(100);
        expect(element(".conv-header__name").textContent).toBe(
          refused ? original : "Cross-workspace name",
        );
      } finally {
        answer.resolve();
      }
    },
  );

  it.each(["header", "sidebar"])(
    "renames inline from the %s and updates the task row",
    async (entry) => {
      await mount(
        (client) =>
          `/threads/${client.getSnapshot().threads.find((thread) => thread.role === "work" && thread.listed)!.id}`,
      );
      const id = history.at(-1)!.path.split("/").at(-1)!;
      const original = client.getSnapshot().threads.find((thread) => thread.id === id)!.title;
      if (entry === "header") await headerRename();
      else {
        await act(async () =>
          element(`[data-thread-id="${id}"]`).dispatchEvent(
            new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
          ),
        );
        await click(element('[role="menuitem"][data-action="rename"]'));
      }
      const field = element<HTMLInputElement>('input[aria-label="Task title"]');
      expect(document.activeElement).toBe(field);
      await typeInto(field, "  Shipping plan  ");
      await key(field, "Enter", true);
      expect(client.getSnapshot().threads.find((thread) => thread.id === id)?.title).toBe(original);
      await key(field, "Enter");
      expect(client.getSnapshot().threads.find((thread) => thread.id === id)?.title).toBe(
        "Shipping plan",
      );
      expect(element(`[data-thread-id="${id}"]`).textContent).toContain("Shipping plan");
    },
  );

  it.each([false, true])(
    "updates a new task's seed live and keeps an early rename (%s)",
    async (renameEarly) => {
      await mount("/new", { latencyMs: 500 });
      // Gate only the mock title generator, leaving transport and UI timers real.
      let finishNaming: (() => void) | undefined;
      const timeout = globalThis.setTimeout;
      vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, milliseconds, ...args) => {
        if (milliseconds === 500 && callback.toString().includes("titleTimers")) {
          finishNaming = () => callback(...args);
          const handle = timeout(() => undefined, 0);
          clearTimeout(handle);
          return handle;
        }
        return timeout(callback, milliseconds, ...args);
      });
      const message = "Prepare a launch plan for the new mobile application with milestones";
      await write(element<HTMLTextAreaElement>("[data-composer-input]"), message);
      await click(element(".composer__send"));
      for (let tries = 0; tries < 40 && !history.at(-1)!.path.startsWith("/threads/"); tries += 1)
        await settle(25);
      const id = history.at(-1)!.path.split("/").at(-1)!;
      expect(client.getSnapshot().threads.find((thread) => thread.id === id)?.title).toBe(message);
      if (renameEarly) {
        await headerRename();
        await typeInto(element('input[aria-label="Task title"]'), "Chosen launch name");
        await pressEnter(element('input[aria-label="Task title"]'));
      }
      expect(finishNaming).toBeDefined();
      await act(async () => finishNaming!());
      const title = renameEarly ? "Chosen launch name" : "Prepare a launch plan for";
      expect(client.getSnapshot().threads.find((thread) => thread.id === id)?.title).toBe(title);
      expect(element(".conv-header__name").textContent).toBe(title);
      expect(element(".conv-header .task-mark").getAttribute("data-icon")).toBe("rocket");
      expect(element(`[data-thread-id="${id}"]`).textContent).toContain(title);
    },
  );

  it("updates a delegated task line when its worker is renamed", async () => {
    await mount("/");
    const card = element<HTMLAnchorElement>(".task-line__open");
    const worker = card.getAttribute("href")!.match(/threads\/([^?]+)/u)![1]!;
    await act(async () => {
      await client.renameThread(worker, "Renamed delegated task");
    });
    await settle();
    expect(element(".task-line__title").textContent).toBe("Renamed delegated task");
  });

  it("refreshes a completed task line from a higher assignment revision without holding its worker", async () => {
    await mount("/");
    const home = client.getSnapshot().homeThreadId!;
    await act(async () => {
      await client.stopRun(home);
      await client.resumeThreadInputQueue(home);
      await client.dispatch({
        type: "thread.sendMessage",
        threadId: home,
        content: [{ type: "text", text: "Find a mattress for my guest room" }],
        idempotencyKey: "completed-card-title",
      });
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          Object.values(client.getSnapshot().assignments).some(
            (assignment) => assignment.status === "completed",
          ),
        ).toBe(true),
      );
    });
    const assignment = Object.values(client.getSnapshot().assignments).find(
      (assignment) => assignment.status === "completed",
    )!;
    expect(assignment).toBeDefined();
    const worker = assignment.workerThread.id;
    const read = client.getSnapshot;
    const cache = new WeakMap<HostSnapshot, HostSnapshot>();
    vi.spyOn(client, "getSnapshot").mockImplementation(() => {
      const snapshot = read();
      let held = cache.get(snapshot);
      if (!held) {
        held = { ...snapshot, threads: snapshot.threads.filter(({ id }) => id !== worker) };
        cache.set(snapshot, held);
      }
      return held;
    });
    await act(async () => {
      await goTo!("/?unheld=1");
    });
    expect(client.getSnapshot().threads.some(({ id }) => id === worker)).toBe(false);
    const cardTitle = () =>
      element(`.task-line__open[href*="${worker}"] .task-line__title`).textContent;
    expect(cardTitle()).toBe(assignment.workerThread.title);
    await act(async () => {
      await client.renameThread(worker, "Guest room mattress");
    });
    await settle();
    expect(client.getSnapshot().assignments[assignment.id]).toMatchObject({
      revision: assignment.revision + 1,
      status: "completed",
      workerThread: { title: "Guest room mattress" },
    });
    expect(
      client
        .getSnapshot()
        .transcripts[home]?.find(
          (entry) => entry.kind === "assignment" && entry.assignment.id === assignment.id,
        ),
    ).toMatchObject({
      assignment: {
        revision: assignment.revision + 1,
        workerThread: { title: "Guest room mattress" },
      },
    });
    expect(cardTitle()).toBe("Guest room mattress");
  });

  it("cancels blank, unchanged and Escape edits, and displays a refused rename", async () => {
    await mount(
      (client) =>
        `/threads/${client.getSnapshot().threads.find((thread) => thread.role === "work" && thread.listed)!.id}`,
    );
    const rename = vi.spyOn(client, "renameThread");
    for (const value of ["", "unchanged", "cancelled"]) {
      await headerRename();
      const field = element<HTMLInputElement>('input[aria-label="Task title"]');
      if (value !== "unchanged") await typeInto(field, value);
      await key(field, value === "cancelled" ? "Escape" : "Enter");
    }
    expect(rename).not.toHaveBeenCalled();
    rename.mockRejectedValueOnce(new Error("Rename refused"));
    await headerRename();
    await typeInto(element('input[aria-label="Task title"]'), "Denied title");
    await key(element('input[aria-label="Task title"]'), "Enter");
    expect(document.body.textContent).toContain("Rename refused");
  });

  it("hides rename for Chat and an older Host", async () => {
    await mount("/");
    await click(element(".conv-header__menu"));
    expect(document.querySelector('[aria-label="Rename task"]')).toBeNull();
    act(() => root?.unmount());
    setRoot(null);
    client.dispose();
    document.body.replaceChildren();
    await mount((source) => {
      const read = source.getSnapshot;
      const cache = new WeakMap<HostSnapshot, HostSnapshot>();
      vi.spyOn(source, "getSnapshot").mockImplementation(() => {
        const snapshot = read();
        let held = cache.get(snapshot);
        if (!held) {
          held = { ...snapshot, threadRenameAvailable: false };
          cache.set(snapshot, held);
        }
        return held;
      });
      return `/threads/${source.getSnapshot().threads.find((thread) => thread.role === "work")!.id}`;
    });
    await click(element(".conv-header__menu"));
    expect(document.querySelector('[aria-label="Rename task"]')).toBeNull();
    await act(async () =>
      element(".side-task[data-thread-id]").dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      ),
    );
    expect(document.querySelector('[data-action="rename"]')).toBeNull();
  });
});
