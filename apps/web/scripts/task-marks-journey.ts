/**
 * Failure checklist: subject/state independence, quiet done rows without dimming
 * failures, 16/20/22px optical sizes, pending/old metadata, generated arrival,
 * icon-only edits in rows/headers/occupants/cursors without new activity,
 * default locking, keyboard/focus, reduced motion, cursor contrast and the
 * isolated glass transport.
 * Evidence is captured from the production build at actual 1x and 2x density.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MockHostClient } from "@opensteer/client/mock";
import { markColorPaint } from "@opensteer/client/host";
import type { Page } from "playwright-core";
import { expectThat, finishJourney, journeyChecks, openMockWeb } from "./mock-web-journey.js";

const directory = process.env.OPENSTEER_TASK_MARKS_EVIDENCE_DIR
  ? path.resolve(process.env.OPENSTEER_TASK_MARKS_EVIDENCE_DIR)
  : await mkdtemp(path.join(tmpdir(), "opensteer-task-marks-evidence-"));
const flights = "thr_b21e07d4-9c3a-4f62-8e1d-73a5c0f4d912";
// "Build the new architecture", which handed out "Book a table for Friday".
const assigning = "thr_00000000-0000-4000-8000-000000000001";
const { checks, check, abort } = journeyChecks();
await mkdir(directory, { recursive: true });
const web = await openMockWeb("opensteer-task-marks");
const screenshots: string[] = [];
const capture = async (page: Page, name: string, density: number, selector?: string) => {
  await page.evaluate(() => document.fonts.ready);
  const file = path.join(directory, `${name}@${density}x.png`);
  if (selector) await page.locator(selector).screenshot({ path: file, animations: "disabled" });
  else await page.screenshot({ path: file, animations: "disabled" });
  screenshots.push(file);
};
try {
  for (const density of [1, 2]) {
    const context = await web.browser.newContext({
      deviceScaleFactor: density,
      viewport: { width: 1440, height: 1000 },
    });
    await context.route(
      (url) => url.origin !== web.origin,
      (route) => route.fulfill({ status: 204, body: "" }),
    );
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`${web.origin}/tasks/${flights}`);
    await page.locator(".conv-header .task-mark").waitFor();
    await page.evaluate(() => document.fonts.ready);

    await check(`${density}x · row identity, independent state and 20/22px artwork`, async () => {
      const observed = await page.evaluate(
        ({ id }) => {
          const row = document.querySelector(`.side-task[data-thread-id="${id}"]`)!;
          const mark = row.querySelector<HTMLElement>(".task-mark")!;
          const svg = mark.querySelector("svg")!;
          const head = document.querySelector(".conv-header .task-mark")!;
          const title = document.querySelector<HTMLElement>(".conv-header__name")!;
          return {
            titleFits: title.scrollWidth <= title.clientWidth,
            icon: mark.dataset.icon,
            aria: mark.getAttribute("aria-hidden"),
            box: mark.getBoundingClientRect().width,
            glyph: svg.getBoundingClientRect().width,
            stroke: getComputedStyle(svg).strokeWidth,
            header: head.getBoundingClientRect().width,
            headerText: document.querySelector(".conv-header")!.textContent,
            // The title names the task and its state; only a state that asks something of the
            // reader is said in visible words, and the ring around the mark shows work.
            headerLabel: document.querySelector(".conv-header__menu")?.getAttribute("aria-label"),
            headerRings: document.querySelectorAll(".conv-header .working-ring").length,
            state: row.querySelector(".task-state")?.getAttribute("data-state"),
          };
        },
        { id: flights },
      );
      expectThat(
        observed,
        observed.titleFits &&
          observed.icon === "plane" &&
          observed.box === 20 &&
          observed.glyph === 14 &&
          observed.header === 20 &&
          observed.state === "working" &&
          observed.aria === "true" &&
          observed.headerLabel === "Tokyo flights in May, working" &&
          observed.headerRings === 1,
        "row/header identity, geometry or state is wrong",
      );
      await capture(page, "sidebar", density, ".sidebar");
      return observed;
    });
    await check(
      `${density}x · searchable task picker, keyboard choice, default and focus`,
      async () => {
        await page.locator(".conv-header__menu").click();
        await page.locator('[data-action="change-icon"]').click();
        const picker = page.getByRole("dialog", { name: "Task icon", exact: true });
        await picker.waitFor();
        const count = await picker.locator(".workspace-icon-picker__grid button").count();
        expectThat(
          { count },
          count === 130 &&
            (await picker.getByRole("button", { name: "Initials", exact: true }).count()) === 0,
          "task icon catalog or default option is wrong",
        );
        await capture(page, "change-icon-picker", density);
        await picker.getByRole("searchbox", { name: "Search icons" }).fill("hotel");
        await picker.getByRole("searchbox", { name: "Search icons" }).press("Enter");
        await page.waitForFunction(
          () =>
            document.querySelector(".conv-header .task-mark")?.getAttribute("data-icon") ===
            "hotel",
        );
        const focused = await page
          .locator(".conv-header__menu")
          .evaluate((el) => el === document.activeElement);
        expectThat({ focused }, focused, "focus did not return to header opener");
        await page.locator(".conv-header__menu").click();
        await page.locator('[data-action="change-icon"]').click();
        await page.getByRole("button", { name: "Use default", exact: true }).click();
        await page.waitForFunction(
          () =>
            document.querySelector(".conv-header .task-mark")?.getAttribute("data-icon") ===
            "document",
        );
        await page.evaluate(async (id) => {
          const m = Reflect.get(window, "opensteerMock") as MockHostClient;
          await m.dispatch({
            type: "thread.icon.set",
            threadId: id,
            icon: "plane",
            idempotencyKey: "journey-restore-plane",
          });
        }, flights);
        return { count, focused, defaultIcon: "document" };
      },
    );
    // A task that handed out work draws the task it handed out with that task's own mark.
    await page.goto(`${web.origin}/tasks/${assigning}`);
    await page.locator(".agent-mark .task-mark").first().waitFor();
    await capture(page, "conversation-assignment", density);
    await check(`${density}x · assignment marks`, async () => {
      const marks = await page.locator(".agent-mark .task-mark").count();
      expectThat({ marks }, marks > 0, "assignment identity is wrong");
      return { marks };
    });
    await page.goto(`${web.origin}/`);
    await page.locator(".side-task[data-thread-id]").first().waitFor();
    await page.evaluate(async () => {
      const client = Reflect.get(window, "opensteerMock") as MockHostClient;
      const snapshot = client.getSnapshot();
      const task = snapshot.threads.find(
        (thread) => thread.listed && thread.purpose === "task" && thread.status === "idle",
      )!;
      const unread = task.latestRunCompletedAt;
      if (unread) await client.visitThread(task.id, unread);
      await client.setTaskDone(task.id, true);
    });
    await page.getByRole("button", { name: /^Done, \d+ tasks?$/u }).click();
    const doneList = page.getByRole("list", { name: "Done", exact: true });
    await doneList.locator(".side-task[data-thread-id]").first().waitFor();
    await check(`${density}x · quiet settled rows retain exceptional failure`, async () => {
      // Done shows in place of Tasks, so each list is read in its own view.
      const read = (done: boolean) =>
        page.locator(".side-task[data-thread-id]").evaluateAll(
          (rows, done) =>
            rows.map((row) => ({
              classes: row.className,
              done,
              state: row.querySelector(".task-state")?.getAttribute("data-state"),
              quiet: row.querySelector(".task-mark")?.classList.contains("task-mark--quiet"),
              unread:
                row
                  .querySelector(".side-task__main")
                  ?.getAttribute("aria-label")
                  ?.includes(", unread") ?? false,
              title: row.textContent,
            })),
          done,
        );
      const doneRows = await read(true);
      await page.getByRole("button", { name: "Back to Tasks", exact: true }).click();
      await page.getByRole("list", { name: "Tasks", exact: true }).waitFor();
      const observed = [...doneRows, ...(await read(false))];
      const quiet = observed.filter((row) => row.done && row.state === "finished");
      // A failure stays bright while it is news; once seen it settles like any stopped task.
      const failed = observed.filter((row) => row.state === "failed");
      const asking = observed.filter((row) => row.state === "needs-you");
      expectThat(
        { rows: observed },
        quiet.length > 0 &&
          quiet.every((row) => row.quiet) &&
          failed.length > 0 &&
          failed.every((row) => row.quiet === !row.unread) &&
          asking.length > 0 &&
          asking.every((row) => !row.quiet),
        "done rows are loud, an unread failure or an ask was muted, or a seen failure stays bright",
      );
      return { rows: observed };
    });
    await page.goto(`${web.origin}/tasks/${flights}`);
    await page.locator(".side-tab").first().waitFor();
    const current = await page.evaluate(() => {
      const m = Reflect.get(window, "opensteerMock") as MockHostClient;
      m.scriptPlaces();
      const s = m.getSnapshot();
      return {
        run: s.runQueue.find((run) => run.threadId === "thr_b21e07d4-9c3a-4f62-8e1d-73a5c0f4d912")!,
        tabId: [...s.tabs.rows.values()].find(
          (row) => row.kind === "page" && row.title === "Launch brief",
        )!.tabId as string,
      };
    });
    await page.evaluate(
      ({ id, tabId }) =>
        (Reflect.get(window, "opensteerMock") as MockHostClient).actInPlace(id, tabId),
      { id: flights, tabId: current.tabId },
    );
    await page.locator(`.side-tab[data-place-key="${current.tabId}"] .side-tab__main`).click();
    await page.locator(".browser-stage .cursor-layer--middle").waitFor();
    // The page this device shows for the tab, which choosing the tab bound.
    const viewer = await page
      .waitForFunction((tabId) => {
        const viewer = (Reflect.get(window, "opensteerMock") as MockHostClient).tabViewer(tabId);
        return viewer?.kind === "page"
          ? { sessionId: viewer.sessionId as string, id: viewer.surfaceId as string }
          : null;
      }, current.tabId)
      .then((handle) => handle.jsonValue() as Promise<{ sessionId: string; id: string }>);
    const tab = { ...viewer, title: "Launch brief" };
    await page.waitForFunction(
      ({ sessionId, id }) =>
        (Reflect.get(window, "opensteerMock") as MockHostClient).browserWatchFrame(
          sessionId,
          id,
        ) !== null &&
        (document.querySelector(".browser-stage canvas")?.getBoundingClientRect().width ?? 0) > 0,
      tab,
    );
    await page.clock.install();
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);
    await page.evaluate(
      ({ id, tab, tabId, run }) => {
        const m = Reflect.get(window, "opensteerMock") as MockHostClient;
        const now = Date.now();
        const geometryRevision =
          m.browserWatchFrame(tab.sessionId, tab.id)?.header.geometryRevision ?? 1;
        // The Host says where a Run acts by the tab it acts in.
        m.scriptPlaces().apply({
          type: "host.place-activity",
          activity: {
            tabId,
            threadId: id,
            runId: run.id,
            generation: 1,
            seq: 1,
            order: 1000,
            at: now,
            expiresAt: now + 15000,
            pointer: { x: 0.35, y: 0.3 },
            geometryRevision,
          },
        });
      },
      { id: flights, tab, tabId: current.tabId, run: current.run },
    );
    const cursor = page.locator(`.browser-stage .acur[data-thread-id="${flights}"]`);
    await page.waitForFunction(
      ({ sessionId, id }) =>
        (Reflect.get(window, "opensteerMock") as MockHostClient).browserWatchFrame(
          sessionId,
          id,
        ) !== null &&
        (document.querySelector(".browser-stage canvas")?.getBoundingClientRect().width ?? 0) > 0,
      tab,
    );
    await cursor.locator(".acur__ptr").waitFor();
    await capture(page, "cursor-over-page", density);
    await check(
      `${density}x · icon-only edit reaches cursor and occupants without new activity`,
      async () => {
        const beforeArt = await cursor.locator(".workspace-icon-glyph").innerHTML();
        await page.evaluate(async (id) => {
          const m = Reflect.get(window, "opensteerMock") as MockHostClient;
          await m.dispatch({
            type: "thread.icon.set",
            threadId: id,
            icon: "hotel",
            idempotencyKey: "journey-cursor-hotel",
          });
        }, flights);
        await page.waitForFunction(
          (id) =>
            document
              .querySelector(`.side-task[data-thread-id="${id}"] .task-mark`)
              ?.getAttribute("data-icon") === "hotel",
          flights,
        );
        const observed = {
          cursorGlyph: await cursor.locator(".workspace-icon-glyph").count(),
          cursorArt: await cursor.locator(".workspace-icon-glyph").innerHTML(),
          occupants: await page
            .locator(`.occupant-mark[data-thread-id="${flights}"] .task-mark[data-icon="hotel"]`)
            .count(),
          color: await cursor.evaluate((el) =>
            getComputedStyle(el).getPropertyValue("--acur-color").trim(),
          ),
          label: await cursor.locator(".acur__name").textContent(),
        };
        expectThat(
          observed,
          observed.cursorGlyph === 1 &&
            observed.cursorArt !== beforeArt &&
            observed.occupants > 0 &&
            observed.color === markColorPaint.lime.cursor &&
            observed.label === "Tokyo flights in May",
          "live icon edit did not propagate to occupants/cursor",
        );
        await page.emulateMedia({ reducedMotion: "reduce" });
        const animations = await page
          .locator(".working-ring:not([data-settling])")
          .evaluateAll((els) => els.map((el) => getComputedStyle(el).animationName));
        expectThat(
          { animations },
          animations.length > 0 && animations.every((name) => name === "none"),
          "working rings still turn under reduced motion",
        );
        return { ...observed, animations };
      },
    );
    await check(`${density}x · no renderer errors`, async () => {
      expectThat({ pageErrors }, pageErrors.length === 0, "renderer errors occurred");
      return { pageErrors };
    });
    await context.close();
  }
} catch (error) {
  abort(error);
} finally {
  await web.close();
}
await finishJourney(directory, checks, {
  artifactDirectory: directory,
  screenshots,
  palette: markColorPaint,
  command: "pnpm --filter @opensteer/web test:task-marks",
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  viewport: { width: 1440, height: 1000 },
  densities: [1, 2],
});
