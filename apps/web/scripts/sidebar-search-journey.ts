/**
 * ⌘K in the sidebar, in headless Chromium against the mock Host: the
 * production web build with real keyboard and pointer input. Search finds
 * tasks and tabs by what a person types and opens exactly the one chosen;
 * typing renders none of the lists under it and changes nothing on the Host;
 * closing it brings the lists back as they stood. Tabs runs to the footer's
 * line at any window height. Screenshots and the checks' observations are the
 * evidence.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { BrowserContext, Page } from "playwright-core";
import { expectThat, finishJourney, journeyChecks, openMockWeb } from "./mock-web-journey.js";

const artifactDirectory = path.resolve(
  process.env.OPENSTEER_SIDEBAR_SEARCH_EVIDENCE_DIR ??
    path.join(tmpdir(), "opensteer-sidebar-search-evidence"),
);
await mkdir(artifactDirectory, { recursive: true });
const { checks, check, abort } = journeyChecks();
const web = await openMockWeb("opensteer-sidebar-search-web");

/**
 * Counts, as React commits them, renders of the Sidebar and of every
 * component inside its lists: a component fiber new since the last commit
 * that performed work (React's flag 1) rendered. Bailed-out ones are cloned
 * without that flag; untouched ones keep their fiber.
 */
const renderCounter = `(() => {
  let seen = new WeakSet();
  let sidebar = null;
  const components = new Set([0, 1, 11, 14, 15]);
  const fiberOf = (root, node) => {
    const stack = [root.current];
    while (stack.length) {
      const fiber = stack.pop();
      if (!fiber) continue;
      if (fiber.stateNode === node) return fiber;
      stack.push(fiber.sibling, fiber.child);
    }
    return null;
  };
  globalThis.__listRenders = 0;
  globalThis.__sidebarRenders = 0;
  globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, renderers: new Map(), inject() { return 1; },
    onCommitFiberRoot(_, root) {
      const nav = document.getElementById("app-sidebar");
      const navFiber = nav && fiberOf(root, nav);
      if (navFiber) {
        let owner = navFiber.return;
        while (owner && typeof owner.type !== "function") owner = owner.return;
        if (owner && owner !== sidebar && (owner.flags & 1) === 1) globalThis.__sidebarRenders++;
        sidebar = owner;
      }
      const lists = document.querySelector(".sidebar__lists");
      const host = lists && fiberOf(root, lists);
      if (!host) return;
      const now = new WeakSet();
      const stack = [host.child];
      while (stack.length) {
        const fiber = stack.pop();
        if (!fiber) continue;
        if (components.has(fiber.tag)) {
          if (!seen.has(fiber) && (fiber.flags & 1) === 1) globalThis.__listRenders++;
          now.add(fiber);
        }
        stack.push(fiber.sibling, fiber.child);
      }
      seen = now;
    },
    onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {},
  };
})();`;

/**
 * The mock Host's client as the page has it, its updates held back while a
 * measurement runs (every render then is the page's own), and every call the
 * page makes on it recorded by name.
 */
const hostWatch = `(() => {
  let client = null;
  const held = { on: false, waiting: new Set() };
  globalThis.__calls = [];
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
      const names = new Set(Object.keys(value));
      for (let proto = Object.getPrototypeOf(value); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto))
        for (const name of Object.getOwnPropertyNames(proto)) names.add(name);
      for (const name of names) {
        if (name === "constructor" || typeof value[name] !== "function") continue;
        const original = value[name].bind(value);
        value[name] = name === "subscribe"
          ? (listener) => original(() => (held.on ? held.waiting.add(listener) : listener()))
          : (...args) => { globalThis.__calls.push(name); return original(...args); };
      }
    },
  });
})();`;

