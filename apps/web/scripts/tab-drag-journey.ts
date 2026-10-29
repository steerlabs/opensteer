/**
 * Tab drag-and-drop evidence in headless Chromium against the mock Host: the
 * production web build, real pointer and keyboard input, a video, mid-drag
 * screenshots, the list order before and after every step, and frame timing.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { Page } from "playwright-core";
import { expectThat, finishJourney, journeyChecks, openMockWeb } from "./mock-web-journey.js";

const artifactDirectory = path.resolve(
  process.env.OPENSTEER_TAB_DRAG_EVIDENCE_DIR ??
    path.join(tmpdir(), "opensteer-tab-drag-evidence/web"),
);
await mkdir(artifactDirectory, { recursive: true });
const { checks, check, abort } = journeyChecks();
const web = await openMockWeb("opensteer-tab-drag-web");
const timings: Record<string, unknown> = {};
const trace: Record<string, unknown>[] = [];

type WebRow =
  | {
      readonly key: string;
      readonly kind: "group";
      readonly title: string;
      readonly expanded: boolean;
    }
  | {
      readonly key: string;
      readonly kind: "tab";
      readonly title: string;
      readonly grouped: boolean;
    };

/** The web section as it stands: each row's key, kind and group. */
async function webRows(page: Page) {
  return page.locator(".side-section--tabs .side-list").evaluate((list) =>
    [...list.children].flatMap((node): WebRow[] => {
      const row = node as HTMLElement;
      if (row.matches(".side-tab-group"))
        return [
          {
            key: row.dataset.motionKey!,
            kind: "group" as const,
            title: row.querySelector(".side-tab-group__chip")?.textContent ?? "",
            expanded:
              row.querySelector(".side-tab-group__main")?.getAttribute("aria-expanded") === "true",
          },
        ];
      if (row.dataset.group !== "web") return [];
      return [
        {
          key: row.dataset.motionKey!,
          kind: "tab" as const,
          title: row.querySelector(".side-tab__title")?.textContent ?? "",
          grouped: row.classList.contains("side-tab--grouped"),
        },
      ];
    }),
  );
}
const keys = async (page: Page) => (await webRows(page)).map((row) => row.key);
const rowAt = (page: Page, key: string) =>
  page.locator(`.side-section--tabs .side-list > [data-motion-key="${key}"]`);

async function box(page: Page, key: string) {
  const found = await rowAt(page, key).boundingBox();
  if (!found) throw new Error(`No row ${key}`);
  return found;
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
  await page.waitForTimeout(60);
}

/** Presses a row, lifts it past the threshold, moves the pointer to `y`, then runs `during` and releases. */
async function drag(
  page: Page,
  key: string,
  y: number | (() => Promise<number>),
  options: {
    readonly during?: () => Promise<unknown>;
    readonly release?: "drop" | "escape";
    readonly x?: number;
  } = {},
) {
  const from = await box(page, key);
  const start = { x: from.x + Math.min(60, from.width / 3), y: from.y + from.height / 2 };
  const scroll = () =>
    page.locator(".side-section--tabs .side-list").evaluate((list) => list.scrollTop);
  trace.push({ key: key.slice(-10), start: start.y, scroll: await scroll() });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const early = typeof y === "number" ? y : null;
  await page.mouse.move(start.x, start.y + (early === null || early > start.y ? 8 : -8), {
    steps: 2,
  });
  // A target given as a function is read once the row has lifted (a group folds first).
  const target = typeof y === "number" ? y : (await settle(page), await y());
  await page.mouse.move(options.x ?? start.x, target, { steps: 14 });
  await page.waitForTimeout(260);
  trace.push({ mid: true, scroll: await scroll() });
  await options.during?.();
  if (options.release === "escape") await page.keyboard.press("Escape");
  await page.mouse.up();
  await settle(page);
}

/**
 * Records where every row of the tab list stands on screen at the next release
 * (or arrow key), then every frame for the next 1500 ms.
 */
async function watchRows(page: Page, trigger: "pointerup" | "keydown") {
  await page.evaluate((type) => {
    const list = document.querySelector<HTMLElement>(".side-section--tabs .side-list")!;
    const read = () => {
      const top = list.getBoundingClientRect().top + list.clientTop;
      return {
        scroll: list.scrollTop,
        moving: list.hasAttribute("data-moving"),
        top,
        bottom: top + list.clientHeight,
        rows: [...list.querySelectorAll<HTMLElement>(":scope > [data-motion-key]")].map((row) => {
          const box = row.getBoundingClientRect();
          return { key: row.dataset.motionKey!, top: box.top, bottom: box.bottom };
        }),
      };
    };
    const watch = { frames: [] as ReturnType<typeof read>[], done: false };
    Reflect.set(window, "__rows", watch);
    const start = (event: Event) => {
      if (event instanceof KeyboardEvent && !event.key.startsWith("Arrow")) return;
      window.removeEventListener(type, start, { capture: true });
      watch.frames.push(read());
      const until = performance.now() + 1500;
      const tick = () => {
        watch.frames.push(read());
        if (performance.now() < until) requestAnimationFrame(tick);
        else watch.done = true;
      };
      requestAnimationFrame(tick);
    };
    window.addEventListener(type, start, { capture: true });
  }, trigger);
}

/**
 * How the list went from the watched release on: how far any row but `moved`
 * jumped in the first frame, how far any row the new order leaves in its
 * place moved on screen by the end, every scroll position it took after that
 * frame, whether it rests on a row's top, and whether `moved` lands whole in
 * view.
 */
