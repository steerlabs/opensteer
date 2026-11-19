import { conversationHistoryHost } from "@opensteer/client/test-support";
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useNavigate } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import { placeList, type TranscriptFixtureSnapshot } from "@opensteer/client/host";

import { type WorkspaceNavigation } from "./navigation.js";
import { WorkspaceLayout } from "./workspace-layout.js";
import { WorkspaceProvider, useWorkspace, type WorkspaceState } from "./workspace-context.js";

import {
  root,
  client,
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
    expect(history.at(-1)!.path).toBe(`/tasks/${threadId}`);
    expect(placeParams(history.at(-1)!.search)).toBe(placeParams(tabSearch(place)));
    // A modified click still belongs to the link.
    const other = document.querySelectorAll<HTMLAnchorElement>(".side-task .side-task__main")[1]!;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true });
    await act(async () => {
      other.dispatchEvent(event);
    });
    expect(history.at(-1)!.path).toBe(`/tasks/${threadId}`);
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
      (item) => item.kind === "page" && item.availability === "ready",
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
  /** A working task in the mock world. */
  const task = "thr_00000000-0000-4000-8000-000000000006";
  /** The task's working Run acts in one of its pages, and its reply's picture shows it. */
  async function workingIn(title: string) {
    const home = task;
    const place = browserPlaces().find((item) => item.title === title)!;
    await act(async () => client.actInPlace(home, place.key));
    await pictureShows(place.key);
    return { home, place };
  }
  it("keeps another working Run's page out of this conversation's live spot", async () => {
    await mount(`/tasks/${task}`);
    const { place } = await workingIn("Coffee shortlist");
    const waiting = "thr_00000000-0000-4000-8000-000000000902";
    await act(async () => goTo!(`/tasks/${waiting}`));
    await vi.waitFor(
      () => expect(picture(), "The previous thread kept its live picture").toBeNull(),
      { timeout: 1500 },
    );
    await act(async () =>
      client.actInPlace(waiting, browserPlaces().find((item) => item.key !== place.key)!.key),
    );
    expect(picture()?.dataset.placeKey).not.toBe(place.key);
    await act(async () => goTo!(`/tasks/${task}`));
    await pictureShows(place.key);
  });

  it("a finished reply's page never follows the conversation afterwards", async () => {
    await mount(`/tasks/${task}`);
    const { home, place } = await workingIn("Coffee shortlist");
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
    await mount(`/tasks/${task}`);
    const { place } = await workingIn("Coffee shortlist");
    expect(pictures()).toHaveLength(1);
    expect(picture()!.closest(".turn")).toBeNull();
    expect(document.querySelector(".composer-dock .viewfinder")).toBeNull();
    expect(document.querySelector(".transcript .surface-chips")).toBeNull();
    await click(picture()!);
    expect(element(".place").getAttribute("data-place-key")).toBe(place.key);
    expect(picture()).toBeNull();
    await act(async () => goTo!(`/tasks/${task}`));
    await pictureShows(place.key);
  });

  it("switches immediately on each new place entry while retaining the card", async () => {
    await mount(`/tasks/${task}`);
    const { home, place: first } = await workingIn("Coffee shortlist");
    const card = picture();
    const second = browserPlaces().find((item) => item.title === "Your reading list")!;
    for (const place of [second, first, second]) {
      await act(async () => client.actInPlace(home, place.key));
      expect(picture()).toBe(card);
      expect(picture()!.dataset.placeKey).toBe(place.key);
    }
  });

  it("keeps overflow pages reachable once the reply settles", async () => {
    await mount(`/tasks/${task}`);
    const { home, place: first } = await workingIn("Coffee shortlist");
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
    await mount(`/tasks/${task}`);
    const { home, place } = await workingIn("Coffee shortlist");
    await act(async () => client.closeTabs([place.key]));
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
    await mount(`/tasks/${task}`);
    const { home, place } = await workingIn("Coffee shortlist");
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
      /stopped/iu.test(note.textContent ?? ""),
    )!;
    const row = stopped.nextElementSibling!;
    expect(row.classList.contains("surface-chips")).toBe(true);
    expect(chipTitles(row)).toContain(place.title);
  });

  it("a closed tab keeps its card and later mutes its chip", async () => {
    await mount(`/tasks/${task}`);
    const { home, place } = await workingIn("Your reading list");
    await act(async () => client.closeTabs([place.key]));
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
    await mount(`/tasks/${task}`);
    const { home, place: held } = await workingIn("Your reading list");
    const next = browserPlaces().find((item) => item.title === "Coffee shortlist")!;
    await act(async () => client.actInPlace(home, next.key));
    expect(picture()!.dataset.placeKey).toBe(next.key);
    await act(async () => client.closeTabs([held.key]));
    // Closing another page does not change this Run's current place.
    expect(picture()!.dataset.placeKey).toBe(next.key);
  });

  it("a reply waiting on the person keeps its picture", async () => {
    const waiting = "thr_00000000-0000-4000-8000-000000000902";
    await mount(`/tasks/${waiting}`);
    expect(picture()).toBeNull();
    const place = browserPlaces()[0]!;
    await act(async () => client.actInPlace(waiting, place.key));
    await pictureShows(place.key);
    expect(picture()!.closest(".conv-header")).not.toBeNull();
  });
});