async function openWorld(
  options: {
    readonly width?: number;
    readonly height?: number;
    readonly world?: "busy" | "stress";
  } = {},
) {
  const width = options.width ?? 1440;
  const height = options.height ?? 1000;
  const context: BrowserContext = await web.browser.newContext({ viewport: { width, height } });
  await context.route(
    (url) => url.origin !== web.origin,
    (route) => route.fulfill({ body: "", status: 204 }),
  );
  await context.addInitScript("globalThis.__name = (value) => value;");
  await context.addInitScript(hostWatch);
  await context.addInitScript(renderCounter);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${web.origin}/?mock-world=${options.world ?? "busy"}`);
  await page.locator(".side-section--tabs .side-list > li").first().waitFor();
  await page.locator(".side-section--tasks .side-list > li").first().waitFor();
  // The world stops moving on its own, so every change is one a check makes.
  await page.evaluate(() =>
    (Reflect.get(window, "opensteerMock") as { scriptPlaces(): unknown }).scriptPlaces(),
  );
  await page.waitForTimeout(1500);
  return { context, page, errors };
}

const shot = (page: Page, name: string) =>
  page.locator(".sidebar").screenshot({ path: path.join(artifactDirectory, name) });

const field = (page: Page) => page.getByRole("combobox", { name: "Search tasks and tabs" });

/** What search shows now: its groups and options, in order, and which is chosen. */
async function results(page: Page) {
  return page.evaluate(() => {
    const listbox = document.getElementById("sidebar-results");
    const groups = [...(listbox?.querySelectorAll('[role="group"]') ?? [])].map((group) => ({
      heading: group.querySelector(".side-head")?.textContent?.trim() ?? "",
      options: [...group.querySelectorAll('[role="option"]')].map((option) => ({
        id: option.id,
        text: option.textContent?.trim() ?? "",
        title:
          option.querySelector(".side-tab__title, .side-task__title")?.textContent?.trim() ?? "",
        lit: [...option.querySelectorAll(".side-result__lit")].map((mark) => mark.textContent),
        selected: option.getAttribute("aria-selected") === "true",
        grouped: option.classList.contains("side-tab--grouped"),
      })),
    }));
    const input = document.getElementById("sidebar-search");
    return {
      open: input !== null,
      showing: document.querySelector(".side-results") !== null,
      listsInert: (document.querySelector(".sidebar__lists") as HTMLElement | null)?.inert ?? null,
      empty: document.querySelector(".side-results .sidebar__empty")?.textContent?.trim() ?? null,
      activeDescendant: input?.getAttribute("aria-activedescendant") ?? null,
      groups,
      options: groups.flatMap((group) => group.options),
    };
  });
}

/** Opens search with ⌘K and types `query` into it, a key at a time. */
async function search(page: Page, query: string) {
  if (
    !(await field(page)
      .isVisible()
      .catch(() => false))
  )
    await page.keyboard.press("Meta+k");
  await field(page).waitFor();
  await field(page).fill("");
  await page.keyboard.type(query);
  return results(page);
}

/** The place in the middle now, as the Tabs list marks it. */
function shownTab(page: Page) {
  return page.evaluate(
    () =>
      document
        .querySelector(".sidebar__lists .side-tab.is-active .side-tab__title")
        ?.textContent?.trim() ?? null,
  );
}

const focused = (page: Page) =>
  page.evaluate(() => {
    const element = document.activeElement;
    return {
      inLists: !!element?.closest(".sidebar__lists"),
      className: element instanceof HTMLElement ? element.className : null,
      title:
        element?.querySelector(".side-tab__title, .side-task__title")?.textContent?.trim() ?? null,
      placeKey: element?.closest<HTMLElement>("[data-place-key]")?.dataset.placeKey ?? null,
    };
  });

/** Closes the tabs with these titles through the mock Host, as another device would. */
async function closeTabs(page: Page, titles: readonly string[]) {
  await page.evaluate(async (wanted) => {
    const client = Reflect.get(window, "opensteerMock") as {
      getSnapshot(): {
        workspaceTabs?: { tabs: { id: string; title: string }[] }[];
      };
      closeWorkspaceTabs(ids: string[]): Promise<unknown>;
    };
    const tabs = (client.getSnapshot().workspaceTabs ?? []).flatMap((lineage) => lineage.tabs);
    const ids = wanted.map((title) => tabs.find((tab) => tab.title === title)?.id);
    if (ids.some((id) => !id)) throw new Error(`No tab titled ${wanted.join(", ")}`);
    await client.closeWorkspaceTabs(ids as string[]);
  }, titles);
}

/** Calls on the Host that change something, out of those recorded. */
function changes(calls: readonly string[]) {
  return calls.filter(
    (name) => !/^(get|read|subscribe|observe|place|browserWatch|retain|accept)/u.test(name),
  );
}

try {
  const { context, page, errors } = await openWorld();

  await check("⌘K finds tabs and tasks by title, best first, with the match lit", async () => {
    const found = await search(page, "nopa");
    await shot(page, "01-nopa.png");
    const tabs = found.groups.find((group) => group.heading === "Tabs");
    const tasks = found.groups.find((group) => group.heading === "Tasks");
    expectThat(
      { found },
      found.showing &&
        found.listsInert === true &&
        found.groups[0]?.heading === "Tabs" &&
        tabs?.options.map((option) => option.title).join("|") === "Nopa – Resy|Nopa – OpenTable",
      "the tabs named Nopa did not come first",
    );
    expectThat(
      { tasks },
      tasks?.options.some(
        (option) => option.title === "Book a table for Friday" && option.lit.includes("Nopa"),
      ) === true,
      "the task asking about Nopa was not found by its question, lit",
    );
    expectThat(
      { first: found.options[0], activeDescendant: found.activeDescendant },
      found.options[0]?.selected === true &&
        found.options[0].lit.join() === "Nopa" &&
        found.activeDescendant === found.options[0].id,
      "the best match is not the one chosen, or its match is not lit",
    );
    return { found };
  });

  await check(
    "typing renders no row of the lists, nor the sidebar, and changes nothing on the Host",
    async () => {
      await page.evaluate(() => {
        (Reflect.get(globalThis, "__holdHost") as () => void)();
        Reflect.set(globalThis, "__listRenders", 0);
        Reflect.set(globalThis, "__sidebarRenders", 0);
        Reflect.set(globalThis, "__calls", []);
      });
      for (const key of " resy") await page.keyboard.press(key === " " ? "Space" : key);
      await page.waitForTimeout(300);
      const counted = await page.evaluate(() => ({
        lists: Reflect.get(globalThis, "__listRenders") as number,
        sidebar: Reflect.get(globalThis, "__sidebarRenders") as number,
        calls: Reflect.get(globalThis, "__calls") as string[],
      }));
      const found = await results(page);
      await page.evaluate(() => (Reflect.get(globalThis, "__releaseHost") as () => void)());
      expectThat(
        { found },
        found.options.map((option) => option.title).join("|") === "Nopa – Resy",
        "typing on did not narrow the results",
      );
      expectThat(
        { counted },
        counted.lists === 0 && counted.sidebar === 0,
        "typing rendered the lists or the sidebar",
      );
      expectThat(
        { calls: counted.calls },
        changes(counted.calls).length === 0,
        "typing called on the Host",
      );
      // Proof the counter sees renders: closing search renders the sidebar.
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
      const closed = await page.evaluate(
        () => Reflect.get(globalThis, "__sidebarRenders") as number,
      );
      expectThat({ closed }, closed >= 1, "the sidebar's renders went uncounted");
      return { counted, closed };
    },
  );

  await check("a tab is found by its site, and says so where its title does not", async () => {
    const found = await search(page, "github");
    await shot(page, "02-github.png");
    expectThat(
      { found },
      found.options.length >= 1 &&
        found.options.every((option) => option.text.toLowerCase().includes("github")),
      "the tabs on github.com were not found by their site",
    );
    return { found };
  });

  await check(
    "a tab found by its profile says so, as its badge, and to a screen reader",
    async () => {
      const found = await search(page, "work");
      const badges = await page.evaluate(
        () => document.querySelectorAll('.side-results [role="option"] .pbadge').length,
      );
      expectThat(
        { found, badges },
        found.options.length >= 1 &&
          badges === found.options.length &&
          found.options.every((option) => option.text.includes("Work")),
        "a tab found by its profile did not say which",
      );
      return { options: found.options.length, badges };
    },
  );

  await check("a folded group's tabs are found, by title and by the group's name", async () => {
    const groupId = await page.evaluate(async () => {
      const client = Reflect.get(window, "opensteerMock") as {
        groupBrowserTabs(
          tabIds: string[],
          target: { title: string; color: string },
        ): Promise<string>;
        updateBrowserTabGroup(id: string, update: { collapsed: boolean }): Promise<void>;
      };
      const id = await client.groupBrowserTabs(["mock-tab-0-3", "mock-tab-0-4"], {
        title: "Weekend plans",
        color: "blue",
      });
      await client.updateBrowserTabGroup(id, { collapsed: true });
      return id;
    });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    const folded = await page.evaluate(
      () => document.querySelectorAll(".sidebar__lists .side-tab--grouped").length,
    );
    const byGroup = await search(page, "weekend plans");
    await shot(page, "03-group.png");
    const byTitle = await search(page, "lisbon");
    expectThat({ folded }, folded === 0, "the group did not fold its tabs in the list");
    expectThat(
      { byGroup },
      byGroup.options
        .filter((option) => option.grouped)
        .map((option) => option.title)
        .sort()
        .join("|") === "Inbox (3) – Gmail|Lisbon · Stays – Airbnb",
      "the group's name did not find its tabs",
    );
    expectThat(
      { byTitle },
      byTitle.groups
        .find((group) => group.heading === "Tabs")
        ?.options.some((option) => option.title === "Lisbon · Stays – Airbnb" && option.grouped) ===
        true,
      "a folded group's tab was not found by its title",
    );
    return { groupId, byGroup: byGroup.options.length, byTitle: byTitle.options };
  });

  await check(
    "Enter on a folded group's tab shows it, and its group's header takes the keyboard",
    async () => {
      const found = await search(page, "lisbon");
      const at = found.options.findIndex((option) => option.title === "Lisbon · Stays – Airbnb");
      for (let press = 0; press < at; press++) await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(400);
      const after = await results(page);
      const shown = await page.evaluate(() => {
        const header = document.querySelector(".sidebar__lists .side-tab-group.is-active");
        return { header: header !== null };
      });
      const keyboard = await focused(page);
      await shot(page, "04-group-chosen.png");
      expectThat(
        { after },
        !after.open && after.listsInert === false,
        "search did not close on Enter",
      );
      expectThat(
        { shown, keyboard },
        shown.header && keyboard.className?.includes("side-tab-group__main") === true,
        "the folded group's header did not stand for its shown tab",
      );
      return { shown, keyboard };
    },
  );

  await check(
    "↓ and Enter open exactly the tab chosen, close search, and hand the keyboard to its row",
    async () => {
      const found = await search(page, "nopa");
      await page.keyboard.press("ArrowDown");
      const moved = await results(page);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(400);
      const after = await results(page);
      const shown = await shownTab(page);
      const keyboard = await focused(page);
      await shot(page, "05-tab-chosen.png");
      expectThat(
        { moved },
        moved.options[1]?.selected === true && moved.activeDescendant === moved.options[1].id,
        "↓ did not choose the next result",
      );
      expectThat(
        { after, shown },
        !after.open && shown === found.options[1]?.title,
        "Enter did not show exactly the chosen tab",
      );
      expectThat(
        { keyboard },
        keyboard.inLists && keyboard.title === "Nopa – OpenTable",
        "the keyboard did not go on from the chosen tab's row",
      );
      return { chosen: found.options[1]?.title, shown, keyboard };
    },
  );

  await check("Enter on a task opens its conversation", async () => {
    const found = await search(page, "hyatt");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    const opened = await page.evaluate(() => ({
      path: location.pathname,
      row:
        document
          .querySelector('.sidebar__lists .side-task__main[aria-current="page"]')
          ?.textContent?.trim() ?? null,
    }));
    expectThat(
      { found, opened },
      found.options[0]?.title === "Hyatt Seoul booking" &&
        opened.path.startsWith("/threads/") &&
        opened.row?.startsWith("Hyatt Seoul booking") === true,
      "Enter did not open the task's conversation",
    );
    return { opened };
  });

  await check(
    "Enter on a Done task opens it, and the keyboard goes to the search button",
    async () => {
      const done = await page.evaluate(async () => {
        const row = document.querySelector<HTMLElement>(
          ".sidebar__lists .side-task--finished[data-thread-id]",
        )!;
        const threadId = row.dataset.threadId!;
        const title = row.querySelector(".side-task__title")!.textContent!.trim();
        await (
          Reflect.get(window, "opensteerMock") as {
            setTaskDone(id: string, done: boolean): Promise<unknown>;
          }
        ).setTaskDone(threadId, true);
        return { threadId, title };
      });
      await page.waitForFunction(
        (id) => !document.querySelector(`.sidebar__lists [data-thread-id="${id}"]`),
        done.threadId,
      );
      const found = await search(page, done.title);
      const at = found.options.findIndex((option) => option.title === done.title);
      for (let press = 0; press < at; press++) await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(400);
      const opened = await page.evaluate(() => ({
        path: location.pathname,
        focus: document.activeElement?.getAttribute("aria-label") ?? null,
      }));
      expectThat(
        { done, at, opened },
        at >= 0 &&
          opened.path === `/threads/${done.threadId}` &&
          opened.focus === "Search tasks and tabs",
        "the Done task did not open, or the keyboard was lost",
      );
      return { done, opened };
    },
  );

  await check(
    "Escape brings the lists back as they stood and the keyboard back where it was",
    async () => {
      await page.evaluate(() => {
        for (const list of document.querySelectorAll<HTMLElement>(".sidebar__lists .side-list"))
          list.scrollTop = list.scrollHeight;
      });
      await page.waitForTimeout(600);
      const row = page.locator(".sidebar__lists .side-tab__main").first();
      await row.focus();
      const before = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".sidebar__lists .side-list")].map(
          (list) => list.scrollTop,
        ),
      );
      const opener = await focused(page);
      await search(page, "a");
      await shot(page, "06-searching.png");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      const after = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".sidebar__lists .side-list")].map(
          (list) => list.scrollTop,
        ),
      );
      const state = await results(page);
      const keyboard = await focused(page);
      expectThat(
        { state },
        !state.open && !state.showing && state.listsInert === false,
        "Escape did not close search",
      );
      expectThat(
        { before, after },
        before.length === after.length &&
          before.every((top, index) => Math.abs(top - after[index]!) < 0.5),
        "the lists did not come back scrolled where they were",
      );
      expectThat(
        { opener, keyboard },
        keyboard.placeKey !== null && keyboard.placeKey === opener.placeKey,
        "the keyboard did not go back to where it was",
      );
      return { before, after, keyboard };
    },
  );

  await check("a chosen result that goes away hands the choice to the nearest", async () => {
    await search(page, "nopa");
    await page.keyboard.press("ArrowDown");
    const before = await results(page);
    await page.evaluate(async () => {
      const client = Reflect.get(window, "opensteerMock") as {
        closeWorkspaceTabs(ids: string[]): Promise<unknown>;
      };
      await client.closeWorkspaceTabs(["mock-tab-1-1"]);
    });
    await page.waitForTimeout(500);
    const after = await results(page);
    expectThat(
      { before, after },
      before.options[1]?.title === "Nopa – OpenTable" &&
        !after.options.some((option) => option.title === "Nopa – OpenTable") &&
        after.options[1]?.selected === true &&
        after.activeDescendant === after.options[1].id,
      "the choice did not move to the nearest result",
    );
    await page.keyboard.press("Escape");
    return { before: before.options.length, after: after.options };
  });

  await check("Enter while a word is being composed chooses nothing", async () => {
    await search(page, "nopa");
    await page.locator("#sidebar-search").dispatchEvent("keydown", {
      bubbles: true,
      cancelable: true,
      isComposing: true,
      key: "Enter",
    });
    await page.waitForTimeout(200);
    const state = await results(page);
    expectThat({ state }, state.open && state.showing, "a composing Enter chose a result");
    await page.keyboard.press("Escape");
    return { open: state.open };
  });

  await check("a query that finds nothing says so, calmly", async () => {
    const found = await search(page, "zzzz");
    await shot(page, "07-nothing.png");
    expectThat(
      { found },
      found.options.length === 0 && found.empty?.includes("zzzz") === true,
      "an empty search did not say so",
    );
    await page.keyboard.press("Escape");
    return { empty: found.empty };
  });

  await check("Tabs runs to the footer's line at every height, the one line there", async () => {
    const observed: Record<string, unknown> = {};
    for (const height of [1000, 800, 640]) {
      await page.setViewportSize({ width: 1440, height });
      await page.waitForTimeout(500);
      const edge = await page.evaluate(() => {
        const list = document.querySelector<HTMLElement>(".side-section--tabs .side-list")!;
        const tasks = document.querySelector<HTMLElement>(".side-section--tasks .side-list")!;
        const footer = document.querySelector<HTMLElement>(".sidebar__footer")!;
        const box = list.getBoundingClientRect();
        const tasksBox = tasks.getBoundingClientRect();
        const style = getComputedStyle(tasks);
        const tasksTop = tasksBox.top + parseFloat(style.borderTopWidth);
        const tasksBottom = tasksBox.bottom - parseFloat(style.borderBottomWidth);
        const tasksParts = [...tasks.children].filter((row) => {
          const r = row.getBoundingClientRect();
          const seen = Math.min(r.bottom, tasksBottom) - Math.max(r.top, tasksTop);
          return (
            r.height >= 2 && seen > 0.5 && (r.top < tasksTop - 0.5 || r.bottom > tasksBottom + 0.5)
          );
        }).length;
        return {
          overflows: list.scrollHeight > list.clientHeight + 0.5,
          band: footer.getBoundingClientRect().top - box.bottom,
          listLine: getComputedStyle(list).borderBottomWidth,
          footerLine: getComputedStyle(footer).borderTopWidth,
          tasksParts,
        };
      });
      // Scrolled to its end, its last row stands whole on the footer's line.
      await page.evaluate(() => {
        const list = document.querySelector<HTMLElement>(".side-section--tabs .side-list")!;
        list.scrollTop = list.scrollHeight;
      });
      await page.waitForTimeout(500);
      const end = await page.evaluate(() => {
        const list = document.querySelector<HTMLElement>(".side-section--tabs .side-list")!;
        const rows = [...list.children].filter((row) => row.getBoundingClientRect().height >= 2);
        return {
          lastFoot: rows.at(-1)!.getBoundingClientRect().bottom,
          footer: document.querySelector(".sidebar__footer")!.getBoundingClientRect().top,
        };
      });
      observed[height] = { ...edge, end };
      await shot(page, `08-edge-${height}.png`);
      expectThat(
        { height, end },
        Math.abs(end.lastFoot - end.footer) < 1,
        `at ${height}px Tabs' end does not stand its last row whole on the footer's line`,
      );
      expectThat(
        { height, edge },
        edge.overflows &&
          Math.abs(edge.band) < 0.5 &&
          edge.listLine === "0px" &&
          edge.footerLine === "1px",
        `at ${height}px Tabs stops short of the footer's line, or draws its own`,
      );
      expectThat(
        { height, edge },
        edge.tasksParts === 0,
        `at ${height}px Tasks shows a row in part`,
      );
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    return observed;
  });

  expectThat({ errors }, errors.length === 0, `page errors: ${errors.join("; ")}`);
  await context.close();

  await check(
    "in a narrow window, ⌘K opens the drawer to search; Escape closes search, then the drawer",
    async () => {
      const narrow = await openWorld({ width: 1100, height: 900 });
      try {
        // The keyboard starts in the conversation, which the open drawer puts out of reach.
        const opener = await narrow.page.evaluate(() => {
          const target = [
            ...document.querySelectorAll<HTMLElement>("textarea, [contenteditable='true'], button"),
          ].find((element) => !element.closest("#app-sidebar") && element.offsetParent !== null);
          target?.focus();
          return document.activeElement === target ? (target?.tagName ?? null) : null;
        });
        await narrow.page.keyboard.press("Meta+k");
        await narrow.page.locator(".sidebar--open").waitFor();
        await field(narrow.page).waitFor();
        const first = await focused(narrow.page);
        await narrow.page.keyboard.type("nopa");
        await shot(narrow.page, "09-drawer.png");
        const stops: boolean[] = [];
        for (let press = 0; press < 8; press++) {
          await narrow.page.keyboard.press("Tab");
          stops.push((await focused(narrow.page)).inLists);
        }
        await field(narrow.page).focus();
        await narrow.page.keyboard.press("Escape");
        await narrow.page.waitForTimeout(300);
        const afterSearch = await narrow.page.evaluate(() => ({
          drawer: document.querySelector(".sidebar--open") !== null,
          search: document.getElementById("sidebar-search") !== null,
          focus: document.activeElement?.getAttribute("aria-label") ?? null,
        }));
        await narrow.page.keyboard.press("Escape");
        await narrow.page.waitForTimeout(400);
        const afterDrawer = await narrow.page.evaluate(
          () => document.querySelector(".sidebar--open") !== null,
        );
        expectThat(
          { first },
          first.className?.includes("text-input") === true,
          "⌘K did not hand the keyboard to search in the drawer",
        );
        expectThat(
          { stops },
          stops.every((inLists) => !inLists),
          "Tab reached the lists under the results",
        );
        expectThat({ opener }, opener !== null, "nothing outside the sidebar took the keyboard");
        expectThat(
          { afterSearch, afterDrawer },
          afterSearch.drawer &&
            !afterSearch.search &&
            afterSearch.focus === "Search tasks and tabs" &&
            !afterDrawer,
          "Escape did not close search first, keyboard in the drawer, then the drawer",
        );
        expectThat({ errors: narrow.errors }, narrow.errors.length === 0, "page errors");
        return { stops, afterSearch, afterDrawer };
      } finally {
        await narrow.context.close();
      }
    },
  );
  const stress = await openWorld({ world: "stress", height: 800 });
  try {
    await check("a refined query chooses its best match, shown at the top", async () => {
      await search(stress.page, "supplier");
      for (let press = 0; press < 30; press++) await stress.page.keyboard.press("ArrowDown");
      const scrolled = await stress.page.evaluate(
        () => document.querySelector(".side-results__scroll")!.scrollTop,
      );
      await stress.page.keyboard.type(" quote");
      await stress.page.waitForTimeout(200);
      const refined = await results(stress.page);
      const shown = await stress.page.evaluate(() => {
        const scroller = document.querySelector(".side-results__scroll")!;
        const row = scroller.querySelector('[aria-selected="true"]')!.getBoundingClientRect();
        const view = scroller.getBoundingClientRect();
        return {
          scrollTop: scroller.scrollTop,
          inView: row.top >= view.top && row.bottom <= view.bottom,
        };
      });
      expectThat(
        { scrolled, refined: refined.options.length },
        scrolled > 0 && refined.options.length > 20,
        "this check needs results that scroll",
      );
      expectThat(
        { selected: refined.options.findIndex((option) => option.selected), shown },
        refined.options[0]?.selected === true && shown.scrollTop === 0 && shown.inView,
        "the refined query's best match is not chosen and in view",
      );
      return { scrolled, shown };
    });

    await check("as results change, the choice stays put, or goes to its neighbour", async () => {
      const found = await search(stress.page, "supplier");
      const titles = found.options.map((option) => option.title);
      await stress.page.keyboard.press("ArrowDown");
      await stress.page.keyboard.press("ArrowDown");
      await closeTabs(stress.page, [titles[0]!]);
      await stress.page.waitForTimeout(400);
      const kept = await results(stress.page);
      await closeTabs(stress.page, [titles[2]!]);
      await stress.page.waitForTimeout(400);
      const moved = await results(stress.page);
      const chosen = (state: typeof kept) => state.options.find((option) => option.selected)?.title;
      expectThat(
        { titles: titles.slice(0, 4), kept: chosen(kept), moved: chosen(moved) },
        chosen(kept) === titles[2] && chosen(moved) === titles[3],
        "the choice did not stay with its result, or go to the one after it",
      );
      await stress.page.keyboard.press("Escape");
      return { kept: chosen(kept), moved: chosen(moved) };
    });
    expectThat({ errors: stress.errors }, stress.errors.length === 0, "page errors");
  } finally {
    await stress.context.close();
  }
} catch (error) {
  abort(error);
} finally {
  await web.close();
  await finishJourney(artifactDirectory, checks);
}
