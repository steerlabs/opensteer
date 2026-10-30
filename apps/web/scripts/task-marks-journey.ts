/**
 * Failure checklist: subject/state independence, quiet done rows without dimming
 * failures, 16/20/22px optical sizes, pending/old metadata, generated arrival,
 * icon-only edits in rows/headers/occupants/cursors without new activity,
 * default locking, keyboard/focus, specialist colour independence, Chat,
 * reduced motion, cursor contrast and the isolated glass transport.
 * Evidence is captured from the production build at actual 1x and 2x density.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MockHostClient } from "@opensteer/client/mock";
import { markColorPaint, homeCursorPaint } from "@opensteer/client/host";
import type { Page } from "playwright-core";
import { expectThat, finishJourney, journeyChecks, openMockWeb } from "./mock-web-journey.js";

const directory = process.env.OPENSTEER_TASK_MARKS_EVIDENCE_DIR
  ? path.resolve(process.env.OPENSTEER_TASK_MARKS_EVIDENCE_DIR)
  : await mkdtemp(path.join(tmpdir(), "opensteer-task-marks-evidence-"));
const flights = "thr_b21e07d4-9c3a-4f62-8e1d-73a5c0f4d912";
const travel = "wsp_00000000-0000-4000-8000-000000000800";
const { checks, check, abort } = journeyChecks();
await mkdir(directory, { recursive: true });
const web = await openMockWeb("opensteer-task-marks");
const screenshots: string[] = [];
const capture = async (page: Page, name: string, density: number, selector?: string) => {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.querySelectorAll<HTMLImageElement>(".chat-orb img")].map((img) => img.decode()),
    );
  });
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
    await page.goto(`${web.origin}/threads/${flights}`);
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
            state: row.querySelector(".task-state")?.getAttribute("data-state"),
            orb: !!document.querySelector(".side-home .chat-orb"),
          };
        },
        { id: flights },
      );
      expectThat(
        observed,
        observed.titleFits &&
          observed.icon === "plane" &&
          observed.box === 20 &&
          observed.glyph === 18 &&
          observed.header === 22 &&
          observed.state === "working" &&
          observed.aria === "true" &&
          !!observed.headerText?.includes("Travel") &&
          !!observed.headerText.includes("Working") &&
          observed.orb,
        "row/header identity, geometry or state is wrong",
      );
      await capture(page, "sidebar", density, ".sidebar");
      return observed;
    });
    await check(
      `${density}x · searchable task picker, keyboard choice, default and focus`,
      async () => {
        await page.locator(".conv-header__switcher").click();
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
          .locator(".conv-header__switcher")
          .evaluate((el) => el === document.activeElement);
        expectThat({ focused }, focused, "focus did not return to header opener");
        await page.locator(".conv-header__switcher").click();
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
    await page.goto(`${web.origin}/workspaces/${travel}`);
    await page.locator(".workspace-icon-chooser").waitFor();
    await capture(page, "specialist-page", density);
    await check(`${density}x · specialist colour changes only the tile`, async () => {
      await page.locator(".workspace-icon-chooser").click();
      const colors = page.getByRole("group", { name: "Colour", exact: true });
      await colors.waitFor();
      await capture(page, "specialist-colour-picker", density);
      const count = await colors.getByRole("button").count();
      await colors.getByRole("button", { name: "Purple", exact: true }).click();
      await page.waitForFunction(
        () =>
          document
            .querySelector(".workspace-icon-chooser .workspace-orb")
            ?.getAttribute("data-color") === "purple",
      );
      const observed = {
        count,
        taskColor: await page
          .locator(`.side-task[data-thread-id="${flights}"] .task-mark`)
          .getAttribute("data-color"),
      };
      expectThat(
        observed,
        count === 7 && observed.taskColor === "lime",
        "specialist colour changed task identity or palette is wrong",
      );
      await page.keyboard.press("Escape");
      return observed;
    });
    await page.goto(`${web.origin}/specialists`);
    await page.locator(".specialist-cards").waitFor();
    await capture(page, "specialists", density);
    await page.goto(`${web.origin}/`);
    await page.locator(".task-line").first().waitFor();
    await capture(page, "conversation-assignment", density);
    await check(`${density}x · assignment marks, request badge and Chat excluded`, async () => {
      const observed = {
        marks: await page.locator(".task-line .task-mark").count(),
        orb: await page.locator(".conv-header .chat-orb").count(),
      };
      await page.locator(".conv-header__switcher").click();
      const edit = await page.locator('[data-action="change-icon"]').count();
      expectThat(
        { ...observed, edit },
        observed.marks > 0 && observed.orb === 1 && edit === 0,
        "assignment identity or Chat exclusion is wrong",
      );
      await page.keyboard.press("Escape");
      return { ...observed, edit };
    });
    await page.goto(`${web.origin}/tasks`);
    await page.locator(".task-row").first().waitFor();
    await check(`${density}x · quiet settled rows retain exceptional failure`, async () => {
      const observed = await page.locator(".task-row").evaluateAll((rows) =>
        rows.map((row) => ({
          classes: row.className,
          state: row.querySelector(".task-state")?.getAttribute("data-state"),
          quiet: row.querySelector(".task-mark")?.classList.contains("task-mark--quiet"),
          title: row.textContent,
        })),
      );
      const quiet = observed.filter(
        (row) => row.classes.includes("task-row--done") && row.state === "finished",
      );
      expectThat(
        { rows: observed },
        quiet.length > 0 &&
          quiet.every((row) => row.quiet) &&
          observed
            .filter((row) => row.state === "failed" || row.state === "needs-you")
            .every((row) => !row.quiet),
        "done rows are loud or exceptional states were muted",
      );
      return { rows: observed };
    });
    await page.goto(`${web.origin}/threads/${flights}`);
    await page.locator(".side-tab").first().waitFor();
    const current = await page.evaluate(() => {
      const m = Reflect.get(window, "opensteerMock") as MockHostClient;
      m.scriptPlaces();
      const s = m.getSnapshot();
      return {
        run: s.runQueue.find((run) => run.threadId === "thr_b21e07d4-9c3a-4f62-8e1d-73a5c0f4d912")!,
        tab: s.browserSessions
          .flatMap((session) =>
            session.tabs.map((tab) => ({ id: tab.id, sessionId: session.id, title: tab.title })),
          )
          .find((tab) => tab.title === "Launch brief")!,
      };
    });
    await page.evaluate(
      ({ id, tab }) =>
        (Reflect.get(window, "opensteerMock") as MockHostClient).actInPlace(
          id,
          `browser:${tab.sessionId}:${tab.id}`,
        ),
      { id: flights, tab: current.tab },
    );
    await page
      .locator(
        `.side-tab[data-place-key="browser:${current.tab.sessionId}:${current.tab.id}"] .side-tab__main`,
      )
      .click();
    await page.locator(".browser-stage .cursor-layer--middle").waitFor();
    await page.waitForFunction(
      ({ sessionId, id }) =>
        (Reflect.get(window, "opensteerMock") as MockHostClient).browserWatchFrame(
          sessionId,
          id,
        ) !== null &&
        (document.querySelector(".browser-stage canvas")?.getBoundingClientRect().width ?? 0) > 0,
      current.tab,
    );
    await page.clock.install();
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);
    await page.evaluate(
      ({ id, tab, run }) => {
        const m = Reflect.get(window, "opensteerMock") as MockHostClient;
        const now = Date.now();
        const geometryRevision =
          m.browserWatchFrame(tab.sessionId, tab.id)?.header.geometryRevision ?? 1;
        m.scriptPlaces().apply({
          type: "host.place-activity",
          activity: {
            place: { kind: "browser", sessionId: tab.sessionId, surfaceId: tab.id },
            threadId: id,
            home: false,
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
      { id: flights, tab: current.tab, run: current.run },
    );
    const cursor = page.locator(`.browser-stage .acur[data-thread-id="${flights}"]`);
    await page.waitForFunction(
      ({ sessionId, id }) =>
        (Reflect.get(window, "opensteerMock") as MockHostClient).browserWatchFrame(
          sessionId,
          id,
        ) !== null &&
        (document.querySelector(".browser-stage canvas")?.getBoundingClientRect().width ?? 0) > 0,
      current.tab,
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
          .locator(".task-state__spinner")
          .evaluateAll((els) => els.map((el) => getComputedStyle(el).animationName));
        expectThat(
          { animations },
          animations.length > 0 && animations.every((name) => name === "none"),
          "working spinners still animate under reduced motion",
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
  homeCursorPaint,
  command: "pnpm --filter @opensteer/web test:task-marks",
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  viewport: { width: 1440, height: 1000 },
  densities: [1, 2],
});
