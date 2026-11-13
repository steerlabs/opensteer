/**
 * The sidebar's Tabs panel and the line along its top, in headless Chromium
 * against the mock Host: the production web build; real pointer, keyboard and
 * window input; every frame of a drag checked for rows shown in part and for
 * React renders; Tabs' height kept across a reload and across whatever the
 * pane above shows (Tasks, Done, a team); screenshots and a video.
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
const heightKey = "opensteer.sidebar-tabs-height";

/**
 * What a frame must never show, found in the page so a frame loop can use it
 * too: a row in part at either edge of Tasks or at Tabs' top (but at Tabs'
 * end, where its last row stands whole at the panel's foot instead), or,
 * Tabs being longer than its room, any band between Tabs' list and its
 * panel's foot (the list runs to it; a row in part there is the cue there is
 * more).
 */
const partsScript = `globalThis.__splitParts = () => {
  const parts = [];
  const panel = document.querySelector(".side-section--tabs");
  const panelStyle = getComputedStyle(panel);
  const footer =
    panel.getBoundingClientRect().bottom -
    parseFloat(panelStyle.borderBottomWidth) -
    parseFloat(panelStyle.paddingBottom);
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
          tabsHeight: document
            .querySelector(".sidebar__lists")
            .style.getPropertyValue("--side-tabs-height"),
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
  /** Tabs' height as the person set it, or null for the default. */
  readonly stored: number | null;
  readonly line: { readonly x: number; readonly y: number; readonly fixed: boolean } | null;
  readonly valueNow: number | null;
  /** From Tasks' top to the footer's line. */
  readonly room: number;
  readonly unused: number;
  readonly tasksHeight: number;
  /** Blank height under Tasks' last row in view, inside its section. */
  readonly tasksGap: number;
  readonly tabsTop: number;
  readonly tabsHeight: number;
  /** From Tabs' list's foot to its panel's: none while Tabs is longer than its room. */
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
        if (r.top >= top - 0.5 && r.bottom <= bottom + 0.5) {
          whole++;
          continue;
        }
        if (
          footOpen &&
          (r.top >= top - 0.5 || list.scrollTop >= list.scrollHeight - list.clientHeight - 1)
        )
          continue;
        parts++;
        partRows.push([r.top - top, r.bottom - top]);
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
    const tasks = document.querySelector<HTMLElement>(".side-section--tasks")!;
    const tabs = document.querySelector<HTMLElement>(".side-section--tabs")!;
    const footer = document.querySelector<HTMLElement>(".sidebar__footer")!;
    const line = document.querySelector<HTMLElement>(".side-split");
    const lineBox = line?.getBoundingClientRect();
    const room = footer.getBoundingClientRect().top - tasks.getBoundingClientRect().top;
    const tasksHeight = tasks.getBoundingClientRect().height;
    const tabsBox = tabs.getBoundingClientRect();
    const tabsStyle = getComputedStyle(tabs);
    const tabsOuter =
      tabsBox.height + parseFloat(tabsStyle.marginTop) + parseFloat(tabsStyle.marginBottom);
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
      stored: localStorage.getItem(key) === null ? null : Number(localStorage.getItem(key)),
      line: lineBox
        ? {
            x: lineBox.left + lineBox.width / 2,
            y: lineBox.top,
            fixed: line!.hasAttribute("data-fixed"),
          }
        : null,
      valueNow:
        line?.getAttribute("aria-valuenow") == null
          ? null
          : Number(line.getAttribute("aria-valuenow")),
      room,
      unused: room - tasksHeight - tabsOuter,
      tasksHeight,
      tasksGap: tasksList
        ? tasks.getBoundingClientRect().bottom - tasksList.getBoundingClientRect().bottom
        : 0,
      tabsTop: tabsBox.top,
      tabsHeight: tabsBox.height,
      tabsBand:
        tabsBox.bottom -
        parseFloat(tabsStyle.borderBottomWidth) -
        parseFloat(tabsStyle.paddingBottom) -
        tabs.querySelector<HTMLElement>(".side-list")!.getBoundingClientRect().bottom,
      tasksFloor: parseFloat(getComputedStyle(tasks).minHeight),
      tabsFloor: parseFloat(getComputedStyle(tabs).minHeight),
      tasks: listState(".side-section--tasks .side-list", false),
      tabs: listState(".side-section--tabs .side-list", true),
      openInView,
    };
  }, heightKey);
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
 * commits while the line is held (the render that keeps Tabs' height at the
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
  if (!line) throw new Error("No line along Tabs' top.");
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
  if (!line) throw new Error("No line along Tabs' top.");
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

/** Tabs followed a drag of `dy` to the pixel. */
function followed(before: Layout, after: Layout, dy: number): boolean {
  return Math.abs(before.tabsHeight - dy - after.tabsHeight) <= 1;
}

async function openWorld(
  options: {
    readonly world?: "busy" | "stress";
    readonly team?: boolean;
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
  const query = new URLSearchParams();
  if (options.world) query.set("mock-world", options.world);
  if (options.team) query.set("mock-team", "");
  await page.goto(`${web.origin}/?${query}`);
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

/** Tasks at its floor: at least three short rows' height, and less than a tall row more. */
function atFloor(state: Layout, step: string) {
  expectThat(
    { step, whole: state.tasks.whole, height: state.tasksHeight, floor: state.tasksFloor },
    state.tasks.whole >= 1 &&
      state.tasksHeight >= state.tasksFloor - 0.5 &&
      state.tasksHeight < state.tasksFloor + 69,
    `${step}: Tasks did not stop at its floor`,
  );
}

/** Tabs at its floor: its first three rows, and less than a tall row more. */
function tabsAtFloor(state: Layout, step: string) {
  expectThat(
    { step, tabs: state.tabs.whole, height: state.tabsHeight, floor: state.tabsFloor },
    state.tabs.whole >= 3 && state.tabsHeight < state.tabsFloor + 69,
    `${step}: Tabs did not stop at its floor`,
  );
}

/** The height the line kept is the one Tabs shows. */
function keptAsShown(state: Layout, step: string) {
  expectThat(
    { step, stored: state.stored, height: state.tabsHeight },
    state.stored !== null && Math.abs(state.stored - state.tabsHeight) < 0.5,
    `${step}: the kept height is not what Tabs shows`,
  );
}

/** The line's value is the part of the room Tabs takes now, whether or not it can move. */
function describedAsShown(state: Layout, step: string) {
  const percent = Math.round((state.tabsHeight / (state.tasksHeight + state.tabsHeight)) * 100);
  expectThat(
    { step, valueNow: state.valueNow, percent },
    state.valueNow === percent,
    `${step}: the line's value is not the part Tabs takes`,
  );
}

