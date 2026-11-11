import { conversationHistoryHost } from "@opensteer/client/test-support";
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
        (candidate.browserTabs?.sessionTabs(candidate?.id) ?? []).length,
    )!;
  const tab = (session.browserTabs?.sessionTabs(session?.id) ?? [])[0]!;
  await click(element(`[data-place-key="browser:${session.id}:${tab.id}"] .side-tab__close`));
  expect(document.querySelector(".dialog")).not.toBeNull();
  await act(async () =>
    client.closeBrowserTab(session.id, tab.id, session.browserTabs!.inventory(session?.id)!),
  );
  await settle(100);
  expect(document.querySelector(".dialog")).toBeNull();
  expect(document.querySelector(".toast--error")).toBeNull();
});

describe("a reply's live picture belongs to its working Run", () => {
  /** The thread's one live picture folded into its header. */
  const pictures = () => [
    ...document.querySelectorAll<HTMLButtonElement>(".conv-header .viewfinder"),
  ];
  const picture = () => pictures()[0] ?? null;
  const chipTitles = (row: Element) =>
    [...row.querySelectorAll(".surface-chip__title")].map((title) => title.textContent);
  const browserPlaces = () =>
    placeList(client.getSnapshot()).filter(
      (item) => item.kind === "browser" && item.availability === "ready",
    );
  /** Waits for the render that shows this Run place. */
  async function pictureShows(key: string) {
    await vi.waitFor(
      () => {
        expect(picture()?.dataset.placeKey, `The live picture never showed ${key}`).toBe(key);
      },
      { timeout: 3000 },
    );
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

  it("keeps another working Run's page out of this conversation's live spot", async () => {
    await mount("/");
    const { home, place } = await chatWorkingIn("Weekend ideas");
    const waiting = "thr_00000000-0000-4000-8000-000000000902";
    await act(async () => goTo!(`/threads/${waiting}`));
    await vi.waitFor(
      () => expect(picture(), "The previous thread kept its live picture").toBeNull(),
      { timeout: 1500 },
    );
    await act(async () =>
      client.actInPlace(waiting, browserPlaces().find((item) => item.key !== place.key)!.key),
    );
    expect(picture()?.dataset.placeKey).not.toBe(place.key);
    await act(async () => goTo!("/"));
    await pictureShows(place.key);
    expect(client.getSnapshot().homeThreadId).toBe(home);
  });

  it("a page whose browser ended keeps the Run card until the Run ends", async () => {
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
    expect(picture()?.dataset.placeKey).toBe(place.key);
    expect(picture()?.querySelector(".live-dot")).toBeNull();
  });

  it("a finished reply's page never follows the conversation afterwards", async () => {
    await mount("/");
    const { home, place } = await chatWorkingIn("Weekend ideas");
    await act(async () => client.stopRun(home));
    await vi.waitFor(
      () =>
        expect(
          document.querySelector(".transcript .run-note"),
          "Stopped reply never settled",
        ).not.toBeNull(),
      { timeout: 1500 },
    );
    expect(picture()).toBeNull();
    // The page stays a chip under the reply that used it, where it was.
    expect(
      [...document.querySelectorAll(".transcript .surface-chip__title")].map((t) => t.textContent),
    ).toContain(place.title);
  });

  it("shows one live picture in the header, hides it for the same stage and restores it", async () => {
    await mount("/");
    const { place } = await chatWorkingIn("Weekend ideas");
    expect(pictures()).toHaveLength(1);
    expect(picture()!.closest(".turn")).toBeNull();
    expect(document.querySelector(".composer-dock .viewfinder")).toBeNull();
    expect(document.querySelector(".transcript .surface-chips")).toBeNull();
    await click(picture()!);
    expect(element(".place").getAttribute("data-place-key")).toBe(place.key);
    expect(picture()).toBeNull();
    await act(async () => goTo!("/"));
    await pictureShows(place.key);
  });

  it("switches immediately on each new place entry while retaining the card", async () => {
    await mount("/");
    const { home, place: first } = await chatWorkingIn("Weekend ideas");
    const card = picture();
    const second = browserPlaces().find((item) => item.title === "Your reading list")!;
    for (const place of [second, first, second]) {
      await act(async () => client.actInPlace(home, place.key));
      expect(picture()).toBe(card);
      expect(picture()!.dataset.placeKey).toBe(place.key);
    }
  });

  it("keeps overflow pages reachable once the reply settles", async () => {
    await mount("/");
    const { home, place: first } = await chatWorkingIn("Weekend ideas");
    const others = browserPlaces()
      .filter((item) => item.key !== first.key)
      .slice(0, 4);
    expect(others).toHaveLength(4);
    for (const place of others) await act(async () => client.actInPlace(home, place.key));
    expect(document.querySelector(".transcript .surface-chips")).toBeNull();
    await act(async () => client.stopRun(home));
    await vi.waitFor(
      () =>
        expect(
          document.querySelector(".transcript .surface-chip--more"),
          "Settled reply never offered its overflow pages",
        ).not.toBeNull(),
      { timeout: 1500 },
    );
    await click(element(".transcript .surface-chip--more"));
    for (const place of [first, ...others])
      expect(document.body.textContent).toContain(place.title);
  });

  it("closing its page keeps the card, then Run end hands off to its muted chip", async () => {
    await mount("/");
    const { home, place } = await chatWorkingIn("Weekend ideas");
    const { session, tabId } = tabOf(place);
    await act(async () =>
      client.closeBrowserTab(session.id, tabId, session.browserTabs!.inventory(session?.id)!),
    );
    expect(picture()?.dataset.placeKey).toBe(place.key);
    await act(async () => client.stopRun(home));
    expect(picture()).toBeNull();
    expect(document.querySelector(".transcript .surface-chip--ended")).not.toBeNull();
    await vi.waitFor(
      () =>
        expect(
          document.querySelector(".transcript .surface-chip--ended"),
          "Closed page chip never settled",
        ).not.toBeNull(),
      { timeout: 1500 },
    );
    const chip = [...document.querySelectorAll(".transcript .surface-chip")].find((candidate) =>
      candidate.textContent?.includes(place.title),
    );
    expect(chip?.classList.contains("surface-chip--ended")).toBe(true);
  });

  it("a stopped reply keeps its pages under how it ended", async () => {
    await mount("/");
    const { home, place } = await chatWorkingIn("Weekend ideas");
    await act(async () => client.stopRun(home));
    await vi.waitFor(
      () =>
        expect(
          document.querySelector(".transcript .run-note"),
          "Stopped reply never settled",
        ).not.toBeNull(),
      { timeout: 1500 },
    );
    const stopped = [...document.querySelectorAll(".transcript .run-note")].find((note) =>
      note.textContent?.includes("Stopped."),
    )!;
    const row = stopped.nextElementSibling!;
    expect(row.classList.contains("surface-chips")).toBe(true);
    expect(chipTitles(row)).toContain(place.title);
  });

  it("a tab closed in a browser that stays open keeps its card and later mutes its chip", async () => {
    await mount("/");
    const { home, place } = await chatWorkingIn("Your reading list");
    const { session, tabId } = tabOf(place);
    expect((session.browserTabs?.sessionTabs(session?.id) ?? []).length).toBeGreaterThan(1);
    await act(async () =>
      client.closeBrowserTab(session.id, tabId, session.browserTabs!.inventory(session?.id)!),
    );
    expect(
      client.getSnapshot().browserSessions.find((candidate) => candidate.id === session.id)?.state,
    ).toBe("ready");
    expect(picture()?.dataset.placeKey).toBe(place.key);
    await act(async () => client.stopRun(home));
    expect(picture()).toBeNull();
    expect(document.querySelector(".transcript .surface-chip--ended")).not.toBeNull();
    await vi.waitFor(
      () =>
        expect(
          document.querySelector(".transcript .surface-chip--ended"),
          "Closed page chip never settled",
        ).not.toBeNull(),
      { timeout: 1500 },
    );
    const chip = [...document.querySelectorAll(".transcript .surface-chip")].find((candidate) =>
      candidate.textContent?.includes(place.title),
    );
    expect(chip?.classList.contains("surface-chip--ended")).toBe(true);
  });

  it("closing a previous page leaves the current card alone", async () => {
    await mount("/");
    const { home, place: held } = await chatWorkingIn("Your reading list");
    const next = browserPlaces().find((item) => item.title === "Weekend ideas")!;
    await act(async () => client.actInPlace(home, next.key));
    expect(picture()!.dataset.placeKey).toBe(next.key);
    const { session, tabId } = tabOf(held);
    await act(async () =>
      client.closeBrowserTab(session.id, tabId, session.browserTabs!.inventory(session?.id)!),
    );
    // Closing another page does not change this Run's current place.
    expect(picture()!.dataset.placeKey).toBe(next.key);
  });

  it("a reply waiting on the person keeps its picture", async () => {
    const waiting = "thr_00000000-0000-4000-8000-000000000902";
    await mount(`/threads/${waiting}`);
    expect(picture()).toBeNull();
    const place = browserPlaces()[0]!;
    await act(async () => client.actInPlace(waiting, place.key));
    await pictureShows(place.key);
    expect(picture()!.closest(".conv-header")).not.toBeNull();
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
    // Chat has nothing of its own to rename, mark or finish: undocked it has no menu.
    expect(document.querySelector(".conv-header__menu")).toBeNull();
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

it("opens Chat with a whole-turn page in one read", async () => {
  let fixture!: ReturnType<typeof conversationHistoryHost>;
  await mount("/", {
    hostClient: (source) => {
      fixture = conversationHistoryHost(source);
      return fixture.client;
    },
  });
  await vi.waitFor(
    () => {
      for (let index = 0; index < 10; index += 1)
        expect(document.body.textContent, "Chat did not draw its history page").toContain(
          `Visible conversation question ${index}`,
        );
    },
    { timeout: 1000 },
  );
  expect(fixture.requests).toHaveLength(1);
  expect(fixture.requests[0]).toMatchObject({ turns: 10 });
});

describe("a conversation's page above it at phone width", () => {
  /** A task whose Run is in no place yet. */
  const waiting = "thr_00000000-0000-4000-8000-000000000902";
  const page = () => document.querySelector<HTMLElement>(".run-page");
  const folded = () => document.querySelector<HTMLButtonElement>(".conv-header .viewfinder");
  /** A 390-pixel phone: the thread has room, its transcript scrolls. */
  function phoneGeometry() {
    const size = (element: Element, key: "clientHeight" | "clientWidth" | "scrollHeight") => {
      if (element.classList.contains("thread"))
        return { clientHeight: 844, clientWidth: 390, scrollHeight: 844 }[key];
      if (element.classList.contains("transcript-scroll"))
        return { clientHeight: 400, clientWidth: 390, scrollHeight: 2000 }[key];
      return 0;
    };
    for (const key of ["clientHeight", "clientWidth", "scrollHeight"] as const)
      vi.spyOn(HTMLElement.prototype, key, "get").mockImplementation(function (this: HTMLElement) {
        return size(this, key);
      });
  }
  async function opened() {
    await mount(`/threads/${waiting}`, { width: 390 });
    phoneGeometry();
    expect(page() ?? folded(), "The Run was already in a place").toBeNull();
  }
  function browserPlace(title: string) {
    return placeList(client.getSnapshot()).find(
      (item) => item.kind === "browser" && item.availability === "ready" && item.title === title,
    )!;
  }
  async function acts(title = "Weekend ideas") {
    const place = browserPlace(title);
    await act(async () => client.actInPlace(waiting, place.key));
    await vi.waitFor(
      () => expect(page() ?? folded(), "The Run's page never showed").not.toBeNull(),
      { timeout: 1500 },
    );
    return place;
  }

  it("opens on the first action, folds into the head, unfolds, shows the full tab and ends with the Run", async () => {
    await opened();
    const place = await acts();
    expect(page()).not.toBeNull();
    expect(folded(), "The head kept a picture of the open page").toBeNull();

    await click(element(".run-page__handle"));
    expect(page()).toBeNull();
    expect(folded()?.getAttribute("aria-expanded")).toBe("false");

    await click(folded()!);
    expect(page()).not.toBeNull();
    // Folding and unfolding never navigate.
    expect(history.at(-1)).toMatchObject({ path: `/threads/${waiting}`, search: "" });

    // The Run moving to another page keeps it open, on that page.
    const next = browserPlace("Your reading list");
    await act(async () => client.actInPlace(waiting, next.key));
    expect(element(".run-page__view").getAttribute("aria-label")).toContain(next.title);
    await act(async () => client.actInPlace(waiting, place.key));

    await click(element(".run-page__view"));
    expect(placeParams(history.at(-1)!.search)).toBe(placeParams(tabSearch(place)));
    await act(async () => goTo!(`/threads/${waiting}`));
    expect(page(), "Coming back, the page was no longer open").not.toBeNull();

    await act(async () => client.stopRun(waiting));
    expect(page() ?? folded(), "The page outlived its Run").toBeNull();
  });

  it("a head with no room for the folded picture leaves the page its row, and Find under the name", async () => {
    // A bar so narrow that only its sidebar button and name fit: whatever else
    // is still drawn at its end runs past it.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      const end = this.classList.contains("conv-header__end")
        ? [...this.querySelectorAll("[data-yield]")].filter(
            (item) => item.closest("[data-yielded]") === null,
          ).length * 50
        : 0;
      return DOMRect.fromRect({ x: 0, y: 0, width: 160 + end, height: 44 });
    });
    await opened();
    const place = await acts();
    await click(element(".run-page__handle"));
    await vi.waitFor(
      () => expect(folded()?.closest("[data-yielded]"), "The head kept the picture").not.toBeNull(),
      { timeout: 1500 },
    );
    // Folded, the page stands above the conversation as its row, without a handle.
    expect(document.querySelector(".run-page__handle")).toBeNull();
    expect(element(".run-page__view").getAttribute("aria-expanded")).toBe("false");
    expect(
      element('.conv-header [aria-label="Find in conversation"]').closest("[data-yielded]"),
    ).not.toBeNull();
    await click(element(".conv-header__menu"));
    expect(document.body.textContent).toContain("Find in conversation");
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));

    // The row opens the page where it fits, and the page still shows the full tab.
    await click(element(".run-page__view"));
    expect(document.querySelector(".run-page__handle")).not.toBeNull();
    await click(element(".run-page__view"));
    expect(placeParams(history.at(-1)!.search)).toBe(placeParams(tabSearch(place)));
  });

  it.each([
    [
      "reading back",
      async () => {
        const scroller = element<HTMLElement>(".transcript-scroll");
        // The first scroll after a resize only takes the new geometry in.
        for (const _ of [1, 2])
          await act(async () => {
            scroller.scrollTop = 0;
            scroller.dispatchEvent(new Event("scroll"));
          });
        expect(element(".transcript__jump"), "The reader never left the tail").not.toBeNull();
      },
    ],
    [
      "typing",
      async () => {
        await act(async () => element<HTMLTextAreaElement>(".composer-dock textarea").focus());
      },
    ],
    [
      "on cellular",
      async () => {
        Object.defineProperty(navigator, "connection", {
          configurable: true,
          value: { type: "cellular" },
        });
      },
    ],
  ])("starts folded while the reader is %s", async (_case, moment) => {
    await opened();
    try {
      await moment();
      await acts();
      expect(page()).toBeNull();
      expect(folded()).not.toBeNull();
      await click(folded()!);
      expect(page(), "The reader could not open it themselves").not.toBeNull();
    } finally {
      Reflect.deleteProperty(navigator, "connection");
    }
  });
});
