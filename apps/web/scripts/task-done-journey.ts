/**
 * Failure checklist: running work in the wrong group; destructive Done without
 * confirmation; Keep working mutating shared state; unread results hidden by
 * Done; reading failing to regroup; a Done composer that does not say sending
 * reopens the task; Reopen restarting work or leaving it in Done; unnecessary
 * stopped confirmation, or staying on the task Done moved away; Done leaking
 * into Chat; a missing Done view.
 * Runs the production web app against MockHostClient in headless Chromium.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import type { MockHostClient } from "@opensteer/client/mock";
import type { Page } from "playwright-core";
import { expectThat, finishJourney, journeyChecks, openMockWeb } from "./mock-web-journey.js";

const directory = process.env.OPENSTEER_TASK_DONE_EVIDENCE_DIR
  ? path.resolve(process.env.OPENSTEER_TASK_DONE_EVIDENCE_DIR)
  : await mkdtemp("/tmp/opensteer-task-done-evidence-");
const running = "thr_b21e07d4-9c3a-4f62-8e1d-73a5c0f4d912";
const unread = "thr_1d6c4f8a-e29b-47d1-b5a3-9f02c8e6d17a";
const { checks, check, abort } = journeyChecks();
const screenshots: string[] = [];
await mkdir(directory, { recursive: true });

// Done is a view that takes the place of Tasks: one list, labelled by its heading.
const tasksList = (page: Page) => page.getByRole("list", { name: "Tasks", exact: true });
const doneList = (page: Page) => page.getByRole("list", { name: "Done", exact: true });
const doneLine = (page: Page) => page.getByRole("button", { name: /^Done, \d+ tasks?$/u });
const groupRow = (page: Page, group: string, id: string) => {
  const working = ":is(.side-task--working, .side-task--waiting, .side-task--needs-you)";
  if (group === "done")
    return doneList(page).locator(`.side-task[data-thread-id="${id}"] .side-task__main`);
  const selector = `.side-task${group === "working" ? working : `:not(${working})`}`;
  return tasksList(page).locator(`${selector}[data-thread-id="${id}"] .side-task__main`);
};
/** Opens Done from its line at the foot of Tasks. */
async function openDone(page: Page) {
  if ((await doneList(page).count()) === 0) await doneLine(page).click();
  await doneList(page).waitFor();
}
async function backToTasks(page: Page) {
  if ((await doneList(page).count()) > 0)
    await page.getByRole("button", { name: "Back to Tasks", exact: true }).click();
  await tasksList(page).waitFor();
}
const sideRow = (page: Page, id: string) => page.locator(`.side-task[data-thread-id="${id}"]`);
const state = (page: Page, id: string) =>
  page.evaluate((threadId) => {
    const snapshot = (Reflect.get(window, "opensteerMock") as MockHostClient).getSnapshot();
    return {
      thread: snapshot.threads.find((thread) => thread.id === threadId),
      read: snapshot.threadVisits[threadId],
      runs: snapshot.runQueue.filter((run) => run.threadId === threadId),
    };
  }, id);
async function capture(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  const file = path.join(directory, `${name}.png`);
  await page.screenshot({ path: file, animations: "disabled", fullPage: true });
  screenshots.push(file);
  return file;
}
async function step(page: Page, name: string, run: () => Promise<Record<string, unknown>>) {
  await check(name, async () => {
    try {
      return await run();
    } finally {
      // Capture failures too, before another check changes the screen.
      await capture(page, name);
    }
  });
}
async function sidebarDone(page: Page, id: string) {
  await sideRow(page, id).locator(".side-task__main").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Mark Done", exact: true }).click();
}