async function rowsAfter(page: Page, moved: string) {
  await page.waitForFunction(() => (Reflect.get(window, "__rows") as { done: boolean }).done);
  const { frames } = await page.evaluate(
    () =>
      Reflect.get(window, "__rows") as {
        frames: {
          scroll: number;
          moving: boolean;
          top: number;
          bottom: number;
          rows: { key: string; top: number; bottom: number }[];
        }[];
      },
  );
  const [release, first] = frames;
  const last = frames.at(-1)!;
  const jolt = Math.max(
    0,
    ...release!.rows
      .filter((row) => row.key !== moved)
      .map((row) => {
        const then = first!.rows.find((entry) => entry.key === row.key);
        return then ? Math.abs(then.top - row.top) : 0;
      }),
  );
  const landed = last.rows.find((row) => row.key === moved);
  const from = release!.rows.findIndex((row) => row.key === moved);
  const to = last.rows.findIndex((row) => row.key === moved);
  const drift = Math.max(
    0,
    ...last.rows
      .filter((_, index) => index < Math.min(from, to) || index > Math.max(from, to))
      .map((row) => {
        const then = release!.rows.find((entry) => entry.key === row.key);
        return then ? Math.abs(row.top - then.top) : 0;
      }),
  );
  // Where the rows came to stand still, the list's snap resumed: it must not move it.
  const resumed = frames
    .slice(1)
    .flatMap((frame, index) =>
      frames[index]!.moving && !frame.moving
        ? [Math.abs(frame.scroll - frames[index]!.scroll)]
        : [],
    );
  return {
    frames: frames.length,
    jolt: Math.round(jolt * 10) / 10,
    drift: Math.round(drift * 10) / 10,
    scrolls: [...new Set(frames.slice(1).map((frame) => Math.round(frame.scroll * 10) / 10))],
    released: release!.scroll,
    snapped: Math.round(Math.max(0, ...resumed) * 10) / 10,
    still: !last.moving,
    whole: last.rows.some((row) => Math.abs(row.top - last.top) < 0.5),
    inView: !!landed && landed.top >= last.top - 0.5 && landed.bottom <= last.bottom + 0.5,
  };
}

/** A drop or a key move that lands without a jolt: rows start where they stood and the list then holds still on whole rows. */
function expectSteady(observed: Awaited<ReturnType<typeof rowsAfter>>, what: string) {
  expectThat(observed, observed.jolt <= 2, `${what}: the rows jumped as it landed`);
  expectThat(observed, observed.scrolls.length === 1, `${what}: the list moved after it landed`);
  expectThat(observed, observed.whole, `${what}: the list did not rest on whole rows`);
  expectThat(observed, observed.inView, `${what}: the moved row did not land in view`);
  expectThat(observed, observed.still, `${what}: the rows never came to rest`);
}

/** Counts rows added, removed or moved in the list after the lift, and frame intervals, while `run` drags. */
async function observe(page: Page, run: () => Promise<void>) {
  // Icons and the like finish loading first: what is counted is what the drag causes.
  const commits = () =>
    page.evaluate(() => (globalThis as unknown as { __commits?: number }).__commits ?? 0);
  for (let last = -1, tries = 0; tries < 40; tries++) {
    const now = await commits();
    if (now === last) break;
    last = now;
    await page.waitForTimeout(1000);
  }
  await page.evaluate(() => {
    const list = document.querySelector(".side-section--tabs .side-list")!;
    const state = {
      lifted: false,
      childChanges: 0,
      commits: 0,
      liftedAt: 0,
      frames: [] as number[],
      longTasks: [] as number[],
    };
    const commits = () => (globalThis as unknown as { __commits?: number }).__commits ?? 0;
    (window as unknown as { __drag: typeof state }).__drag = state;
    new MutationObserver((records) => {
      if (!state.lifted) return;
      for (const record of records) if (record.type === "childList") state.childChanges++;
    }).observe(list, { childList: true });
    new MutationObserver(() => {
      const lifted = list.hasAttribute("data-sorting");
      if (lifted && !state.lifted) state.liftedAt = commits();
      if (!lifted && state.lifted) state.commits += commits() - state.liftedAt;
      state.lifted = lifted;
    }).observe(list, { attributes: true, attributeFilter: ["data-sorting"] });
    new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries()) state.longTasks.push(entry.duration);
    }).observe({ type: "longtask", buffered: false });
    let last = performance.now();
    const tick = (now: number) => {
      if (state.lifted) state.frames.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await run();
  return page.evaluate(() => {
    const state = (
      window as unknown as {
        __drag: { childChanges: number; commits: number; frames: number[]; longTasks: number[] };
      }
    ).__drag;
    const sorted = [...state.frames].sort((a, b) => a - b);
    return {
      childChanges: state.childChanges,
      commits: state.commits,
      frames: sorted.length,
      p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
      worst: sorted[sorted.length - 1] ?? 0,
      longTasks: state.longTasks,
    };
  });
}

