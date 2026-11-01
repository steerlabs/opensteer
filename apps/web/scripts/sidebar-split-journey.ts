/**
 * The line between the sidebar's Tasks and Tabs, in headless Chromium against
 * the mock Host: the production web build; real pointer, keyboard and window
 * input; every frame of a drag checked for rows shown in part and for React
 * renders; the split kept across a reload; screenshots and a video.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { BrowserContext, Page } from "playwright-core";
import { expectThat, finishJourney, journeyChecks, openMockWeb } from "./mock-web-journey.js";

const artifactDirectory = path.resolve(
  process.env.OPENSTEER_SIDEBAR_SPLIT_EVIDENCE_DIR ??
    path.join(tmpdir(), "opensteer-sidebar-split-evidence"),
);
await mkdir(artifactDirectory, { recursive: true });
const { checks, check, abort } = journeyChecks();
const web = await openMockWeb("opensteer-sidebar-split-web");
const shareKey = "opensteer.sidebar-tasks-share";

/**
 * What a frame must never show, found in the page so a frame loop can use it
 * too: a row in part at either edge of Tasks or at Tabs' top (but at Tabs'
 * end, where its last row stands whole on the footer's line instead), or,
 * Tabs being longer than its room, any band between Tabs and the footer's
 * line (Tabs, last, runs to it; a row in part under that line is the cue
 * there is more).
 */
const partsScript = `globalThis.__splitParts = () => {
  const parts = [];
  const footer = document.querySelector(".sidebar__footer").getBoundingClientRect().top;
  for (const list of document.querySelectorAll(
    ".side-section--tasks .side-list, .side-section--tabs .side-list",
  )) {
    const tabs = !list.closest(".side-section--tasks");
    const end = tabs && list.scrollTop >= list.scrollHeight - list.clientHeight - 1;
    // The window inside the list's edge lines, to the fraction of a pixel it is laid out in.
    const box = list.getBoundingClientRect();
    const style = getComputedStyle(list);
    const top = box.top + parseFloat(style.borderTopWidth);
    const bottom = box.bottom - parseFloat(style.borderBottomWidth);
    if (tabs && list.scrollHeight > list.clientHeight + 0.5 && Math.abs(footer - box.bottom) > 0.5)
      parts.push({ list: "tabs", band: footer - box.bottom });
    for (const row of list.children) {
      const r = row.getBoundingClientRect();
      if (r.height < 2) continue;
      const seen = Math.min(r.bottom, bottom) - Math.max(r.top, top);
      if (seen > 0.5 && ((r.top < top - 0.5 && !end) || (!tabs && r.bottom > bottom + 0.5)))
        parts.push({
          list: list.closest(".side-section--tasks") ? "tasks" : "tabs",
          top: r.top - top,
          bottom: r.bottom - top,
          window: bottom - top,
          scrollTop: list.scrollTop,
          maxHeight: list.style.maxHeight,
          cut: list.style.getPropertyValue("--side-cut"),
          moving: [...document.querySelectorAll(".side-list")].map((each) =>
            each.hasAttribute("data-moving") || each.hasAttribute("data-sorting"),
          ),
          share: document
            .querySelector(".sidebar__lists")
            .style.getPropertyValue("--side-tasks-share"),
        });
    }
  }
  return parts;
};`;

interface ListState {
  /** Rows wholly in view. */
  readonly whole: number;
  /** Rows in view only in part where none may be: either edge of Tasks, Tabs' top. */
  readonly parts: number;
  /** The height of each row beyond the window's foot, in order. */
  readonly below: readonly number[];
  readonly overflows: boolean;
  /** Where the list stands and the rows shown in part, top and foot from the window's top. */
  readonly scrollTop: number;
  readonly window: number;
  readonly partRows: readonly (readonly [number, number])[];
}

interface Layout {
  readonly share: number;
  readonly stored: string | null;
  readonly line: { readonly x: number; readonly y: number; readonly fixed: boolean } | null;
  readonly valueNow: number | null;
  readonly room: number;
  readonly unused: number;
  readonly tasksHeight: number;
  /** Blank height under Tasks' last row in view, inside its section. */
  readonly tasksGap: number;
  readonly tabsHeight: number;
  /** From Tabs' foot to the footer's line: none while Tabs is longer than its room. */
  readonly tabsBand: number;
  readonly tasksFloor: number;
  readonly tabsFloor: number;
  readonly tasks: ListState;
  readonly tabs: ListState;
  /** The open task's row, when it is in the list: wholly in view or not. */
  readonly openInView: boolean | null;
}