/** The task that handed work to another: the mock's task line and its worker belong to it. */
function delegating(source: { getSnapshot(): TranscriptFixtureSnapshot }): string {
  const assignment = Object.values(source.getSnapshot().assignments)[0];
  if (!assignment) throw new Error("The mock hands out no work");
  return assignment.parentThreadId;
}

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

  it.each(["header", "sidebar"])(
    "renames inline from the %s and updates the task row",
    async (entry) => {
      await mount(
        (client) =>
          `/tasks/${client.getSnapshot().threads.find((thread) => thread.purpose === "task" && thread.listed)!.id}`,
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
      await mount("/", { latencyMs: 500 });
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
      await write(element<HTMLElement>("[data-composer-input]"), message);
      await click(element(".composer__send"));
      for (let tries = 0; tries < 40 && !history.at(-1)!.path.startsWith("/tasks/"); tries += 1)
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
    },
  );

  it("updates a delegated task line when its worker is renamed", async () => {
    await mount((source) => `/tasks/${delegating(source)}`);
    const card = element<HTMLAnchorElement>("a.agent-step__head");
    const worker = card.getAttribute("href")!.match(/tasks\/([^?]+)/u)![1]!;
    await act(async () => {
      await client.renameThread(worker, "Renamed delegated task");
    });
    await settle();
    expect(element("a.agent-step__head .agent-step__title").textContent).toBe(
      "Renamed delegated task",
    );
  });

  it("refreshes a completed task line from a higher assignment revision without holding its worker", async () => {
    await mount((source) => `/tasks/${delegating(source)}`);
    const home = delegating(client);
    const assignment = Object.values(client.getSnapshot().assignments).find(
      (assignment) => assignment.status === "completed" && assignment.parentThreadId === home,
    )!;
    expect(assignment).toBeDefined();
    const worker = assignment.workerThread.id;
    const read = client.getSnapshot;
    const cache = new WeakMap<TranscriptFixtureSnapshot, TranscriptFixtureSnapshot>();
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
      await goTo!(`/tasks/${home}?unheld=1`);
    });
    expect(client.getSnapshot().threads.some(({ id }) => id === worker)).toBe(false);
    const cardTitle = () =>
      element(`a.agent-step__head[href*="${worker}"] .agent-step__title`).textContent;
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
        `/tasks/${client.getSnapshot().threads.find((thread) => thread.purpose === "task" && thread.listed)!.id}`,
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
    expect(document.body.textContent).toContain("Couldn't confirm this task was renamed.");
    expect(document.body.textContent).not.toContain("Rename refused");
  });

  it("hides rename on a Host without task titles", async () => {
    await mount((source) => {
      const read = source.getSnapshot;
      const cache = new WeakMap<TranscriptFixtureSnapshot, TranscriptFixtureSnapshot>();
      vi.spyOn(source, "getSnapshot").mockImplementation(() => {
        const snapshot = read();
        let held = cache.get(snapshot);
        if (!held) {
          held = { ...snapshot, threadRenameAvailable: false };
          cache.set(snapshot, held);
        }
        return held;
      });
      return `/tasks/${source.getSnapshot().threads.find((thread) => thread.purpose === "task")!.id}`;
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

it("draws the initial conversation cut from one scoped subscription", async () => {
  let fixture!: ReturnType<typeof conversationHistoryHost>;
  await mount((source) => `/tasks/${source.getSnapshot().threads[0]!.id}`, {
    hostClient: (source) => {
      fixture = conversationHistoryHost(source);
      return fixture.client;
    },
  });
  await vi.waitFor(
    () => {
      for (let index = 0; index < 10; index += 1)
        expect(document.body.textContent, "The task did not draw its history page").toContain(
          `Visible conversation question ${index}`,
        );
    },
    { timeout: 1000 },
  );
  expect(fixture.detailRequests).toEqual([client.getSnapshot().threads[0]!.id]);
  expect(fixture.reads).not.toContain("/v1/rpc/thread.items.page");
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
  /** A phone's visual viewport, which an on-screen keyboard shortens. */
  const keyboard = {
    viewport: null as (EventTarget & { height: number }) | null,
    install() {
      this.viewport = Object.assign(new EventTarget(), {
        height: window.innerHeight,
        offsetTop: 0,
        scale: 1,
      });
      Object.defineProperty(window, "visualViewport", {
        configurable: true,
        value: this.viewport,
      });
    },
    open() {
      this.viewport!.height = window.innerHeight - 300;
      this.viewport!.dispatchEvent(new Event("resize"));
    },
    close() {
      this.viewport!.height = window.innerHeight;
      this.viewport!.dispatchEvent(new Event("resize"));
    },
    remove() {
      Reflect.deleteProperty(window, "visualViewport");
      this.viewport = null;
    },
  };
  async function opened(scriptPlaces = false) {
    phoneGeometry();
    await mount(
      (source) => {
        if (scriptPlaces) source.scriptPlaces();
        return `/tasks/${waiting}`;
      },
      {
        width: 390,
        mock: { subagents: "absent", automations: "absent" },
      },
    );
    await vi.waitFor(
      () =>
        expect(
          document.querySelector(".composer-dock [data-composer-input]"),
          "The scoped conversation never mounted its composer",
        ).not.toBeNull(),
      { timeout: 1500 },
    );
    expect(page() ?? folded(), "The Run was already in a place").toBeNull();
  }
  function browserPlace(title: string) {
    return placeList(client.getSnapshot()).find(
      (item) => item.kind === "page" && item.availability === "ready" && item.title === title,
    )!;
  }
  async function acts(title = "Coffee shortlist") {
    const place = browserPlace(title);
    await act(async () => client.actInPlace(waiting, place.key));
    await vi.waitFor(
      () => expect(page() ?? folded(), "The Run's page never showed").not.toBeNull(),
      { timeout: 1500 },
    );
    return place;
  }

  it("opens on the first action, folds into the head, unfolds, shows the full tab and ends with the Run", async () => {
    await opened(true);
    // A hardware keyboard takes no room: writing in a narrow window still lets it open.
    act(() => element<HTMLElement>(".composer-dock [data-composer-input]").focus());
    const place = browserPlace("Coffee shortlist");
    act(() => client.actInPlace(waiting, place.key));
    await vi.waitFor(() => expect(page(), "The first place picture did not open").not.toBeNull(), {
      timeout: 1500,
    });
    expect(folded(), "The head kept a picture of the open page").toBeNull();

    act(() => element<HTMLElement>(".run-page__handle").click());
    expect(page()).toBeNull();
    expect(folded()?.getAttribute("aria-expanded")).toBe("false");

    act(() => folded()!.click());
    expect(page()).not.toBeNull();
    // Folding and unfolding never navigate.
    expect(history.at(-1)).toMatchObject({ path: `/tasks/${waiting}`, search: "" });

    // The Run moving to another page keeps it open, on that page.
    const next = browserPlace("Your reading list");
    act(() => client.actInPlace(waiting, next.key));
    expect(element(".run-page__view").getAttribute("aria-label")).toContain(next.title);
    act(() => client.actInPlace(waiting, place.key));

    act(() => element<HTMLElement>(".run-page__view").click());
    expect(placeParams(history.at(-1)!.search)).toBe(placeParams(tabSearch(place)));
    act(() => {
      void goTo!(`/tasks/${waiting}`);
    });
    expect(page(), "Coming back, the page was no longer open").not.toBeNull();

    await act(async () => client.stopRun(waiting));
    expect(page() ?? folded(), "The page outlived its Run").toBeNull();
  });

  /** A bar so narrow that only its sidebar button and name fit: whatever else is still drawn at its end runs past it. */
  function narrowBar() {
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
  }

  it("a head with no room for the folded picture leaves the page its row, and Find under the name", async () => {
    narrowBar();
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

  it("wider than a phone, a head with no room for the picture shows the place as its row", async () => {
    narrowBar();
    await mount(`/tasks/${waiting}`);
    // A transcript that scrolls, so the reader is at its foot when the tab opens.
    phoneGeometry();
    const place = browserPlace("Coffee shortlist");
    await act(async () => client.actInPlace(waiting, place.key));
    await vi.waitFor(
      () => expect(folded()?.closest("[data-yielded]"), "The head kept the picture").not.toBeNull(),
      { timeout: 1500 },
    );
    const row = element(".run-page__view--row");
    expect(document.querySelector(".run-page__handle")).toBeNull();
    // The conversation still holds the picture the row shows.
    await vi.waitFor(() => expect(row.querySelector(".viewfinder__glyph")).toBeNull(), {
      timeout: 1500,
    });
    await click(row);
    expect(placeParams(history.at(-1)!.search)).toBe(placeParams(tabSearch(place)));
  });

  it("on a touch screen, a keyboard put away without leaving the field lets the page open", async () => {
    keyboard.install();
    try {
      await mount(`/tasks/${waiting}`, { width: 390, touch: true });
      phoneGeometry();
      await act(async () => element<HTMLElement>(".composer-dock [data-composer-input]").focus());
      await act(async () => keyboard.open());
      // Android's Back puts the keyboard away and leaves the field focused.
      await act(async () => keyboard.close());
      await acts();
      await vi.waitFor(
        () => expect(page(), "The page waited for a keyboard that had gone").not.toBeNull(),
        { timeout: 1500 },
      );
    } finally {
      keyboard.remove();
    }
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
      // On a phone: the field takes focus and the on-screen keyboard takes room.
      // A hardware keyboard takes none, so focus alone never folds the page.
      "typing",
      async () => {
        await act(async () => element<HTMLElement>(".composer-dock [data-composer-input]").focus());
        await act(async () => keyboard.open());
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
    keyboard.install();
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
      keyboard.remove();
    }
  });
});

describe("a conversation's foot", () => {
  const task = "thr_00000000-0000-4000-8000-000000000902";
  /**
   * The transcript scrolls a 400px window of `content`, clamped as a browser
   * clamps it; the rest of the layout is not measured.
   */
  function transcriptGeometry(geometry: { content: number }) {
    const tops = new WeakMap<Element, number>();
    const max = () => geometry.content - 400;
    const size = (element: Element, key: "clientHeight" | "scrollHeight") =>
      element.classList.contains("transcript-scroll")
        ? { clientHeight: 400, scrollHeight: geometry.content }[key]
        : 0;
    for (const key of ["clientHeight", "scrollHeight"] as const)
      vi.spyOn(HTMLElement.prototype, key, "get").mockImplementation(function (this: HTMLElement) {
        return size(this, key);
      });
    vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(function (this: Element) {
      return Math.min(tops.get(this) ?? 0, Math.max(0, max()));
    });
    vi.spyOn(Element.prototype, "scrollTop", "set").mockImplementation(function (
      this: Element,
      top: number,
    ) {
      tops.set(this, Math.max(0, Math.min(top, max())));
    });
  }
  const scrollTo = (scroller: HTMLElement, top: number) =>
    act(async () => {
      scroller.scrollTop = top;
      scroller.dispatchEvent(new Event("scroll"));
    });
  const arrives = (body: string) =>
    act(async () => {
      await client.dispatch({
        type: "thread.sendMessage",
        threadId: task,
        content: [{ type: "text", text: body }],
        delivery: "queue",
        idempotencyKey: `foot-${body}`,
      });
    });

  it("lets go at the reader's first scroll up, however near the foot, and never pulls them back", async () => {
    await mount(`/tasks/${task}`);
    const geometry = { content: 2000 };
    transcriptGeometry(geometry);
    const scroller = element<HTMLElement>(".transcript-scroll");
    // The first scroll after a resize only takes the new geometry in; the second reaches the foot.
    for (const _ of [1, 2]) await scrollTo(scroller, 1600);
    geometry.content = 2100;
    await arrives("The first reply");
    expect(scroller.scrollTop, "A reader at the foot was not kept there").toBe(1700);

    await scrollTo(scroller, 1670);
    geometry.content = 2200;
    await arrives("The second reply");
    expect(scroller.scrollTop, "A reader 30px up was pulled back to the foot").toBe(1670);
    expect(element(".transcript__jump")).not.toBeNull();

    // Back at the foot, they follow again; a scroll up landing with new content is still theirs.
    await scrollTo(scroller, 1800);
    geometry.content = 2300;
    await arrives("The third reply");
    expect(scroller.scrollTop).toBe(1900);
    geometry.content = 2400;
    await scrollTo(scroller, 1850);
    expect(scroller.scrollTop, "A scroll up beside a reflow was taken for the reflow").toBe(1850);
  });

  it("tells the Host the row in view as the reader scrolls, and puts that row back where it stood after a repair", async () => {
    // The Host's repairs of this conversation, as its reader counts them.
    let repairs = 0;
    const long = "thr_00000000-0000-4000-8000-000000000005";
    let anchors!: { readonly mock: { readonly calls: readonly unknown[][] } };
    const watch = (source: MockHostClient) => {
      const real = source.getThreadTranscript.bind(source);
      const views = new WeakMap<object, Map<number, object>>();
      vi.spyOn(source, "getThreadTranscript").mockImplementation((threadId) => {
        const view = real(threadId);
        return {
          subscribe: view.subscribe,
          getSnapshot: () => {
            const current = view.getSnapshot();
            const held = views.get(current) ?? new Map<number, object>();
            views.set(current, held);
            if (!held.has(repairs)) held.set(repairs, { ...current, repairs });
            return held.get(repairs) as typeof current;
          },
        };
      });
      anchors = vi.spyOn(source, "setTranscriptAnchor");
      return source;
    };
    await mount(`/tasks/${long}`, { hostClient: watch });
    const scroller = element<HTMLElement>(".transcript-scroll");
    const rows = () => [...scroller.querySelectorAll("[data-transcript-row]:not(:empty)")];
    expect(rows().length, "The conversation has too few rows to scroll").toBeGreaterThan(1);
    // Each row is 100px tall; `above` is what a repair adds over them.
    const geometry = { content: rows().length * 100 + 400, above: 0 };
    transcriptGeometry(geometry);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      const index = rows().indexOf(this);
      const top = index < 0 ? 0 : geometry.above + index * 100 - scroller.scrollTop;
      return { top, bottom: index < 0 ? 400 : top + 100, height: index < 0 ? 400 : 100 } as DOMRect;
    });
    const frame = () =>
      act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    for (const _ of [1, 2]) await scrollTo(scroller, geometry.content);
    await frame();
    expect(anchors.mock.calls.at(-1), "A reader at the foot is at the latest").toEqual([
      long,
      undefined,
    ]);

    // The reader scrolls up to stand 30px into the second row.
    await scrollTo(scroller, 130);
    await frame();
    const reading = anchors.mock.calls.at(-1);
    expect(reading?.[0]).toBe(long);
    expect(reading?.[1], "The row in view was not told to the Host").toEqual(expect.any(String));

    // A repair lays the conversation out again with 300px more above that row.
    geometry.above = 300;
    geometry.content += 300;
    repairs = 1;
    await act(async () => {
      await client.dispatch({
        type: "thread.sendMessage",
        threadId: long,
        content: [{ type: "text", text: "Arrived with the repair" }],
        delivery: "queue",
        idempotencyKey: "repair-arrival",
      });
    });
    expect(scroller.scrollTop, "The repair moved the reader off their row").toBe(430);
    expect(element(".transcript__jump")).not.toBeNull();
  });
});