async function openWorld(world: "busy" | "stress") {
  const context = await web.browser.newContext({
    viewport: { width: 1440, height: 1000 },
    recordVideo: {
      dir: path.join(artifactDirectory, `video-${world}`),
      size: { width: 1440, height: 1000 },
    },
  });
  await context.route(
    (url) => url.origin !== web.origin,
    (route) => route.fulfill({ body: "", status: 204 }),
  );
  // tsx keeps function names with a helper the page lacks; observers here define functions.
  await context.addInitScript("globalThis.__name = (value) => value;");
  // React reports every commit to a DevTools hook; the journey counts those made while a row is lifted.
  await context.addInitScript(`globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, renderers: new Map(), inject() { return 1; },
    onCommitFiberRoot() { globalThis.__commits = (globalThis.__commits ?? 0) + 1; },
    onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {},
  };`);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${web.origin}/?mock-world=${world}`);
  await page.locator('.side-tab[data-group="web"]').first().waitFor();
  // The world stops moving on its own, so every change during a drag is one a check makes.
  await page.evaluate(() =>
    (Reflect.get(window, "opensteerMock") as { scriptPlaces(): unknown }).scriptPlaces(),
  );
  return { context, page, errors };
}

const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(artifactDirectory, name) });

try {
  const { context, page, errors } = await openWorld("busy");
  const order = async () =>
    (await webRows(page)).filter((row) => row.kind === "tab").map((row) => row.key);

  await check("a press that barely moves is still a click on the tab", async () => {
    const [, second] = await order();
    const target = await box(page, second!);
    await page.mouse.move(target.x + 50, target.y + target.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + 52, target.y + target.height / 2 + 3, { steps: 2 });
    await page.mouse.up();
    await page.waitForTimeout(150);
    const active = await rowAt(page, second!).evaluate((row) =>
      row.classList.contains("is-active"),
    );
    expectThat({ active }, active, "the tab did not open");
    return { active };
  });

  await check(
    "dragging a tab two rows down moves it there, with no DOM work while it moves",
    async () => {
      const before = await order();
      const [first, , third] = before;
      const target = await box(page, third!);
      const stats = await observe(page, () =>
        drag(page, first!, target.y + target.height / 2, {
          during: () => shot(page, "01-lifted.png"),
        }),
      );
      const after = await order();
      timings.reorder = stats;
      expectThat({ stats }, stats.commits === 0, "React committed while the row was lifted");
      expectThat(
        { before, after, stats },
        after.indexOf(first!) === 2,
        "the tab did not land after the third",
      );
      expectThat(
        { stats },
        stats.childChanges === 0,
        "the list changed structure while the row was lifted",
      );
      return { before: before.slice(0, 4), after: after.slice(0, 4), stats };
    },
  );

  await check("a new group gathers two tabs", async () => {
    const [first, second] = await order();
    for (const [key, target] of [
      [first!, "New group"],
      [second!, "Research"],
    ] as const) {
      await rowAt(page, key).locator(".side-tab__main").click({ button: "right" });
      await page.getByRole("menuitem", { name: "Add to group", exact: true }).click();
      await page.getByRole("menuitem", { name: target, exact: true }).click();
      if (target === "New group") {
        const title = page.getByRole("textbox", { name: "Group title" });
        await title.fill("Research");
        await title.press("Enter");
      }
    }
    await page.getByRole("button", { name: "Research, 2 tabs", exact: true }).waitFor();
    await settle(page);
    return { rows: (await webRows(page)).slice(0, 5) };
  });

  /** Scrolls a row into the list's view as a person does, with the wheel. */
  const reveal = async (key: string) => {
    for (let tries = 0; tries < 40; tries++) {
      const [row, view] = await Promise.all([
        box(page, key),
        page.locator(".side-section--tabs .side-list").boundingBox(),
      ]);
      if (row.y >= view!.y && row.y + row.height <= view!.y + view!.height) break;
      await page.mouse.move(view!.x + view!.width / 2, view!.y + view!.height / 2);
      await page.mouse.wheel(0, row.y < view!.y ? -row.height : row.height);
      await page.waitForTimeout(160);
    }
    await page.waitForTimeout(200);
  };
  const groupKey = async () => (await webRows(page)).find((row) => row.kind === "group")!.key;
  const members = async () => {
    const rows = await webRows(page);
    const start = rows.findIndex((row) => row.kind === "group");
    const out: string[] = [];
    for (const row of rows.slice(start + 1)) {
      if (row.kind !== "tab" || !row.grouped) break;
      out.push(row.key);
    }
    return out;
  };

  /** The loose tab right after the group's block, or right before its header, scrolled into view. */
  const neighbour = async (side: "after" | "before") => {
    const rows = await webRows(page);
    const header = rows.findIndex((row) => row.kind === "group");
    const block = header + 1 + (await members()).length;
    const row = side === "after" ? rows[block] : rows[header - 1];
    expectThat({ rows: rows.length, side }, row?.kind === "tab", `no loose tab ${side} the group`);
    await reveal(row!.key);
    return row!.key;
  };

  await check("dropping a loose tab between two members puts it in the group there", async () => {
    const [firstMember, secondMember] = await members();
    const loose = await neighbour("after");
    const target = await box(page, secondMember!);
    await drag(page, loose, target.y + target.height / 2, {
      during: () => shot(page, "02-into-group.png"),
    });
    const after = await members();
    expectThat(
      { after, loose },
      JSON.stringify(after) === JSON.stringify([firstMember, loose, secondMember]),
      "the tab did not join between the members",
    );
    return { members: after };
  });

  await check(
    "dragging the last member past the group's foot takes it out, right after the group",
    async () => {
      const before = await members();
      const last = before.at(-1)!;
      const at = await box(page, last);
      await drag(page, last, at.y + at.height / 2 + at.height * 0.45, {
        during: () => shot(page, "03-leaving-group.png"),
      });
      const after = await members();
      const rows = await webRows(page);
      const index = rows.findIndex((row) => row.key === last);
      const previous = rows[index - 1];
      expectThat(
        { after, previous },
        after.length === before.length - 1 && previous?.key === after.at(-1),
        "the tab did not land right after the group",
      );
      return { before, after };
    },
  );

  /** Collapses the group, drops the loose tab beside it on the header's middle, and expands it again. */
  const dropOnCollapsed = async (side: "after" | "before") => {
    const header = await groupKey();
    const toggle = rowAt(page, header).locator(".side-tab-group__main");
    const loose = await neighbour(side);
    await toggle.click();
    try {
      await page.waitForFunction(
        (key) =>
          document
            .querySelector(`[data-motion-key="${key}"] .side-tab-group__main`)
            ?.getAttribute("aria-expanded") === "false",
        header,
      );
      await settle(page);
      const count = Number(
        await rowAt(page, header).locator(".side-tab-group__count").textContent(),
      );
      const target = await box(page, header);
      await drag(page, loose, target.y + target.height / 2, {
        during: async () => {
          const lit = await rowAt(page, header).getAttribute("data-sort");
          expectThat({ lit }, lit === "target", "the collapsed header did not light up");
          await shot(page, `04-onto-collapsed-from-${side === "after" ? "below" : "above"}.png`);
        },
      });
      const after = Number(
        await rowAt(page, header).locator(".side-tab-group__count").textContent(),
      );
      const expanded = await toggle.getAttribute("aria-expanded");
      expectThat(
        { count, after, expanded },
        after === count + 1 && expanded === "false",
        "the tab did not join the collapsed group",
      );
      return { count, after, expanded };
    } finally {
      if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
      await settle(page);
    }
  };
  const fromSide = (side: "after" | "before") =>
    check(
      `a tab dropped from ${side === "after" ? "below" : "above"} on a collapsed header's middle joins it, still collapsed`,
      () => dropOnCollapsed(side),
    );
  await fromSide("after");

  await check(
    "dragging a group's header moves the whole group, folded while it moves",
    async () => {
      const header = await groupKey();
      const before = await members();
      const rows = await webRows(page);
      const below = rows[rows.findIndex((row) => row.key === header) + 1 + before.length + 2]!.key;
      await reveal(header);
      let foldedDuring = -1;
      const target = async () => {
        const at = await box(page, below);
        return at.y + at.height / 2;
      };
      await drag(page, header, target, {
        during: async () => {
          foldedDuring = (await members()).length;
          await shot(page, "05-group-lifted.png");
        },
      });
      const after = await members();
      const order = await keys(page);
      expectThat(
        { before, after, foldedDuring },
        foldedDuring === 0 &&
          JSON.stringify(after) === JSON.stringify(before) &&
          order.indexOf(below) === order.indexOf(header) - 1,
        "the group did not move as a block to right after that tab",
      );
      return { before, after, foldedDuring };
    },
  );
  await fromSide("before");

  await check("Escape mid-drag puts every row back and moves nothing", async () => {
    const before = await keys(page);
    const [, second] = await order();
    await reveal(second!);
    const from = await box(page, second!);
    await drag(page, second!, from.y + from.height * 4, { release: "escape" });
    // The busy world keeps opening tabs of its own; only the tabs that were there count.
    const after = (await keys(page)).filter((key) => before.includes(key));
    const leftovers = await page
      .locator("[data-sort], [data-sort-place], .side-list[data-sorting]")
      .count();
    expectThat(
      { before, after, leftovers },
      JSON.stringify(after) === JSON.stringify(before) && leftovers === 0,
      "Escape changed the order",
    );
    return { unchanged: true, leftovers };
  });

  await check("releasing away from the sidebar cancels the drag", async () => {
    const before = await keys(page);
    const [first] = await order();
    await reveal(first!);
    const from = await box(page, first!);
    await drag(page, first!, from.y + from.height * 4, { x: 900 });
    const after = (await keys(page)).filter((key) => before.includes(key));
    expectThat(
      { before, after },
      JSON.stringify(after) === JSON.stringify(before),
      "a release away from the sidebar moved the tab",
    );
    return { unchanged: true };
  });

  await check("a release away from the sidebar cancels even before a frame paints it", async () => {
    const before = await keys(page);
    const [first] = await order();
    await reveal(first!);
    const from = await box(page, first!);
    const x = from.x + 60;
    await page.mouse.move(x, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, from.y + from.height / 2 + 10, { steps: 2 });
    await page.mouse.move(x, from.y + from.height * 3.5, { steps: 6 });
    await page.waitForTimeout(200);
    // Out and released in one task: no animation frame runs between the two.
    await page.evaluate(
      ({ x, y }) => {
        const options = {
          bubbles: true,
          pointerId: 1,
          pointerType: "mouse",
          clientX: x,
          clientY: y,
        };
        window.dispatchEvent(new PointerEvent("pointermove", { ...options, buttons: 1 }));
        window.dispatchEvent(new PointerEvent("pointerup", { ...options, buttons: 0 }));
      },
      { x: 900, y: from.y + from.height * 3.5 },
    );
    await page.mouse.up();
    await settle(page);
    const after = (await keys(page)).filter((key) => before.includes(key));
    expectThat(
      { before, after },
      JSON.stringify(after) === JSON.stringify(before),
      "the release moved the tab",
    );
    return { unchanged: true };
  });

  for (const [name, interrupt] of [
    ["the window losing focus", () => page.evaluate(() => window.dispatchEvent(new Event("blur")))],
    [
      "the pointer being cancelled",
      () =>
        page.evaluate(() =>
          window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1, bubbles: true })),
        ),
    ],
  ] as const)
    await check(`${name} mid-drag puts every row back`, async () => {
      const before = await keys(page);
      const [first] = await order();
      await reveal(first!);
      const from = await box(page, first!);
      await drag(page, first!, from.y + from.height * 3, { during: interrupt });
      const after = (await keys(page)).filter((key) => before.includes(key));
      const leftovers = await page.locator("[data-sort], .side-list[data-sorting]").count();
      expectThat(
        { before, after, leftovers },
        JSON.stringify(after) === JSON.stringify(before) && leftovers === 0,
        `${name} did not cancel the drag`,
      );
      return { unchanged: true };
    });

  await check(
    "a tab closed elsewhere mid-drag changes nothing until the drop, then both land",
    async () => {
      const tabs = (await webRows(page)).filter((row) => row.kind === "tab" && !row.grouped);
      const [moving, , landing] = tabs;
      const closing = tabs.at(-1)!.key;
      await reveal(moving!.key);
      const target = await box(page, landing!.key);
      const tabId = closing.split(":").at(-1)!;
      const stats = await observe(page, () =>
        drag(page, moving!.key, target.y + target.height / 2, {
          during: () =>
            page.evaluate(
              (id) =>
                (
                  Reflect.get(window, "opensteerMock") as {
                    closeWorkspaceTabs(ids: string[]): Promise<unknown>;
                  }
                ).closeWorkspaceTabs([id]),
              tabId,
            ),
        }),
      );
      const after = await keys(page);
      expectThat(
        { stats, after },
        stats.childChanges === 0 &&
          !after.includes(closing) &&
          after.indexOf(moving!.key) === after.indexOf(landing!.key) + 1,
        "the drop or the close went astray",
      );
      return { stats };
    },
  );

  await check("a drop whose anchor closed mid-drag moves nothing and says so", async () => {
    const tabs = (await webRows(page)).filter((row) => row.kind === "tab" && !row.grouped);
    const [moving, , landing, after] = tabs;
    await reveal(moving!.key);
    const target = await box(page, landing!.key);
    const before = await keys(page);
    await drag(page, moving!.key, target.y + target.height / 2, {
      during: () =>
        page.evaluate(
          (id) =>
            (
              Reflect.get(window, "opensteerMock") as {
                closeWorkspaceTabs(ids: string[]): Promise<unknown>;
              }
            ).closeWorkspaceTabs([id]),
          after!.key.split(":").at(-1)!,
        ),
    });
    const now = await keys(page);
    const toasts = await page.locator(".toast__message").allTextContents();
    expectThat(
      { before, now, toasts },
      !now.includes(after!.key) &&
        JSON.stringify(now) === JSON.stringify(before.filter((key) => key !== after!.key)) &&
        toasts.length === 1,
      "the drop did not refuse the closed anchor plainly",
    );
    await page.locator(".toast").first().waitFor({ state: "detached", timeout: 15_000 });
    return { toasts };
  });

  await check("⌘↑ on a group's only tab takes it out, and the empty group goes", async () => {
    const [tab] = (await webRows(page)).filter((row) => row.kind === "tab" && !row.grouped);
    await reveal(tab!.key);
    await rowAt(page, tab!.key).locator(".side-tab__main").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Add to group", exact: true }).click();
    await page.getByRole("menuitem", { name: "New group", exact: true }).click();
    const title = page.getByRole("textbox", { name: "Group title" });
    await title.fill("Solo");
    await title.press("Enter");
    await page.getByRole("button", { name: "Solo, 1 tabs", exact: true }).waitFor();
    await settle(page);
    await rowAt(page, tab!.key).locator(".side-tab__main").focus();
    await page.keyboard.press("Meta+ArrowUp");
    await page
      .getByRole("button", { name: "Solo, 1 tabs", exact: true })
      .waitFor({ state: "detached" });
    await settle(page);
    const row = (await webRows(page)).find((entry) => entry.key === tab!.key);
    const toasts = await page.locator(".toast").allTextContents();
    expectThat(
      { row, toasts },
      row?.kind === "tab" && !row.grouped && toasts.length === 0,
      "the tab did not leave its group cleanly",
    );
    return { row, toasts };
  });

  await check(
    "⌘↓ and ⌘↑ move a focused tab one place, into and out of a group, keeping focus",
    async () => {
      const above = { key: await neighbour("before") };
      const headerKey = await groupKey();
      await rowAt(page, above.key).locator(".side-tab__main").focus();
      await page.keyboard.press("Meta+ArrowDown");
      await settle(page);
      const joined = await members();
      const focused = await page.evaluate(() =>
        document.activeElement?.closest("[data-motion-key]")?.getAttribute("data-motion-key"),
      );
      expectThat(
        { joined, focused },
        joined[0] === above.key && focused === above.key,
        "⌘↓ did not step into the group's top",
      );
      await page.keyboard.press("Meta+ArrowUp");
      await settle(page);
      const left = await members();
      const back = await keys(page);
      expectThat(
        { left, back },
        !left.includes(above.key) && back.indexOf(above.key) === back.indexOf(headerKey) - 1,
        "⌘↑ did not step back out above the group",
      );
      return { joined, left, focused };
    },
  );

  expectThat({ errors }, errors.length === 0, `page errors: ${errors.join("; ")}`);
  await context.close();

  const stress = await openWorld("stress");
  const stressList = stress.page.locator(".side-section--tabs .side-list");
  /** The list scrolled to its top and at rest there. */
  const toTop = async () => {
    await stressList.evaluate((list) => (list.scrollTop = 0));
    await stress.page.waitForTimeout(400);
  };
  await check(
    "a drop while the list scrolls lands with every row where it stood, on whole rows",
    async () => {
      const drops = [];
      // Each push scrolls at its own speed, so each release stops the list at its own fraction of a row.
      for (const push of [8, 15, 22]) {
        await toTop();
        const tabs = (await webRows(stress.page)).filter((row) => row.kind === "tab");
        const key = tabs[1]!.key;
        const view = (await stressList.boundingBox())!;
        await drag(stress.page, key, view.y + view.height + push, {
          during: () => watchRows(stress.page, "pointerup"),
        });
        const observed = await rowsAfter(stress.page, key);
        const moved = (await keys(stress.page)).indexOf(key);
        drops.push({ push, moved, ...observed });
        expectThat({ push, moved, observed }, moved > 4, "the tab did not move down the list");
        expectThat({ push, observed }, observed.released > 100, "the drag did not scroll the list");
        expectSteady(observed, `a drop pushed ${push}px past the foot`);
      }
      return { drops };
    },
  );
  /** Where the list's scroll stands while a row is held, and whether that is a row's top. */
  const heldScroll = () =>
    stressList.evaluate((list) => ({
      scroll: list.scrollTop,
      whole: [...list.children].some(
        (row) => Math.abs((row as HTMLElement).offsetTop - list.scrollTop) < 0.5,
      ),
    }));
  await check(
    "a push that scrolled the list lands it on whole rows while the row is held, and the drop moves no row it leaves in place",
    async () => {
      const drops = [];
      // Each push scrolls at its own speed, so each stops the list at its own fraction of a row.
      for (const push of [10, 22]) {
        await toTop();
        const tabs = (await webRows(stress.page)).filter((row) => row.kind === "tab");
        const key = tabs[1]!.key;
        const from = await box(stress.page, key);
        const x = from.x + Math.min(60, from.width / 3);
        const view = (await stressList.boundingBox())!;
        let held = { scroll: 0, whole: false };
        await drag(stress.page, key, view.y + view.height + push, {
          during: async () => {
            await stress.page.waitForTimeout(300);
            // Back inside the list, the push stops; the person aims at a slot there.
            await stress.page.mouse.move(x, view.y + view.height / 2, { steps: 4 });
            await stress.page.waitForTimeout(600);
            held = await heldScroll();
            await watchRows(stress.page, "pointerup");
          },
        });
        const observed = await rowsAfter(stress.page, key);
        drops.push({ push, held, ...observed });
        expectThat({ push, held }, held.scroll > 100, "the push did not scroll the list");
        expectThat({ push, held }, held.whole, "the held list rested between rows");
        expectThat(
          { push, held, observed },
          observed.drift <= 0.5 && observed.scrolls.join() === String(held.scroll),
          "the drop moved the list",
        );
        expectSteady(observed, `a drop after a push of ${push}px`);
      }
      return { drops };
    },
  );
  await check(
    "a scroll of the person's that cuts into the glide takes the list over, held or dropped",
    async () => {
      const runs = [];
      for (const release of [false, true]) {
        await toTop();
        const tabs = (await webRows(stress.page)).filter((row) => row.kind === "tab");
        const key = tabs[1]!.key;
        const from = await box(stress.page, key);
        const pointer = { x: from.x + Math.min(60, from.width / 3), y: 0 };
        const view = (await stressList.boundingBox())!;
        pointer.y = view.y + view.height / 2;
        let cut = { gliding: false, person: 0, whole: false };
        let held = { scroll: 0, whole: false };
        await drag(stress.page, key, view.y + view.height + 22, {
          during: async () => {
            await stress.page.waitForTimeout(300);
            // Back inside, the push stops and the list glides on to a row.
            await stress.page.mouse.move(pointer.x, pointer.y);
            // A frame into that glide the person scrolls it back up, done before the next frame;
            // or drops it then too.
            cut = await stressList.evaluate(
              async (list, { release, pointer }) => {
                const frame = () => new Promise((done) => requestAnimationFrame(done));
                await frame();
                const before = list.scrollTop;
                await frame();
                const gliding = list.scrollTop !== before;
                list.scrollTop -= 80;
                const person = list.scrollTop;
                if (release)
                  window.dispatchEvent(
                    new PointerEvent("pointerup", {
                      pointerId: 1,
                      clientX: pointer.x,
                      clientY: pointer.y,
                      bubbles: true,
                    }),
                  );
                return {
                  gliding,
                  person,
                  whole: [...list.children].some(
                    (row) => Math.abs((row as HTMLElement).offsetTop - person) < 0.5,
                  ),
                };
              },
              { release, pointer },
            );
            await stress.page.waitForTimeout(700);
            held = await heldScroll();
          },
        });
        runs.push({ release, cut, held });
        expectThat({ release, cut }, cut.gliding && !cut.whole, "the cut did not land mid-glide");
        expectThat({ release, held }, held.whole, "the list rested between rows");
        expectThat(
          { release, cut, held },
          Math.abs(held.scroll - cut.person) <= 18.5,
          "the list went back to where the glide was going",
        );
      }
      return { runs };
    },
  );
  await check(
    "a wheel scroll while a row is held keeps it under the pointer and lands on whole rows",
    async () => {
      const runs = [];
      for (const delta of [50, 120]) {
        await toTop();
        const tabs = (await webRows(stress.page)).filter((row) => row.kind === "tab");
        const key = tabs[1]!.key;
        const from = await box(stress.page, key);
        // Pressed at its centre, the row's centre is the pointer's.
        const pointer = from.y + from.height / 2 + 60;
        let held = { scroll: 0, whole: false, centre: 0 };
        await drag(stress.page, key, pointer, {
          during: async () => {
            await stress.page.mouse.wheel(0, delta);
            await stress.page.waitForTimeout(600);
            const centre = await stressList.evaluate((list) => {
              const box = list
                .querySelector<HTMLElement>(':scope > [data-sort="lifted"]')!
                .getBoundingClientRect();
              return box.top + box.height / 2;
            });
            held = { ...(await heldScroll()), centre };
            await watchRows(stress.page, "pointerup");
          },
        });
        const observed = await rowsAfter(stress.page, key);
        runs.push({ delta, pointer, held, ...observed });
        expectThat({ delta, held }, held.scroll > 20, "the wheel did not scroll the list");
        expectThat(
          { delta, pointer, held },
          Math.abs(held.centre - pointer) <= 1,
          "the held row parted from the pointer",
        );
        expectThat({ delta, held }, held.whole, "the held list rested between rows");
        expectThat(
          { delta, held, observed },
          observed.drift <= 0.5 && observed.scrolls.join() === String(held.scroll),
          "the drop moved the list",
        );
        expectSteady(observed, `a drop after a wheel of ${delta}px`);
      }
      return { runs };
    },
  );
  await check("a group dropped while the list scrolls lands as steadily", async () => {
    await toTop();
    const [first, second] = (await webRows(stress.page)).filter((row) => row.kind === "tab");
    for (const [key, target] of [
      [first!.key, "New group"],
      [second!.key, "Steady"],
    ] as const) {
      await rowAt(stress.page, key).locator(".side-tab__main").click({ button: "right" });
      await stress.page.getByRole("menuitem", { name: "Add to group", exact: true }).click();
      await stress.page.getByRole("menuitem", { name: target, exact: true }).click();
      if (target === "New group") {
        const title = stress.page.getByRole("textbox", { name: "Group title" });
        await title.fill("Steady");
        await title.press("Enter");
      }
    }
    await stress.page.getByRole("button", { name: "Steady, 2 tabs", exact: true }).waitFor();
    await settle(stress.page);
    await toTop();
    const group = (await webRows(stress.page)).find((row) => row.kind === "group")!.key;
    const view = (await stressList.boundingBox())!;
    await drag(stress.page, group, view.y + view.height + 15, {
      during: () => watchRows(stress.page, "pointerup"),
    });
    const observed = await rowsAfter(stress.page, group);
    const moved = (await keys(stress.page)).indexOf(group);
    expectThat({ moved, observed }, moved > 4, "the group did not move down the list");
    expectThat({ observed }, observed.released > 100, "the drag did not scroll the list");
    expectSteady(observed, "a group drop");
    return { moved, ...observed };
  });
  await check(
    "a group held past the list's foot scrolls it to its end and no further",
    async () => {
      const group = (await webRows(stress.page)).find((row) => row.kind === "group")!.key;
      await stressList.evaluate((list, key) => {
        const row = list.querySelector<HTMLElement>(
          `:scope > [data-motion-key="${CSS.escape(key)}"]`,
        );
        list.scrollTop = row!.offsetTop;
      }, group);
      await stress.page.waitForTimeout(400);
      const view = (await stressList.boundingBox())!;
      let held = { scrolled: 0, end: 0 };
      await drag(stress.page, group, view.y + view.height + 24, {
        during: async () => {
          await stress.page.waitForTimeout(2500);
          // Its tabs fold away while it moves, so the end is where the folded list ends.
          held = await stressList.evaluate((list) => {
            const foot = list.lastElementChild as HTMLElement;
            return {
              scrolled: list.scrollTop,
              end: foot.offsetTop + foot.offsetHeight - list.clientHeight,
            };
          });
          await watchRows(stress.page, "pointerup");
        },
      });
      const landing = await rowsAfter(stress.page, group);
      expectThat(held, held.scrolled > 200, "the list did not scroll");
      expectThat(held, held.scrolled <= held.end + 1, "the list scrolled past its end");
      expectSteady(landing, "a group drop at the list's end");
      return { ...held, landing };
    },
  );
  await check("⌘↓ on the last row in view brings it into view as it slides", async () => {
    await toTop();
    const view = (await stressList.boundingBox())!;
    const tabs = (await webRows(stress.page)).filter((row) => row.kind === "tab" && !row.grouped);
    let key = tabs[0]!.key;
    for (const tab of tabs) {
      const row = await box(stress.page, tab.key);
      if (row.y + row.height > view.y + view.height) break;
      key = tab.key;
    }
    const before = (await keys(stress.page)).indexOf(key);
    await rowAt(stress.page, key).locator(".side-tab__main").focus();
    await watchRows(stress.page, "keydown");
    await stress.page.keyboard.press("Meta+ArrowDown");
    await settle(stress.page);
    const observed = await rowsAfter(stress.page, key);
    const after = (await keys(stress.page)).indexOf(key);
    expectThat({ before, after, observed }, after === before + 1, "⌘↓ did not move the tab");
    expectSteady(observed, "a ⌘↓ past the foot");
    return { before, after, ...observed };
  });
  await check("a scroll while rows slide comes to rest on whole rows, gliding", async () => {
    const runs = [];
    // One wheel notch over the list just after a ⌘↓ starts its slide: the scroll ends mid-slide.
    for (const delta of [100, 40]) {
      await toTop();
      const view = (await stressList.boundingBox())!;
      const tabs = (await webRows(stress.page)).filter((row) => row.kind === "tab" && !row.grouped);
      const key = tabs[3]!.key;
      await rowAt(stress.page, key).locator(".side-tab__main").focus();
      await stress.page.mouse.move(view.x + view.width / 2, view.y + view.height / 2);
      await watchRows(stress.page, "keydown");
      await stress.page.keyboard.press("Meta+ArrowDown");
      await stress.page.waitForTimeout(30);
      await stress.page.mouse.wheel(0, delta);
      const observed = await rowsAfter(stress.page, key);
      runs.push({ delta, ...observed });
      expectThat(observed, observed.jolt <= 2, "the rows jumped as the move landed");
      expectThat(observed, observed.snapped <= 0.5, "the list jumped when its snap resumed");
      expectThat(observed, observed.still && observed.whole, "the list did not rest on whole rows");
    }
    return { runs };
  });
  await check(
    "a tab dragged to the list's foot scrolls the list and lands at the end",
    async () => {
      const list = stressList;
      await toTop();
      const rows = (await webRows(stress.page)).filter((row) => row.kind === "tab");
      const first = rows[0]!.key;
      const existing = rows.map((row) => row.key);
      const view = (await list.boundingBox())!;
      const before = await list.evaluate((node) => node.scrollTop);
      const end = await list.evaluate((node) => node.scrollHeight - node.clientHeight);
      let scrolled = 0;
      const stats = await observe(stress.page, () =>
        // Pushed a row's height past the list's foot, the row scrolls it at full speed.
        drag(stress.page, first, view.y + view.height + 24, {
          during: async () => {
            await stress.page.waitForTimeout(4000);
            scrolled = await list.evaluate((node) => node.scrollTop);
            await shot(stress.page, "06-autoscroll.png");
            await watchRows(stress.page, "pointerup");
          },
        }),
      );
      const landing = await rowsAfter(stress.page, first);
      // Agents in this world keep opening tabs, which rightly land after it.
      const after = (await webRows(stress.page))
        .filter((row) => row.kind === "tab" && existing.includes(row.key))
        .map((row) => row.key);
      timings.autoscroll = stats;
      // Scrolling the list renders the sidebar a few times, drag or not (a wheel scroll does
      // too), so commits here are recorded; the reorder check proves the drag itself makes none.
      expectThat(
        { before, scrolled, last: after.at(-1), stats },
        scrolled > before + 200 && after.at(-1) === first && stats.childChanges === 0,
        "the list did not scroll the tab to its end",
      );
      // The held row never stretches the list: it scrolls to its end and no further.
      expectThat({ end, scrolled }, scrolled <= end + 1, "the list scrolled past its end");
      expectSteady(landing, "a drop at the list's end");
      return { before, end, scrolled, landing, stats };
    },
  );
  await check("with reduced motion a drop lands at once, without slides", async () => {
    await stress.page.emulateMedia({ reducedMotion: "reduce" });
    const rows = (await webRows(stress.page)).filter((row) => row.kind === "tab");
    const [first, , third] = rows;
    await stress.page
      .locator(".side-section--tabs .side-list")
      .evaluate((list) => (list.scrollTop = 0));
    await stress.page.waitForTimeout(300);
    // Every animation started is counted, not only those still running after the drop.
    await stress.page.evaluate(() => {
      const animate = Element.prototype.animate;
      const counter = { slides: 0 };
      Reflect.set(window, "__slides", counter);
      Element.prototype.animate = function (this: Element, ...args: Parameters<typeof animate>) {
        const animation = animate.apply(this, args);
        if (animation.id === "row-motion") counter.slides++;
        return animation;
      };
    });
    const target = await box(stress.page, third!.key);
    await drag(stress.page, first!.key, target.y + target.height / 2);
    const slides = await stress.page.evaluate(
      () => (Reflect.get(window, "__slides") as { slides: number }).slides,
    );
    const after = (await webRows(stress.page))
      .filter((row) => row.kind === "tab")
      .map((row) => row.key);
    expectThat(
      { slides, after },
      slides === 0 && after.indexOf(first!.key) === 2,
      "the reduced-motion drop slid or missed",
    );
    return { slides };
  });
  await check(
    "a tab dragged above a collapsed group at the list's top lands before it",
    async () => {
      await stress.page.emulateMedia({ reducedMotion: "no-preference" });
      await toTop();
      const [first, second] = await webRows(stress.page);
      expectThat(
        { first, second },
        first?.kind === "tab" && !first.grouped && second?.kind === "tab" && !second.grouped,
        "the list does not start with two loose tabs",
      );
      for (const [key, target] of [
        [first!.key, "New group"],
        [second!.key, "Top"],
      ] as const) {
        await rowAt(stress.page, key).locator(".side-tab__main").click({ button: "right" });
        await stress.page.getByRole("menuitem", { name: "Add to group", exact: true }).click();
        await stress.page.getByRole("menuitem", { name: target, exact: true }).click();
        if (target === "New group") {
          const title = stress.page.getByRole("textbox", { name: "Group title" });
          await title.fill("Top");
          await title.press("Enter");
        }
      }
      const header = stress.page.getByRole("button", { name: "Top, 2 tabs", exact: true });
      await header.waitFor();
      await settle(stress.page);
      await header.click();
      await stress.page.waitForFunction(
        () =>
          document
            .querySelector(".side-section--tabs .side-list > :first-child .side-tab-group__main")
            ?.getAttribute("aria-expanded") === "false",
      );
      await settle(stress.page);
      const rows = await webRows(stress.page);
      const loose = rows[1]!;
      expectThat({ rows: rows.slice(0, 3) }, loose.kind === "tab", "no loose tab below the group");
      const view = (await stressList.boundingBox())!;
      await drag(stress.page, loose.key, view.y - 12);
      const after = await webRows(stress.page);
      expectThat(
        { after: after.slice(0, 3) },
        after[0]?.key === loose.key &&
          after[0].kind === "tab" &&
          !after[0].grouped &&
          after[1]?.kind === "group" &&
          !after[1].expanded,
        "the tab did not land above the collapsed group",
      );
      return { after: after.slice(0, 3) };
    },
  );
  await stress.context.close();
} catch (error) {
  abort(error);
} finally {
  await web.close();
  await finishJourney(artifactDirectory, checks, { timings, trace });
}