async function layout(page: Page): Promise<Layout> {
  return page.evaluate((key) => {
    // Tabs, last, may show a row in part at its foot, under the footer's line, or at its
    // top once scrolled to its end.
    const listState = (selector: string, footOpen: boolean) => {
      const list = document.querySelector<HTMLElement>(selector);
      if (!list)
        return {
          whole: 0,
          parts: 0,
          below: [],
          overflows: false,
          scrollTop: 0,
          window: 0,
          partRows: [],
        };
      const box = list.getBoundingClientRect();
      const style = getComputedStyle(list);
      const top = box.top + parseFloat(style.borderTopWidth);
      const bottom = box.bottom - parseFloat(style.borderBottomWidth);
      let whole = 0;
      let parts = 0;
      const below: number[] = [];
      const partRows: [number, number][] = [];
      for (const row of list.children) {
        const r = row.getBoundingClientRect();
        if (r.height < 2) continue;
        if (r.top >= bottom - 0.5) below.push(r.height);
        const seen = Math.min(r.bottom, bottom) - Math.max(r.top, top);
        if (seen <= 0.5) continue;
        if (r.top >= top - 0.5 && r.bottom <= bottom + 0.5) whole++;
        else if (
          footOpen &&
          (r.top >= top - 0.5 || list.scrollTop >= list.scrollHeight - list.clientHeight - 1)
        )
          continue;
        else {
          parts++;
          partRows.push([r.top - top, r.bottom - top]);
        }
      }
      return {
        whole,
        parts,
        below,
        overflows: list.scrollHeight > list.clientHeight + 0.5,
        scrollTop: list.scrollTop,
        window: bottom - top,
        partRows,
      };
    };
    const lists = document.querySelector<HTMLElement>(".sidebar__lists")!;
    const tasks = document.querySelector<HTMLElement>(".side-section--tasks")!;
    const tabs = document.querySelector<HTMLElement>(".side-section--tabs")!;
    const footer = document.querySelector<HTMLElement>(".sidebar__footer")!;
    const line = document.querySelector<HTMLElement>(".side-split");
    const lineBox = line?.getBoundingClientRect();
    const room = footer.getBoundingClientRect().top - tasks.getBoundingClientRect().top;
    const tasksHeight = tasks.getBoundingClientRect().height;
    const tabsHeight = tabs.getBoundingClientRect().height;
    const tasksList = tasks.querySelector<HTMLElement>(".side-list");
    const open = tasksList?.querySelector<HTMLElement>("[aria-current]")?.closest("li");
    let openInView: boolean | null = null;
    if (open && tasksList) {
      const view = tasksList.getBoundingClientRect();
      const style = getComputedStyle(tasksList);
      const r = open.getBoundingClientRect();
      openInView =
        r.top >= view.top + parseFloat(style.borderTopWidth) - 0.5 &&
        r.bottom <= view.bottom - parseFloat(style.borderBottomWidth) + 0.5;
    }
    return {
      share: Number(lists.style.getPropertyValue("--side-tasks-share")),
      stored: localStorage.getItem(key),
      line: lineBox
        ? {
            x: lineBox.left + lineBox.width / 2,
            y: lineBox.top,
            fixed: line!.hasAttribute("data-fixed"),
          }
        : null,
      valueNow: line ? Number(line.getAttribute("aria-valuenow")) : null,
      room,
      unused: room - tasksHeight - tabsHeight,
      tasksHeight,
      tasksGap: tasksList
        ? tasks.getBoundingClientRect().bottom - tasksList.getBoundingClientRect().bottom
        : 0,
      tabsHeight,
      tabsBand:
        footer.getBoundingClientRect().top -
        tabs.querySelector<HTMLElement>(".side-list")!.getBoundingClientRect().bottom,
      tasksFloor: parseFloat(getComputedStyle(tasks).minHeight),
      tabsFloor: parseFloat(getComputedStyle(tabs).minHeight),
      tasks: listState(".side-section--tasks .side-list", false),
      tabs: listState(".side-section--tabs .side-list", true),
      openInView,
    };
  }, shareKey);
}

async function settle(page: Page) {
  // Spinners loop forever; only the slides and fades that end are waited for.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) =>
          Number.isFinite(Number(animation.effect?.getComputedTiming().endTime)),
        )
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
  await page.waitForTimeout(250);
}

/**
 * Samples every frame while `run` acts (rows shown in part, where the line
 * stands), and counts, as React commits them, the sidebar's renders and all
 * commits while the line is held (the render that keeps the share at the
 * release comes after it).
 */