/** Tabs stands exactly where it stood. */
function tabsStill(before: Layout, after: Layout, step: string) {
  expectThat(
    {
      step,
      top: [before.tabsTop, after.tabsTop],
      height: [before.tabsHeight, after.tabsHeight],
      whole: [before.tabs.whole, after.tabs.whole],
    },
    Math.abs(after.tabsTop - before.tabsTop) < 0.5 &&
      Math.abs(after.tabsHeight - before.tabsHeight) < 0.5 &&
      after.tabs.whole === before.tabs.whole,
    `${step}: Tabs moved`,
  );
}

/** Rows shown in part where none may be, or a band under Tabs' list, as a check would report them. */
function noParts(state: Layout, step: string) {
  expectThat(
    { step, tasks: state.tasks, tabs: state.tabs },
    state.tasks.parts === 0 && state.tabs.parts === 0,
    `${step}: a row shows in part`,
  );
  expectThat(
    { step, band: state.tabsBand, overflows: state.tabs.overflows },
    !state.tabs.overflows || Math.abs(state.tabsBand) < 0.5,
    `${step}: Tabs' list stops short of its panel's foot`,
  );
  expectThat(
    { step, unused: state.unused },
    Math.abs(state.unused) < 0.5,
    `${step}: the pane above and Tabs do not fill the room`,
  );
}