let web: Awaited<ReturnType<typeof openMockWeb>> | undefined;
try {
  web = await openMockWeb("opensteer-task-done");
  const context = await web.browser.newContext({ viewport: { width: 1440, height: 1000 } });
  context.setDefaultTimeout(5000);
  await context.route(
    (url) => url.origin !== web!.origin,
    (route) => route.fulfill({ status: 204, body: "" }),
  );
  await context.addInitScript("globalThis.__name = (value) => value;");
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${web.origin}/tasks`);
  await page.locator(".side-task[data-thread-id]").first().waitFor();

  await step(page, "01-running-is-working", async () => {
    await groupRow(page, "working", running).waitFor();
    const observed = await state(page, running);
    expectThat(
      { ...observed },
      observed.thread?.status === "running" && observed.thread.doneAt === null,
      "fixture is not running open work",
    );
    return observed;
  });
  await step(page, "02-sidebar-done-asks-first", async () => {
    await sidebarDone(page, running);
    const dialog = page.getByRole("dialog", { name: "Stop and mark Done?", exact: true });
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "Keep working", exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Mark Done", exact: true }).waitFor();
    const observed = await state(page, running);
    expectThat(
      observed,
      observed.thread?.doneAt === null && observed.thread.status === "running",
      "asking for confirmation already changed the task",
    );
    return { ...observed, confirmation: await dialog.innerText() };
  });
  await step(page, "03-keep-working-preserves-working", async () => {
    await page.getByRole("button", { name: "Keep working", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Stop and mark Done?", exact: true })
      .waitFor({ state: "hidden" });
    await groupRow(page, "working", running).waitFor();
    const observed = await state(page, running);
    expectThat(
      observed,
      observed.thread?.doneAt === null && observed.thread.status === "running",
      "Keep working stopped or marked the task Done",
    );
    return observed;
  });
  await step(page, "04-confirm-done-leaves-working", async () => {
    await sidebarDone(page, running);
    await page
      .getByRole("dialog", { name: "Stop and mark Done?", exact: true })
      .getByRole("button", { name: "Mark Done", exact: true })
      .click();
    await groupRow(page, "working", running).waitFor({ state: "hidden" });
    await openDone(page);
    await page.waitForFunction((id) => {
      const s = (Reflect.get(window, "opensteerMock") as MockHostClient).getSnapshot();
      const t = s.threads.find((thread) => thread.id === id);
      return t?.doneAt != null && t.status === "idle" && !t.inputQueuePaused;
    }, running);
    const observed = await state(page, running);
    expectThat(
      observed,
      !observed.runs.some((run) =>
        ["queued", "starting", "running", "waiting"].includes(run.status),
      ),
      "Done left active work",
    );
    return observed;
  });
  await step(page, "05-unread-done-stays-ready", async () => {
    await backToTasks(page);
    await groupRow(page, "ready", unread).waitFor();
    const before = await state(page, unread);
    expectThat(before, before.thread?.unread === true, "fixture has no unread result");
    await sidebarDone(page, unread);
    await page.waitForFunction(
      (id) =>
        (Reflect.get(window, "opensteerMock") as MockHostClient)
          .getSnapshot()
          .threads.find((thread) => thread.id === id)?.doneAt != null,
      unread,
    );
    await groupRow(page, "ready", unread).waitFor();
    const observed = await state(page, unread);
    await openDone(page);
    const inDone = await groupRow(page, "done", unread).count();
    await backToTasks(page);
    expectThat(
      { ...observed, inDone },
      observed.thread?.unread === true && inDone === 0,
      "Done hid the unread result",
    );
    return { ...observed, inDone };
  });
  await step(page, "06-reading-moves-to-done", async () => {
    await groupRow(page, "ready", unread).click();
    await page
      .locator(".conv-header__name")
      .filter({ hasText: "Blue loveseat shortlist" })
      .waitFor();
    await page.waitForFunction(
      (id) =>
        (Reflect.get(window, "opensteerMock") as MockHostClient)
          .getSnapshot()
          .threads.find((thread) => thread.id === id)?.unread === false,
      unread,
    );
    // While it is open it stays where the list showed it; once the reader leaves, it moves.
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await page.waitForURL((url) => !url.pathname.endsWith(unread));
    await groupRow(page, "ready", unread).waitFor({ state: "hidden" });
    const inReady = await groupRow(page, "ready", unread).count();
    await openDone(page);
    await groupRow(page, "done", unread).waitFor();
    expectThat({ inReady }, inReady === 0, "read Done task remains in Ready");
    return state(page, unread);
  });
  await step(page, "07-done-composer-says-sending-reopens", async () => {
    await groupRow(page, "done", unread).click();
    const composer = page.locator(".input-surface");
    await composer.locator(".input-surface__done").waitFor();
    const text = (await composer.locator(".input-surface__done").innerText())
      .replace(/\s+/gu, " ")
      .trim();
    const inputs = await composer.getByRole("textbox", { name: "Message", exact: true }).count();
    const reopen = await composer.getByRole("button", { name: "Reopen", exact: true }).count();
    expectThat(
      { text, inputs, reopen },
      text === "Done · Sending reopens it" && inputs === 1 && reopen === 0,
      "Done composer text, its message input or its lack of a Reopen button is wrong",
    );
    return { text, inputs, reopen };
  });
  await step(page, "08-reopen-restores-input-and-leaves-done", async () => {
    await page.locator(".conv-header__menu").click();
    await page
      .getByRole("group", { name: "This task", exact: true })
      .getByRole("button", { name: "Reopen", exact: true })
      .click();
    await page.locator(".input-surface__done").waitFor({ state: "hidden" });
    await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
    await capture(page, "08-reopened-composer");
    const observed = await state(page, unread);
    expectThat(
      observed,
      observed.thread?.doneAt === null &&
        observed.thread.status === "idle" &&
        !observed.thread.inputQueuePaused,
      "Reopen did not leave the task idle and open",
    );
    // Tasks offers New task; Done, open since 07, offers the way back.
    await backToTasks(page);
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await page.waitForURL((url) => !url.pathname.endsWith(unread));
    await openDone(page);
    const inDone = await groupRow(page, "done", unread).count();
    await backToTasks(page);
    await groupRow(page, "ready", unread).waitFor();
    expectThat({ inDone }, inDone === 0, "Reopen left the task in Done");
    return { ...observed, inDone };
  });
  await step(page, "09-stopped-title-done-needs-no-confirmation", async () => {
    await groupRow(page, "ready", unread).click();
    await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
    await page.locator(".conv-header__menu").click();
    await capture(page, "09-title-menu");
    await page
      .getByRole("group", { name: "This task", exact: true })
      .getByRole("button", { name: "Mark Done", exact: true })
      .click();
    // Done on the task in view moves on to the next one in the list.
    await page.waitForURL(
      (url) => url.pathname.startsWith("/tasks/thr_") && !url.pathname.endsWith(unread),
    );
    const confirmations = await page.getByText("Stop and mark Done?", { exact: true }).count();
    const observed = await state(page, unread);
    const opened = new URL(page.url()).pathname;
    expectThat(
      { ...observed, confirmations, opened },
      observed.thread?.doneAt != null && confirmations === 0,
      "stopped title action asked for confirmation or failed to apply",
    );
    return { ...observed, confirmations, opened };
  });
  await step(page, "10-chat-has-no-done", async () => {
    await page.locator(".side-home__main").click();
    await page.locator(".conv-header .chat-orb").waitFor();
    const doneActions = await page
      .locator(".conv-header, .input-surface")
      .getByRole("button", { name: /^(Mark Done|Reopen)$/u })
      .count();
    const menus = await page.locator(".conv-header__menu").count();
    expectThat(
      { doneActions, menus },
      doneActions === 0 && menus === 0,
      "Chat offers Done or Reopen",
    );
    return { doneActions, menus };
  });
  await step(page, "11-sidebar-done-line-and-view", async () => {
    await backToTasks(page);
    const label = await doneLine(page).getAttribute("aria-label");
    const lines = await page.locator(".side-done").count();
    // Enter on the Done line opens Done in place of Tasks.
    await doneLine(page).focus();
    await page.keyboard.press("Enter");
    await doneList(page).waitFor();
    await groupRow(page, "done", running).waitFor();
    await groupRow(page, "done", unread).waitFor();
    const count = await doneList(page).locator(".side-task[data-thread-id]").count();
    const heading = await page.locator("#sidebar-tasks").innerText();
    const shown = await page.locator(".side-head--done .side-head__count").innerText();
    expectThat(
      { count, label, lines, heading, shown },
      count >= 2 &&
        label === `Done, ${count} tasks` &&
        lines === 1 &&
        heading === "Done" &&
        shown === String(count),
      "Done line count, Done view rows or heading are wrong",
    );
    // Back to Tasks by keyboard, then Space on the Done line opens it again.
    const back = page.getByRole("button", { name: "Back to Tasks", exact: true });
    await back.focus();
    await page.keyboard.press("Space");
    await tasksList(page).waitFor();
    expectThat(
      {},
      (await doneList(page).count()) === 0 && (await doneLine(page).count()) === 1,
      "Back to Tasks did not bring Tasks back",
    );
    await doneLine(page).focus();
    await page.keyboard.press("Space");
    await groupRow(page, "done", unread).waitFor();
    expectThat(
      {},
      (await page.locator("#sidebar-tasks").innerText()) === "Done",
      "Space did not open Done",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: /^Open sidebar/u }).click();
    await page.locator(".sidebar--open").waitFor();
    const drawerButtons = page.locator(
      ".sidebar--open button:not(:disabled), .sidebar--open a[href], .sidebar--open input",
    );
    await drawerButtons.last().focus();
    await page.keyboard.press("Tab");
    expectThat(
      {},
      await drawerButtons.first().evaluate((node) => node === document.activeElement),
      "drawer did not wrap focus forward",
    );
    await page.keyboard.press("Shift+Tab");
    expectThat(
      {},
      await drawerButtons.last().evaluate((node) => node === document.activeElement),
      "drawer did not wrap focus backward",
    );
    await openDone(page);
    await groupRow(page, "done", unread).click();
    await page.locator(".sidebar--open").waitFor({ state: "hidden" });
    return { count, label, heading, shown };
  });
  await step(page, "12-no-browser-errors", async () => {
    expectThat({ errors }, errors.length === 0, "browser errors occurred");
    return { errors };
  });
  await context.close();
} catch (error) {
  abort(error);
} finally {
  await web?.close();
  await finishJourney(directory, checks, {
    screenshots,
    command: "pnpm --filter @opensteer/web test:task-done",
    head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    viewport: { width: 1440, height: 1000 },
  });
}