async function frames(page: Page, run: () => Promise<void>) {
  // The world is still first, so a render counted is one the gesture causes. The task
  // list's minute clock renders the sidebar on each minute (task states age), so a
  // gesture, always done in seconds, starts clear of one.
  await quiet(page);
  const untilMinute = await page.evaluate(() => 60_000 - (Date.now() % 60_000));
  if (untilMinute < 10_000) await page.waitForTimeout(untilMinute + 500);
  const counts = () =>
    page.evaluate(() => {
      const held = globalThis as unknown as {
        __heldCommits?: number;
        __heldSidebarRenders?: number;
      };
      return { commits: held.__heldCommits ?? 0, renders: held.__heldSidebarRenders ?? 0 };
    });
  const before = await counts();
  // The Host's updates wait until the gesture ends, so a sidebar render counted is the gesture's.
  await page.evaluate(() => (Reflect.get(globalThis, "__holdHost") as () => void)());
  await page.evaluate(() => {
    const state = {
      on: true,
      frames: 0,
      partFrames: 0,
      worstParts: 0,
      lines: [] as number[],
      firstPart: null as { frame: number; resizing: boolean; rows: unknown[] } | null,
    };
    Reflect.set(window, "__splitFrames", state);
    const parts = Reflect.get(globalThis, "__splitParts") as () => unknown[];
    const tick = () => {
      if (!state.on) return;
      const rows = parts();
      const seen = rows.length;
      state.frames++;
      if (seen > 0) state.partFrames++;
      if (seen > 0 && state.firstPart === null)
        state.firstPart = {
          frame: state.frames,
          resizing: !!document.querySelector(".side-split[data-resizing]"),
          rows,
        };
      state.worstParts = Math.max(state.worstParts, seen);
      const line = document.querySelector(".side-split")?.getBoundingClientRect().top;
      if (line !== undefined && state.lines.at(-1) !== line) state.lines.push(line);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  try {
    await run();
  } finally {
    await page.evaluate(() => (Reflect.get(globalThis, "__releaseHost") as () => void)());
  }
  const after = await counts();
  return page.evaluate(
    ({ commits, sidebarRenders }) => {
      const state = Reflect.get(window, "__splitFrames") as {
        on: boolean;
        frames: number;
        partFrames: number;
        worstParts: number;
        lines: number[];
        firstPart: { frame: number; resizing: boolean; rows: unknown[] } | null;
      };
      state.on = false;
      return {
        firstPart: state.firstPart,
        frames: state.frames,
        partFrames: state.partFrames,
        worstParts: state.worstParts,
        lineStops: state.lines.length,
        commits,
        sidebarRenders,
        renderLog: (
          (globalThis as unknown as { __sidebarRenderLog?: unknown[] }).__sidebarRenderLog ?? []
        ).slice(-4),
      };
    },
    { commits: after.commits - before.commits, sidebarRenders: after.renders - before.renders },
  );
}

/** Presses the line, moves it `dy` in small steps, runs `during`, then releases. */
async function dragLine(
  page: Page,
  dy: number,
  options: { readonly during?: () => Promise<unknown>; readonly steps?: number } = {},
) {
  const { line } = await layout(page);
  if (!line) throw new Error("No line between Tasks and Tabs.");
  // Inside the grip, which reaches a few pixels either side of the line.
  const start = { x: line.x, y: line.y + 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y + dy, { steps: options.steps ?? 24 });
  await page.waitForTimeout(120);
  await options.during?.();
  await page.mouse.up();
  await settle(page);
}

/**
 * Presses the line and moves it through each offset from where it was
 * pressed in turn, running `between` after the first, then releases.
 */
async function holdLine(page: Page, offsets: readonly number[], between?: () => Promise<unknown>) {
  const { line } = await layout(page);
  if (!line) throw new Error("No line between Tasks and Tabs.");
  const start = { x: line.x, y: line.y + 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (const [index, offset] of offsets.entries()) {
    await page.mouse.move(start.x, start.y + offset, { steps: 8 });
    await page.waitForTimeout(80);
    if (index === 0) await between?.();
  }
  await page.mouse.up();
  await settle(page);
}

/** The rows the list shows below its foot that a move of `dy` brings into view, the nearest edge winning. */
function rowsBroughtIn(below: readonly number[], dy: number): number {
  let best = 0;
  let bestDistance = Math.abs(dy);
  let height = 0;
  below.forEach((row, index) => {
    height += row + 1;
    if (Math.abs(height - dy) < bestDistance) {
      best = index + 1;
      bestDistance = Math.abs(height - dy);
    }
  });
  return best;
}

async function openWorld(
  options: {
    readonly world?: "busy" | "stress";
    readonly height?: number;
    readonly width?: number;
    readonly video?: string;
  } = {},
) {
  const width = options.width ?? 1440;
  const height = options.height ?? 1000;
  const context: BrowserContext = await web.browser.newContext({
    viewport: { width, height },
    ...(options.video
      ? {
          recordVideo: {
            dir: path.join(artifactDirectory, `video-${options.video}`),
            size: { width, height },
          },
        }
      : {}),
  });
  await context.route(
    (url) => url.origin !== web.origin,
    (route) => route.fulfill({ body: "", status: 204 }),
  );
  // tsx keeps function names with a helper the page lacks; page functions here define functions.
  await context.addInitScript("globalThis.__name = (value) => value;");
  await context.addInitScript(partsScript);
  // The mock Host's updates can be held back while a gesture is measured, so every
  // sidebar render then is one the gesture causes; released, they all arrive.
  await context.addInitScript(`(() => {
    let client = null;
    const held = { on: false, waiting: new Set() };
    globalThis.__holdHost = () => { held.on = true; };
    globalThis.__releaseHost = () => {
      held.on = false;
      const waiting = [...held.waiting];
      held.waiting.clear();
      for (const listener of waiting) listener();
    };
    Object.defineProperty(window, "opensteerMock", {
      configurable: true,
      get() { return client; },
      set(value) {
        client = value;
        const subscribe = value.subscribe;
        value.subscribe = (listener) =>
          subscribe(() => (held.on ? held.waiting.add(listener) : listener()));
      },
    });
  })();`);
  // React reports every commit to a DevTools hook. The journey counts them, and the
  // Sidebar's own renders as React DevTools tells them: a new fiber that performed
  // work. Other parts of the app may commit while the line moves; the sidebar may not.
  await context.addInitScript(`(() => {
    let sidebar = null;
    const owner = (root) => {
      const nav = document.getElementById("app-sidebar");
      const stack = [root.current];
      while (stack.length) {
        const fiber = stack.pop();
        if (fiber.stateNode === nav) {
          let up = fiber.return;
          while (up && typeof up.type !== "function") up = up.return;
          return up;
        }
        if (fiber.sibling) stack.push(fiber.sibling);
        if (fiber.child) stack.push(fiber.child);
      }
      return null;
    };
    globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true, renderers: new Map(), inject() { return 1; },
      onCommitFiberRoot(_, root) {
        globalThis.__commits = (globalThis.__commits ?? 0) + 1;
        const held = !!document.querySelector(".side-split[data-resizing]");
        if (held) globalThis.__heldCommits = (globalThis.__heldCommits ?? 0) + 1;
        const next = owner(root);
        // PerformedWork is React's flag 1.
        if (next && next !== sidebar && (next.flags & 1) === 1) {
          globalThis.__sidebarRenders = (globalThis.__sidebarRenders ?? 0) + 1;
          if (held) globalThis.__heldSidebarRenders = (globalThis.__heldSidebarRenders ?? 0) + 1;
          // Which of its hooks changed, by position, for a render the journey did not expect.
          const changed = [];
          let hook = next.memoizedState;
          let was = next.alternate?.memoizedState ?? null;
          for (let index = 0; hook; index++, hook = hook.next, was = was?.next ?? null)
            if (!was || hook.memoizedState !== was.memoizedState) {
              const value = hook.memoizedState;
              changed.push(
                held
                  ? [index, value && typeof value === "object" ? Object.keys(value).slice(0, 8).join(",") : String(value).slice(0, 60)]
                  : index,
              );
            }
          (globalThis.__sidebarRenderLog ??= []).push({
            at: Math.round(performance.now()),
            held,
            changed,
          });
        }
        sidebar = next;
      },
      onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {},
    };
  })();`);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${web.origin}/${options.world ? `?mock-world=${options.world}` : ""}`);
  await ready(page);
  return { context, page, errors };
}

/** Waits until React has committed nothing for a second (at most ten). */
async function quiet(page: Page) {
  const commits = () =>
    page.evaluate(() => (globalThis as unknown as { __commits?: number }).__commits ?? 0);
  for (let last = -1, tries = 0; tries < 10; tries++) {
    const now = await commits();
    if (now === last) return;
    last = now;
    await page.waitForTimeout(1000);
  }
}

/** Loaded, the world's own motion stopped, and the lists fitted. */
async function ready(page: Page) {
  await page.locator(".side-section--tabs .side-list > li").first().waitFor();
  await page.locator(".side-section--tasks .side-list > li").first().waitFor();
  // The world stops moving on its own, so every change is one a check makes.
  await page.evaluate(() =>
    (Reflect.get(window, "opensteerMock") as { scriptPlaces(): unknown }).scriptPlaces(),
  );
  // Icons and the like finish loading first.
  const commits = () =>
    page.evaluate(() => (globalThis as unknown as { __commits?: number }).__commits ?? 0);
  for (let last = -1, tries = 0; tries < 20; tries++) {
    const now = await commits();
    if (now === last) break;
    last = now;
    await page.waitForTimeout(500);
  }
  await settle(page);
}

const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(artifactDirectory, name) });

/**
 * Tasks at its floor: at least three short rows' height, ending at the foot
 * of a row (taller rows of tasks that need the reader fit fewer), no blank
 * under it.
 */
function atFloor(state: Layout, step: string) {
  expectThat(
    {
      step,
      whole: state.tasks.whole,
      height: state.tasksHeight,
      floor: state.tasksFloor,
      gap: state.tasksGap,
    },
    state.tasks.whole >= 1 &&
      state.tasksHeight >= state.tasksFloor - 0.5 &&
      state.tasksHeight < state.tasksFloor + 69 &&
      state.tasksGap < 1,
    `${step}: Tasks did not stop at its floor, flush with a row`,
  );
}

/** The share the line kept gives Tasks what it shows, a row's foot, and no more. */
function keptAsShown(state: Layout, step: string) {
  const kept = (state.share / 10000) * state.room;
  expectThat(
    { step, kept, height: state.tasksHeight, share: state.share, stored: state.stored },
    kept >= state.tasksHeight - 0.5 &&
      kept < state.tasksHeight + 1 &&
      state.stored === String(state.share),
    `${step}: the kept share is not what Tasks shows`,
  );
}

/** Rows shown in part where none may be, or a band over the footer, as a check would report them. */
function noParts(state: Layout, step: string) {
  expectThat(
    { step, tasks: state.tasks, tabs: state.tabs },
    state.tasks.parts === 0 && state.tabs.parts === 0,
    `${step}: a row shows in part`,
  );
  expectThat(
    { step, band: state.tabsBand, overflows: state.tabs.overflows },
    !state.tabs.overflows || Math.abs(state.tabsBand) < 0.5,
    `${step}: Tabs stops short of the footer's line`,
  );
}

try {
  const { context, page, errors } = await openWorld({ world: "busy", video: "main" });
  const even = await layout(page);

  await check("the sidebar opens split evenly, every row whole, the line ready", async () => {
    await page.mouse.move(even.line!.x, even.line!.y + 2);
    await page.waitForTimeout(150);
    const state = await layout(page);
    const separator = page.getByRole("separator", { name: "Resize Tasks and Tabs" });
    const cursor = await separator.evaluate((node) => getComputedStyle(node).cursor);
    await shot(page, "01-even.png");
    expectThat(
      { state },
      state.share === 5000 && state.valueNow === 50 && state.stored === null,
      "the sidebar did not open at an even split",
    );
    expectThat(
      { tasks: state.tasks, tabs: state.tabs },
      state.tasks.overflows && state.tabs.overflows,
      "this journey needs both lists longer than the sidebar",
    );
    noParts(state, "opening");
    expectThat(
      { fixed: state.line?.fixed, cursor },
      state.line?.fixed === false && cursor === "row-resize",
      "the line does not offer to move",
    );
    return { state, cursor };
  });

  const dy = 80;
  let dragged: Layout | null = null;
  await check(
    "dragging the line down stops at the row edge nearest the pointer, whole in every frame, with no render",
    async () => {
      const sidebarRenders = () =>
        page.evaluate(
          () => (globalThis as unknown as { __sidebarRenders?: number }).__sidebarRenders ?? 0,
        );
      const before = await layout(page);
      const rendersBefore = await sidebarRenders();
      const stats = await frames(page, () =>
        dragLine(page, dy, { during: () => shot(page, "02-dragging.png") }),
      );
      const after = await layout(page);
      const released = (await sidebarRenders()) - rendersBefore;
      dragged = after;
      const brought = rowsBroughtIn(before.tasks.below, dy);
      expectThat({ stats }, stats.partFrames === 0, "a frame painted a row in part");
      expectThat(
        { stats },
        stats.sidebarRenders === 0,
        "the sidebar rendered while the line moved",
      );
      // The release keeps the share, which renders the sidebar: proof the count sees its renders.
      expectThat({ released }, released >= 1, "the sidebar's renders went uncounted");
      expectThat(
        { before: before.tasks, after: after.tasks, brought },
        brought > 0 && after.tasks.whole === before.tasks.whole + brought,
        "Tasks did not gain the rows nearest the pointer",
      );
      expectThat(
        { before: before.tabs.whole, after: after.tabs.whole },
        after.tabs.whole < before.tabs.whole,
        "Tabs did not give up the height Tasks took",
      );
      expectThat(
        { room: [before.room, after.room], unused: after.unused },
        Math.abs(after.room - before.room) < 0.5 && Math.abs(after.unused) < 0.5,
        "the two sections no longer fill the room between them",
      );
      expectThat(
        { share: after.share, stored: after.stored, valueNow: after.valueNow },
        after.share > 5000 &&
          after.stored === String(after.share) &&
          after.valueNow === Math.round(after.share / 100),
        "the new share was not kept once, as shown",
      );
      keptAsShown(after, "after the drag");
      noParts(after, "after the drag");
      return {
        stats,
        brought,
        before: before.tasks.whole,
        after: after.tasks.whole,
        share: after.share,
      };
    },
  );

  await check("the split comes back exactly after a reload", async () => {
    const before = dragged ?? (await layout(page));
    await page.reload();
    await ready(page);
    const after = await layout(page);
    await shot(page, "03-after-reload.png");
    expectThat(
      {
        before: [before.share, before.tasksHeight, before.tasks.whole],
        after: [after.share, after.tasksHeight, after.tasks.whole],
      },
      after.share === before.share &&
        Math.abs(after.tasksHeight - before.tasksHeight) < 0.5 &&
        after.tasks.whole === before.tasks.whole &&
        after.tabs.whole === before.tabs.whole,
      "the reload did not restore the split",
    );
    noParts(after, "after the reload");
    return { share: after.share, tasks: after.tasks.whole, tabs: after.tabs.whole };
  });

  await check(
    "pulled far up, Tasks stops at its first three rows and keeps only what it showed",
    async () => {
      const stats = await frames(page, () => dragLine(page, -900, { steps: 40 }));
      const state = await layout(page);
      await shot(page, "04-tasks-floor.png");
      expectThat(
        { stats },
        stats.partFrames === 0 && stats.sidebarRenders === 0,
        "the drag painted a row in part or rendered the sidebar",
      );
      atFloor(state, "pulled far up");
      // Nothing is left to give: another pull changes nothing.
      await dragLine(page, -300);
      const again = await layout(page);
      expectThat(
        { share: [state.share, again.share], height: [state.tasksHeight, again.tasksHeight] },
        again.share === state.share && Math.abs(again.tasksHeight - state.tasksHeight) < 0.5,
        "a pull past the floor moved the line",
      );
      keptAsShown(state, "at Tasks' floor");
      noParts(state, "at Tasks' floor");
      return { share: state.share, height: state.tasksHeight, stats };
    },
  );

  let lowest: Layout | null = null;
  await check(
    "pulled far down, Tabs keeps its first three rows and Tasks takes the rest, whole",
    async () => {
      const stats = await frames(page, () => dragLine(page, 900, { steps: 40 }));
      const state = await layout(page);
      lowest = state;
      await shot(page, "05-tabs-floor.png");
      expectThat(
        { stats },
        stats.partFrames === 0 && stats.sidebarRenders === 0,
        "the drag painted a row in part or rendered the sidebar",
      );
      // Tasks ends at a row's foot; Tabs, running to the footer, takes the rest of a taller row.
      expectThat(
        { tabs: state.tabs.whole, height: state.tabsHeight, floor: state.tabsFloor },
        state.tabs.whole >= 3 && state.tabsHeight < state.tabsFloor + 69,
        "Tabs did not stop at its floor",
      );
      expectThat(
        { unused: state.unused },
        Math.abs(state.unused) < 0.5,
        "Tasks and Tabs did not take all the room",
      );
      // Nothing is left to take: another pull changes nothing.
      await dragLine(page, 300);
      const again = await layout(page);
      expectThat(
        { share: [state.share, again.share], tasks: [state.tasks.whole, again.tasks.whole] },
        again.share === state.share && again.tasks.whole === state.tasks.whole,
        "a pull past the end moved the line",
      );
      keptAsShown(state, "at Tabs' floor");
      noParts(state, "at Tabs' floor");
      return { share: state.share, tasks: state.tasks.whole, tabs: state.tabs.whole, stats };
    },
  );

  await check("keys: ↑ and ↓ move one row, Home and End go as far as the rows allow", async () => {
    const line = page.getByRole("separator", { name: "Resize Tasks and Tabs" });
    await line.focus();
    const steps: Record<string, number> = {};
    const press = async (key: string) => {
      const stats = await frames(page, async () => {
        await page.keyboard.press(key);
        await settle(page);
      });
      const state = await layout(page);
      expectThat({ key, stats }, stats.partFrames === 0, `${key} painted a row in part`);
      noParts(state, key);
      keptAsShown(state, key);
      steps[key] = state.tasks.whole;
      return state;
    };
    const start = await layout(page);
    const up = await press("ArrowUp");
    expectThat(
      { start: start.tasks.whole, up: up.tasks.whole },
      up.tasks.whole === start.tasks.whole - 1,
      "↑ did not take one row from Tasks",
    );
    const down = await press("ArrowDown");
    expectThat(
      { up: up.tasks.whole, down: down.tasks.whole },
      down.tasks.whole === up.tasks.whole + 1,
      "↓ did not give one row back",
    );
    const home = await press("Home");
    atFloor(home, "Home");
    const end = await press("End");
    expectThat(
      { end: end.share, lowest: lowest?.share },
      lowest !== null && end.share === lowest.share,
      "End did not go as far as the pull down did",
    );
    // End is a row's edge like any other: a row up and back lands on the same share.
    await press("ArrowUp");
    const back = await press("ArrowDown");
    expectThat(
      { end: [end.share, end.tasksHeight], back: [back.share, back.tasksHeight] },
      back.share === end.share && Math.abs(back.tasksHeight - end.tasksHeight) < 0.5,
      "End kept a share the rows it shows do not give",
    );
    return steps;
  });

  await check("a double-click puts the split back to even", async () => {
    const { line } = await layout(page);
    await page.mouse.dblclick(line!.x, line!.y + 2);
    await settle(page);
    const state = await layout(page);
    // Where the list is scrolled decides which rows end it, and some are taller than others.
    expectThat(
      { share: state.share, stored: state.stored, tasks: [even.tasksHeight, state.tasksHeight] },
      state.share === 5000 &&
        state.stored === "5000" &&
        Math.abs(state.tasksHeight - even.tasksHeight) < 69,
      "the double-click did not restore the even split",
    );
    noParts(state, "after the reset");
    return { share: state.share };
  });

  await check(
    "the open task stays in view as Tasks shrinks, and a click by the line still opens a row",
    async () => {
      const lastWhole = await page.evaluate(() => {
        const list = document.querySelector<HTMLElement>(".side-section--tasks .side-list")!;
        const bottom =
          list.getBoundingClientRect().bottom -
          parseFloat(getComputedStyle(list).borderBottomWidth);
        const rows = [...list.children].filter(
          (row) => row.getBoundingClientRect().bottom <= bottom + 0.5,
        );
        return (rows.at(-1) as HTMLElement).dataset.threadId!;
      });
      // A click in the row's lower part, a few pixels above the line's grip.
      const row = page.locator(
        `.side-section--tasks [data-thread-id="${lastWhole}"] .side-task__main`,
      );
      const box = (await row.boundingBox())!;
      await page.mouse.click(box.x + 60, box.y + box.height - 5);
      await page.waitForFunction(
        (id) =>
          document
            .querySelector(`.side-section--tasks [data-thread-id="${id}"] .side-task__main`)
            ?.getAttribute("aria-current") === "page",
        lastWhole,
      );
      await settle(page);
      const stats = await frames(page, () => dragLine(page, -120));
      const state = await layout(page);
      await shot(page, "06-open-task-kept.png");
      expectThat(
        { openInView: state.openInView },
        state.openInView === true,
        "the open task left the list's view",
      );
      expectThat({ stats }, stats.partFrames === 0, "a frame painted a row in part");
      keptAsShown(state, "after shrinking past the open task");
      noParts(state, "after shrinking past the open task");
      return { openInView: state.openInView, stats };
    },
  );

  await check(
    "a drag that turns back, with the open task at Tasks' foot, keeps exactly what Tasks shows",
    async () => {
      // The open task at the foot: shrinking scrolls Tasks to keep it, so its rows move under the drag.
      await page.mouse.dblclick((await layout(page)).line!.x, (await layout(page)).line!.y + 2);
      await settle(page);
      const lastWhole = await page.evaluate(() => {
        const list = document.querySelector<HTMLElement>(".side-section--tasks .side-list")!;
        const bottom =
          list.getBoundingClientRect().bottom -
          parseFloat(getComputedStyle(list).borderBottomWidth);
        const rows = [...list.children].filter(
          (row) => row.getBoundingClientRect().bottom <= bottom + 0.5,
        );
        return (rows.at(-1) as HTMLElement).dataset.threadId!;
      });
      await page
        .locator(`.side-section--tasks [data-thread-id="${lastWhole}"] .side-task__main`)
        .click();
      await settle(page);
      const stats = await frames(page, () => holdLine(page, [-80, -160, -240, -160, -80, 0, 80]));
      const state = await layout(page);
      expectThat(
        { stats },
        stats.partFrames === 0 && stats.sidebarRenders === 0,
        "the drag painted a row in part or rendered the sidebar",
      );
      expectThat(
        { openInView: state.openInView },
        state.openInView === true,
        "the open task left the list's view",
      );
      keptAsShown(state, "after turning back");
      noParts(state, "after turning back");
      return { share: state.share, height: state.tasksHeight, stats };
    },
  );

  await check(
    "a window resized while the line is held keeps exactly what Tasks shows",
    async () => {
      // Released where it stood when the window changed: the share kept is of the new room.
      await holdLine(page, [-40], async () => {
        await page.setViewportSize({ width: 1440, height: 720 });
        await page.waitForTimeout(200);
      });
      const short = await layout(page);
      await page.setViewportSize({ width: 1440, height: 1000 });
      await settle(page);
      const back = await layout(page);
      keptAsShown(short, "after the held resize");
      noParts(short, "after the held resize");
      noParts(back, "back at full height");
      return { share: short.share, height: short.tasksHeight };
    },
  );

  await check(
    "a Host update while the line is held renders the sidebar and leaves the drag whole",
    async () => {
      const threadId = await page
        .locator(".side-section--tasks .side-list > li")
        .first()
        .getAttribute("data-thread-id");
      const title = "Renamed while the line was held";
      const before = await page.evaluate(
        () =>
          (globalThis as unknown as { __heldSidebarRenders?: number }).__heldSidebarRenders ?? 0,
      );
      await holdLine(page, [40, 80], () =>
        page.evaluate(
          ({ id, name }) =>
            (
              Reflect.get(window, "opensteerMock") as {
                renameThread(threadId: string, title: string): Promise<unknown>;
              }
            ).renameThread(id, name),
          { id: threadId!, name: title },
        ),
      );
      const state = await layout(page);
      const rendered =
        (await page.evaluate(
          () =>
            (globalThis as unknown as { __heldSidebarRenders?: number }).__heldSidebarRenders ?? 0,
        )) - before;
      const shown = await page
        .locator(`.side-section--tasks [data-thread-id="${threadId}"] .side-task__title`)
        .textContent();
      expectThat(
        { rendered, shown },
        rendered >= 1 && shown === title,
        "the Host's update did not reach the sidebar while the line was held",
      );
      keptAsShown(state, "after a Host update mid-drag");
      noParts(state, "after a Host update mid-drag");
      return { rendered, share: state.share };
    },
  );

  await check(
    "after the person scrolls Tasks, the line moves only with the pointer, a row's edge at a time",
    async () => {
      // From the even split and the list's top, a scroll that rests with a tall row across
      // Tasks' foot leaves a gap above the line.
      const reset = (await layout(page)).line!;
      await page.mouse.dblclick(reset.x, reset.y + 2);
      await settle(page);
      const list = page.locator(".side-section--tasks .side-list");
      const view = (await list.boundingBox())!;
      await page.mouse.move(view.x + view.width / 2, view.y + 20);
      await page.mouse.wheel(0, -4000);
      await page.waitForTimeout(600);
      await page.mouse.wheel(0, 73);
      await page.waitForTimeout(1000);
      const rested = await layout(page);
      expectThat(
        { gap: rested.tasksGap },
        rested.tasksGap > 0.5,
        "this check needs a scroll that rests with a gap above the line",
      );
      const nudged = await (async () => {
        await dragLine(page, 1);
        return layout(page);
      })();
      expectThat(
        { rested: [rested.line?.y, rested.share], nudged: [nudged.line?.y, nudged.share] },
        Math.abs(nudged.line!.y - rested.line!.y) < 0.5 &&
          nudged.share === rested.share &&
          nudged.stored === rested.stored,
        "a nudge moved the line or kept a share",
      );
      const stats = await frames(page, () => dragLine(page, 37));
      const down = await layout(page);
      expectThat(
        {
          before: rested.line?.y,
          after: down.line?.y,
          tasks: [rested.tasks.whole, down.tasks.whole],
        },
        down.line!.y > rested.line!.y + 0.5 && down.tasks.whole > rested.tasks.whole,
        "a row's drag down did not move the line down",
      );
      expectThat(
        { stats, rested: rested.tasks, down: down.tasks },
        stats.partFrames === 0,
        "a frame painted a row in part",
      );
      keptAsShown(down, "after the scrolled drag");
      noParts(down, "after the scrolled drag");
      return { gap: rested.tasksGap, moved: down.line!.y - rested.line!.y, stats };
    },
  );

  await check("Tabs' + by the line still opens a new tab", async () => {
    await page.getByRole("button", { name: "New tab", exact: true }).first().click();
    await page.locator(".side-tab--start").waitFor();
    await page.getByRole("button", { name: "Close New tab", exact: true }).click();
    await page.locator(".side-tab--start").waitFor({ state: "detached" });
    return { opened: true };
  });

  await check("a shorter window keeps the share and whole rows, floors included", async () => {
    const before = await layout(page);
    await page.setViewportSize({ width: 1440, height: 720 });
    await settle(page);
    const short = await layout(page);
    await shot(page, "07-short-window.png");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await settle(page);
    const back = await layout(page);
    expectThat(
      { share: [before.share, short.share, back.share] },
      short.share === before.share && back.share === before.share,
      "the window's size changed the share",
    );
    expectThat(
      { tasks: [short.tasksHeight, short.tasksFloor], tabs: [short.tabsHeight, short.tabsFloor] },
      short.tasksHeight >= short.tasksFloor - 0.5 && short.tabsHeight >= short.tabsFloor - 0.5,
      "a section fell below its floor",
    );
    // Proportional: Tasks' height is its share of the room within the floors, less the part row the fit takes off.
    const wanted = Math.min(
      short.room - short.tabsFloor,
      Math.max(short.tasksFloor, (short.share / 10000) * short.room),
    );
    expectThat(
      { wanted, height: short.tasksHeight },
      short.tasksHeight <= wanted + 0.5 && short.tasksHeight > wanted - 69,
      "Tasks did not keep its share of the shorter room",
    );
    noParts(short, "in the shorter window");
    noParts(back, "back at full height");
    return {
      short: { tasks: short.tasks.whole, tabs: short.tabs.whole },
      wanted,
      height: short.tasksHeight,
    };
  });

  await check(
    "search results and a collapsed sidebar take the line out of reach, and bring it back",
    async () => {
      await page.keyboard.press("Meta+k");
      const search = page.getByRole("combobox", { name: "Search tasks and tabs" });
      await search.waitFor();
      // Until there is a query the sections stand as they were; results cover them, the
      // sections still laid out underneath but unseen and out of reach.
      await search.fill("a");
      await page.getByRole("region", { name: "Search results" }).waitFor();
      const searching = await page.locator(".sidebar__lists").evaluate((lists) => ({
        inert: (lists as HTMLElement).inert,
        hidden: getComputedStyle(lists).visibility === "hidden",
        line: lists.querySelector(".side-split") !== null,
      }));
      await page.keyboard.press("Escape");
      await page.locator(".side-split").waitFor({ state: "attached" });
      await page.keyboard.press("Meta+\\");
      await page.locator("#app-sidebar.sidebar--collapsed").waitFor({ state: "attached" });
      const collapsed = await page.locator(".side-split").count();
      await page.keyboard.press("Meta+\\");
      await page.locator(".side-split").waitFor({ state: "attached" });
      await settle(page);
      const state = await layout(page);
      expectThat(
        { searching, collapsed },
        searching.inert && searching.hidden && searching.line && collapsed === 0,
        "the line stayed in reach",
      );
      noParts(state, "after the sidebar came back");
      return { searching, collapsed, share: state.share };
    },
  );

  expectThat({ errors }, errors.length === 0, `page errors: ${errors.join("; ")}`);
  await context.close();

  await check("with every row of both in view, the line neither lights nor moves", async () => {
    const tall = await openWorld({ height: 2000 });
    try {
      const state = await layout(tall.page);
      await tall.page.mouse.move(state.line!.x, state.line!.y + 2);
      await tall.page.waitForTimeout(150);
      const hovered = await layout(tall.page);
      const cursor = await tall.page
        .locator(".side-split")
        .evaluate((node) => getComputedStyle(node).cursor);
      await dragLine(tall.page, 120);
      const after = await layout(tall.page);
      await shot(tall.page, "08-all-in-view.png");
      expectThat(
        { tasks: state.tasks.overflows, tabs: state.tabs.overflows },
        !state.tasks.overflows && !state.tabs.overflows,
        "this check needs every row of both in view",
      );
      expectThat(
        { fixed: hovered.line?.fixed, cursor, stored: after.stored, share: after.share },
        hovered.line?.fixed === true &&
          cursor === "default" &&
          after.stored === null &&
          after.share === 5000,
        "the line offered to move, or moved",
      );
      expectThat({ errors: tall.errors }, tall.errors.length === 0, "page errors");
      return { fixed: hovered.line?.fixed, cursor };
    } finally {
      await tall.context.close();
    }
  });

  await check(
    "a tab filter draws fewer rows in the same box, the line where it stood",
    async () => {
      const filtering = await openWorld();
      const { page } = filtering;
      try {
        const before = await layout(page);
        await page.getByRole("button", { name: "Filter tabs", exact: true }).click();
        await page.getByRole("menuitemradio", { name: "Tabs with agents" }).click();
        await page.getByRole("button", { name: "Filter tabs: Tabs with agents" }).waitFor();
        await settle(page);
        const filtered = await layout(page);
        await shot(page, "08b-tabs-with-agents.png");
        await page.getByRole("button", { name: "Clear tab filter" }).click();
        await page.getByRole("button", { name: "Filter tabs", exact: true }).waitFor();
        await settle(page);
        const cleared = await layout(page);
        const split = (state: Layout) => [state.tasksHeight, state.tabsHeight, state.line!.y];
        const same = (state: Layout) =>
          split(state).every((value, index) => Math.abs(value - split(before)[index]!) < 0.5);
        expectThat(
          { tasks: before.tasks, tabs: [before.tabs, filtered.tabs] },
          before.tasks.overflows && before.tabs.overflows && !filtered.tabs.overflows,
          "this check needs both lists longer than their room, and the filter to leave Tabs room to spare",
        );
        expectThat(
          { before: split(before), filtered: split(filtered), cleared: split(cleared) },
          same(filtered) && same(cleared),
          "the tab filter moved the split",
        );
        noParts(filtered, "filtered");
        noParts(cleared, "the filter cleared");
        expectThat({ errors: filtering.errors }, filtering.errors.length === 0, "page errors");
        return { before: split(before), filtered: split(filtered), rows: filtered.tabs.whole };
      } finally {
        await filtering.context.close();
      }
    },
  );

  await check(
    "a section that needs less than its share keeps every row, and the other takes all the rest",
    async () => {
      const roomy = await openWorld({ world: "stress", height: 1700 });
      try {
        const results: Record<string, unknown> = {};
        for (const share of [5000, 9000]) {
          await roomy.page.evaluate(({ key, value }) => localStorage.setItem(key, String(value)), {
            key: shareKey,
            value: share,
          });
          await roomy.page.reload();
          await ready(roomy.page);
          const state = await layout(roomy.page);
          results[share] = { tasks: state.tasks, unused: state.unused, share: state.share };
          expectThat(
            { share, tasks: state.tasks, tabs: state.tabs.overflows },
            state.share === share && !state.tasks.overflows && state.tabs.overflows,
            "Tasks should hold every row and Tabs overflow here",
          );
          expectThat(
            { share, unused: state.unused },
            Math.abs(state.unused) < 0.5,
            "Tabs did not take all the room Tasks left",
          );
          noParts(state, `share ${share}`);
        }
        await shot(roomy.page, "09-tasks-hugs-its-rows.png");
        expectThat({ errors: roomy.errors }, roomy.errors.length === 0, "page errors");
        return results;
      } finally {
        await roomy.context.close();
      }
    },
  );

  await check("in a narrow window's drawer the line moves Tasks a row at a time", async () => {
    const narrow = await openWorld({ width: 1100, height: 900 });
    try {
      await narrow.page
        .getByRole("button", { name: /^(Open sidebar|Open navigation)/ })
        .first()
        .click();
      await narrow.page.locator(".sidebar--open").waitFor();
      await settle(narrow.page);
      const before = await layout(narrow.page);
      const stats = await frames(narrow.page, () => dragLine(narrow.page, 40));
      const after = await layout(narrow.page);
      await shot(narrow.page, "10-drawer.png");
      const brought = rowsBroughtIn(before.tasks.below, 40);
      expectThat(
        { before: before.tasks.whole, after: after.tasks.whole, brought, stats },
        brought > 0 && after.tasks.whole === before.tasks.whole + brought && stats.partFrames === 0,
        "the drawer's line did not move Tasks cleanly",
      );
      keptAsShown(after, "in the drawer");
      noParts(after, "in the drawer");
      expectThat({ errors: narrow.errors }, narrow.errors.length === 0, "page errors");
      return { before: before.tasks.whole, after: after.tasks.whole, stats };
    } finally {
      await narrow.context.close();
    }
  });
} catch (error) {
  abort(error);
} finally {
  await web.close();
  await finishJourney(artifactDirectory, checks);
}