try {
  const { context, page, errors } = await openWorld({ world: "busy", team: true, video: "main" });
  const opened = await layout(page);
  const separator = page.getByRole("separator", { name: "Resize Tabs" });

  await check(
    "the sidebar opens with Tabs at its default height, every row whole, the line ready",
    async () => {
      await page.mouse.move(opened.line!.x, opened.line!.y + 2);
      await page.waitForTimeout(150);
      const state = await layout(page);
      const cursor = await separator.evaluate((node) => getComputedStyle(node).cursor);
      const pitch = await page.evaluate(() => {
        const sidebar = getComputedStyle(document.querySelector(".sidebar")!);
        return [
          parseFloat(sidebar.getPropertyValue("--side-head")),
          parseFloat(sidebar.getPropertyValue("--side-pitch")),
        ] as const;
      });
      await shot(page, "01-default.png");
      expectThat(
        { state, pitch },
        state.stored === null && Math.abs(state.tabsHeight - (pitch[0] + 6 * pitch[1])) < 0.5,
        "Tabs did not open at its default height",
      );
      expectThat(
        { tasks: state.tasks, tabs: state.tabs },
        state.tasks.overflows && state.tabs.overflows,
        "this journey needs both lists longer than their room",
      );
      noParts(state, "opening");
      describedAsShown(opened, "opening, before the line is reached for");
      expectThat(
        { fixed: state.line?.fixed, cursor, valueNow: state.valueNow },
        state.line?.fixed === false && cursor === "row-resize",
        "the line does not offer to move",
      );
      return { state, cursor };
    },
  );

  await check("Done and a team take the pane above Tabs, and Tabs never moves", async () => {
    // Done shows once a task is in it.
    const threadId = await page
      .locator(".side-section--tasks .side-list > li[data-thread-id]")
      .last()
      .getAttribute("data-thread-id");
    await page.evaluate(
      (id) =>
        (
          Reflect.get(window, "opensteerMock") as {
            setTaskDone(threadId: string, done: boolean): Promise<unknown>;
          }
        ).setTaskDone(id, true),
      threadId!,
    );
    await settle(page);
    const before = await layout(page);
    await page.locator(".side-done .side-done__main").click();
    await page.locator("#sidebar-tasks", { hasText: "Done" }).waitFor();
    await settle(page);
    const done = await layout(page);
    await page.getByRole("button", { name: "Back to Tasks" }).click();
    await page.locator("#sidebar-tasks", { hasText: "Tasks" }).waitFor();
    await page.locator(".side-switch__option").nth(1).click();
    await page.locator(".side-section--tasks[aria-label='Team']").waitFor();
    await settle(page);
    const team = await layout(page);
    await shot(page, "02-team.png");
    await page.locator(".side-switch__option").first().click();
    await page.locator("#sidebar-tasks").waitFor();
    await settle(page);
    const back = await layout(page);
    tabsStill(before, done, "Done");
    tabsStill(before, team, "a team");
    tabsStill(before, back, "back to Tasks");
    noParts(done, "Done");
    noParts(team, "a team");
    noParts(back, "back to Tasks");
    return { top: [before.tabsTop, done.tabsTop, team.tabsTop, back.tabsTop] };
  });

  const dy = 80;
  let dragged: Layout | null = null;
  await check(
    "dragging the line down shrinks Tabs with the pointer, whole in every frame, with no render",
    async () => {
      const sidebarRenders = () =>
        page.evaluate(
          () => (globalThis as unknown as { __sidebarRenders?: number }).__sidebarRenders ?? 0,
        );
      const before = await layout(page);
      const rendersBefore = await sidebarRenders();
      const stats = await frames(page, () =>
        dragLine(page, dy, { during: () => shot(page, "03-dragging.png") }),
      );
      const after = await layout(page);
      const released = (await sidebarRenders()) - rendersBefore;
      dragged = after;
      expectThat({ stats }, stats.partFrames === 0, "a frame painted a row in part");
      expectThat(
        { stats },
        stats.sidebarRenders === 0,
        "the sidebar rendered while the line moved",
      );
      // The release keeps the height, which renders the sidebar: proof the count sees its renders.
      expectThat({ released }, released >= 1, "the sidebar's renders went uncounted");
      expectThat(
        {
          before: [before.tabsHeight, before.tabs.whole],
          after: [after.tabsHeight, after.tabs.whole],
        },
        after.tabs.whole < before.tabs.whole && followed(before, after, dy),
        "Tabs did not follow the pointer",
      );
      expectThat(
        { before: before.tasks.whole, after: after.tasks.whole },
        after.tasks.whole > before.tasks.whole,
        "Tasks did not take the height Tabs gave up",
      );
      keptAsShown(after, "after the drag");
      noParts(after, "after the drag");
      return { stats, before: before.tabsHeight, after: after.tabsHeight };
    },
  );

  await check("Tabs' height comes back exactly after a reload", async () => {
    const before = dragged ?? (await layout(page));
    await page.reload();
    await ready(page);
    const after = await layout(page);
    await shot(page, "04-after-reload.png");
    expectThat(
      { stored: [before.stored, after.stored] },
      after.stored === before.stored,
      "the reload lost Tabs' height",
    );
    tabsStill(before, after, "after the reload");
    noParts(after, "after the reload");
    return { stored: after.stored };
  });

  let highest: Layout | null = null;
  await check("pulled far up, Tabs grows until Tasks keeps its first three rows", async () => {
    const stats = await frames(page, () => dragLine(page, -900, { steps: 40 }));
    const state = await layout(page);
    highest = state;
    await shot(page, "05-tasks-floor.png");
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
      { stored: [state.stored, again.stored] },
      again.stored === state.stored,
      "a pull past the floor moved the line",
    );
    tabsStill(state, again, "pulled again");
    keptAsShown(state, "at Tasks' floor");
    noParts(state, "at Tasks' floor");
    return { stored: state.stored, stats };
  });

  let lowest: Layout | null = null;
  await check("pulled far down, Tabs keeps its first three rows", async () => {
    const stats = await frames(page, () => dragLine(page, 900, { steps: 40 }));
    const state = await layout(page);
    lowest = state;
    await shot(page, "06-tabs-floor.png");
    expectThat(
      { stats },
      stats.partFrames === 0 && stats.sidebarRenders === 0,
      "the drag painted a row in part or rendered the sidebar",
    );
    tabsAtFloor(state, "pulled far down");
    await dragLine(page, 300);
    const again = await layout(page);
    expectThat(
      { stored: [state.stored, again.stored] },
      again.stored === state.stored,
      "a pull past the end moved the line",
    );
    keptAsShown(state, "at Tabs' floor");
    noParts(state, "at Tabs' floor");
    return { stored: state.stored, tabs: state.tabs.whole, stats };
  });

  await check("keys: ↑ and ↓ move one row, Home and End go as far as the rows allow", async () => {
    await separator.focus();
    const press = async (key: string) => {
      const stats = await frames(page, async () => {
        await page.keyboard.press(key);
        await settle(page);
      });
      const state = await layout(page);
      expectThat({ key, stats }, stats.partFrames === 0, `${key} painted a row in part`);
      noParts(state, key);
      keptAsShown(state, key);
      return state;
    };
    const start = await layout(page);
    const up = await press("ArrowUp");
    expectThat(
      { start: [start.tabsHeight, start.tabs.whole], up: [up.tabsHeight, up.tabs.whole] },
      up.tabs.whole === start.tabs.whole + 1 && up.tabsHeight - start.tabsHeight < 46,
      "↑ did not give Tabs one row",
    );
    const down = await press("ArrowDown");
    expectThat(
      { start: start.tabsHeight, down: down.tabsHeight },
      Math.abs(down.tabsHeight - start.tabsHeight) < 0.5,
      "↓ did not take that row back",
    );
    const home = await press("Home");
    atFloor(home, "Home");
    expectThat(
      { home: home.stored, highest: highest?.stored },
      highest !== null && home.stored === highest.stored,
      "Home did not go as far as the pull up did",
    );
    const end = await press("End");
    expectThat(
      { end: end.stored, lowest: lowest?.stored },
      lowest !== null && end.stored === lowest.stored,
      "End did not go as far as the pull down did",
    );
    return { up: up.tabs.whole, home: home.stored, end: end.stored };
  });

  await check("a double-click puts Tabs back at its default height", async () => {
    const { line } = await layout(page);
    await page.mouse.dblclick(line!.x, line!.y + 2);
    await settle(page);
    const state = await layout(page);
    expectThat(
      { stored: state.stored, height: [opened.tabsHeight, state.tabsHeight] },
      state.stored === null && Math.abs(state.tabsHeight - opened.tabsHeight) < 0.5,
      "the double-click did not restore the default",
    );
    noParts(state, "after the reset");
    describedAsShown(state, "after the reset");
    return { height: state.tabsHeight };
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
      await shot(page, "07-open-task-kept.png");
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
    "a drag that turns back, with the open task at Tasks' foot, keeps it in view and every row whole",
    async () => {
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
      return { stored: state.stored, stats };
    },
  );

  await check(
    "in a window that holds Tabs under its kept height, a drag back to its start keeps what Tabs shows",
    async () => {
      await page.evaluate((key) => localStorage.setItem(key, "600"), heightKey);
      await page.setViewportSize({ width: 1440, height: 720 });
      await page.reload();
      await ready(page);
      const held = await layout(page);
      await holdLine(page, [40, 0]);
      const back = await layout(page);
      await page.setViewportSize({ width: 1440, height: 1000 });
      await settle(page);
      const tall = await layout(page);
      expectThat(
        { stored: held.stored, height: held.tabsHeight },
        held.stored === 600 && held.tabsHeight < 599.5,
        "this check needs the window to hold Tabs under its kept height",
      );
      keptAsShown(back, "back at the start");
      expectThat(
        { back: back.tabsHeight, tall: tall.tabsHeight, stored: tall.stored },
        Math.abs(tall.tabsHeight - back.tabsHeight) < 0.5,
        "the taller window gave Tabs another height than the one it showed",
      );
      noParts(tall, "in the taller window");
      return { held: held.tabsHeight, stored: back.stored };
    },
  );

  await check("a window resized while the line is held keeps every row whole", async () => {
    await holdLine(page, [-40], async () => {
      await page.setViewportSize({ width: 1440, height: 720 });
      await page.waitForTimeout(200);
    });
    const short = await layout(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await settle(page);
    const back = await layout(page);
    noParts(short, "after the held resize");
    noParts(back, "back at full height");
    keptAsShown(back, "back at full height");
    return { stored: back.stored };
  });

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
      return { rendered, stored: state.stored };
    },
  );

  await check(
    "with Tabs scrolled, the line follows the pointer and Tabs' top row stays whole",
    async () => {
      const reset = (await layout(page)).line!;
      await page.mouse.dblclick(reset.x, reset.y + 2);
      await settle(page);
      const list = page.locator(".side-section--tabs .side-list");
      const view = (await list.boundingBox())!;
      await page.mouse.move(view.x + view.width / 2, view.y + 20);
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(1000);
      const rested = await layout(page);
      expectThat(
        { scrollTop: rested.tabs.scrollTop },
        rested.tabs.scrollTop > 0.5,
        "this check needs Tabs scrolled",
      );
      const stats = await frames(page, () => dragLine(page, -50));
      const up = await layout(page);
      expectThat(
        { before: rested.tabsHeight, after: up.tabsHeight },
        followed(rested, up, -50),
        "Tabs did not follow the pointer",
      );
      expectThat({ stats }, stats.partFrames === 0, "a frame painted a row in part");
      keptAsShown(up, "after the scrolled drag");
      noParts(up, "after the scrolled drag");
      return { before: rested.tabsHeight, after: up.tabsHeight, stats };
    },
  );

  await check("Tabs' + by the line still opens a new tab", async () => {
    await page.getByRole("button", { name: "New tab", exact: true }).first().click();
    // Its close button shows while the row is hovered.
    await page.locator(".side-tab--start").hover();
    await page.getByRole("button", { name: "Close New tab", exact: true }).click();
    await page.locator(".side-tab--start").waitFor({ state: "detached" });
    return { opened: true };
  });

  await check(
    "a shorter window keeps Tabs' height, Tasks giving way down to its floor",
    async () => {
      const before = await layout(page);
      await page.setViewportSize({ width: 1440, height: 720 });
      await settle(page);
      const short = await layout(page);
      await shot(page, "08-short-window.png");
      await page.setViewportSize({ width: 1440, height: 1000 });
      await settle(page);
      const back = await layout(page);
      expectThat(
        { stored: [before.stored, short.stored, back.stored] },
        short.stored === before.stored && back.stored === before.stored,
        "the window's size changed the kept height",
      );
      expectThat(
        { tasks: [short.tasksHeight, short.tasksFloor], tabs: [short.tabsHeight, short.tabsFloor] },
        short.tasksHeight >= short.tasksFloor - 0.5 && short.tabsHeight >= short.tabsFloor - 0.5,
        "a section fell below its floor",
      );
      expectThat(
        {
          before: before.tabsHeight,
          short: short.tabsHeight,
          tasks: [short.tasksHeight, short.tasksFloor],
        },
        Math.abs(short.tabsHeight - before.tabsHeight) < 0.5 ||
          Math.abs(short.tasksHeight - short.tasksFloor) < 0.5,
        "Tabs gave up height while Tasks had room to give",
      );
      tabsStill(before, back, "back at full height");
      noParts(short, "in the shorter window");
      describedAsShown(short, "in the shorter window");
      noParts(back, "back at full height");
      return { short: short.tabsHeight, before: before.tabsHeight };
    },
  );

  await check(
    "search results and a collapsed sidebar take the line out of reach, and bring it back",
    async () => {
      await page.keyboard.press("Meta+k");
      const search = page.getByRole("combobox", { name: "Search tasks and tabs" });
      await search.waitFor();
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
      return { searching, collapsed, stored: state.stored };
    },
  );

  expectThat({ errors }, errors.length === 0, `page errors: ${errors.join("; ")}`);
  await context.close();

  await check("with every tab in view, the line can shrink Tabs but not grow it", async () => {
    const tall = await openWorld({ height: 2000 });
    try {
      // Asked for more height than its rows take, Tabs shows them all.
      await tall.page.evaluate((key) => localStorage.setItem(key, "5000"), heightKey);
      await tall.page.reload();
      await ready(tall.page);
      const state = await layout(tall.page);
      await dragLine(tall.page, -120);
      const after = await layout(tall.page);
      await shot(tall.page, "09-all-in-view.png");
      expectThat(
        { tabs: state.tabs.overflows },
        !state.tabs.overflows,
        "this check needs every tab in view",
      );
      expectThat(
        { stored: after.stored, height: [state.tabsHeight, after.tabsHeight] },
        after.stored === 5000 && Math.abs(after.tabsHeight - state.tabsHeight) < 0.5,
        "Tabs grew past its rows",
      );
      await dragLine(tall.page, 80);
      const shrunk = await layout(tall.page);
      expectThat(
        { height: [state.tabsHeight, shrunk.tabsHeight] },
        shrunk.tabsHeight < state.tabsHeight - 0.5,
        "Tabs did not shrink",
      );
      keptAsShown(shrunk, "shrunk");
      describedAsShown(state, "with every tab in view");
      expectThat({ errors: tall.errors }, tall.errors.length === 0, "page errors");
      return { before: state.tabsHeight, shrunk: shrunk.tabsHeight };
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
        await page.evaluate((key) => localStorage.setItem(key, "450"), heightKey);
        await page.reload();
        await ready(page);
        const before = await layout(page);
        await page.getByRole("button", { name: "Filter tabs", exact: true }).click();
        await page.getByRole("menuitemradio", { name: "Tabs with agents" }).click();
        await page.getByRole("button", { name: "Filter tabs: Tabs with agents" }).waitFor();
        await settle(page);
        const filtered = await layout(page);
        await shot(page, "10-tabs-with-agents.png");
        await page.getByRole("button", { name: "Clear tab filter" }).click();
        await page.getByRole("button", { name: "Filter tabs", exact: true }).waitFor();
        await settle(page);
        const cleared = await layout(page);
        expectThat(
          { tasks: before.tasks, tabs: [before.tabs, filtered.tabs] },
          before.tasks.overflows && before.tabs.overflows && !filtered.tabs.overflows,
          "this check needs both lists longer than their room, and the filter to leave Tabs room to spare",
        );
        tabsStill(before, { ...filtered, tabs: before.tabs }, "filtered");
        tabsStill(before, cleared, "the filter cleared");
        noParts(filtered, "filtered");
        noParts(cleared, "the filter cleared");
        expectThat({ errors: filtering.errors }, filtering.errors.length === 0, "page errors");
        return {
          before: before.tabsHeight,
          filtered: filtered.tabsHeight,
          rows: filtered.tabs.whole,
        };
      } finally {
        await filtering.context.close();
      }
    },
  );

  await check("Tasks with few rows leaves Tabs at the height it keeps", async () => {
    const roomy = await openWorld({ world: "stress", height: 1700 });
    try {
      const results: Record<string, unknown> = {};
      for (const height of [300, 400]) {
        await roomy.page.evaluate(({ key, value }) => localStorage.setItem(key, String(value)), {
          key: heightKey,
          value: height,
        });
        await roomy.page.reload();
        await ready(roomy.page);
        const state = await layout(roomy.page);
        results[height] = { tasks: state.tasks.whole, tabs: state.tabsHeight };
        expectThat(
          { height, tasks: state.tasks.overflows, tabs: [state.tabs.overflows, state.tabsHeight] },
          !state.tasks.overflows &&
            state.tabs.overflows &&
            Math.abs(state.tabsHeight - height) < 0.5,
          "Tabs did not keep its height beside a short Tasks",
        );
        noParts(state, `Tabs at ${height}px`);
      }
      await shot(roomy.page, "11-tasks-few-rows.png");
      expectThat({ errors: roomy.errors }, roomy.errors.length === 0, "page errors");
      return results;
    } finally {
      await roomy.context.close();
    }
  });

  await check("in a narrow window's drawer the line moves Tabs a row at a time", async () => {
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
      await shot(narrow.page, "12-drawer.png");
      expectThat(
        { before: before.tabsHeight, after: after.tabsHeight, stats },
        after.tabs.whole < before.tabs.whole &&
          followed(before, after, 40) &&
          stats.partFrames === 0,
        "the drawer's line did not move Tabs cleanly",
      );
      keptAsShown(after, "in the drawer");
      noParts(after, "in the drawer");
      expectThat({ errors: narrow.errors }, narrow.errors.length === 0, "page errors");
      return { before: before.tabsHeight, after: after.tabsHeight, stats };
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
