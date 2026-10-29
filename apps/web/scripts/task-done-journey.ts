/**
 * Failure checklist: running work in the wrong group; destructive Done without
 * confirmation; Keep working mutating shared state; unread results hidden by
 * Done; reading failing to regroup; a frozen composer still accepting input;
 * Reopen restarting work or retaining a frozen composer; unnecessary stopped
 * confirmation; Done leaking into Chat; missing Tasks headings.
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

const groupRow = (page: Page, group: string, id: string) =>
  page.locator(`ul[aria-labelledby="tasks-${group}"] a[href$="/threads/${id}"]`);
const sideRow = (page: Page, id: string) => page.locator(`.side-task[data-thread-id="${id}"]`);
const state = (page: Page, id: string) =>
  page.evaluate((threadId) => {
    const snapshot = (Reflect.get(window, "opensteerMock") as MockHostClient).getSnapshot();
    return {
      thread: snapshot.threads.find((thread) => thread.id === threadId),
      read: snapshot.threadReadStates[threadId],
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
  await page.locator(".tasks-page .task-row").first().waitFor();

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
    await groupRow(page, "ready", unread).waitFor();
    const before = await state(page, unread);
    expectThat(before, before.read?.unreadSequence != null, "fixture has no unread result");
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
    expectThat(
      observed,
      observed.read?.unreadSequence != null && (await groupRow(page, "done", unread).count()) === 0,
      "Done hid the unread result",
    );
    return observed;
  });
  await step(page, "06-reading-moves-to-done", async () => {
    await groupRow(page, "ready", unread).click();
    await page
      .locator(".conv-header__name")
      .filter({ hasText: "Blue loveseat shortlist" })
      .waitFor();
    await page.waitForFunction(
      (id) =>
        (Reflect.get(window, "opensteerMock") as MockHostClient).getSnapshot().threadReadStates[id]
          ?.unreadSequence === null,
      unread,
    );
    await page.getByRole("link", { name: "All tasks", exact: true }).click();
    await groupRow(page, "done", unread).waitFor();
    expectThat(
      {},
      (await groupRow(page, "ready", unread).count()) === 0,
      "read Done task remains in Ready",
    );
    return state(page, unread);
  });
  await step(page, "07-done-composer-is-frozen", async () => {
    await groupRow(page, "done", unread).click();
    const composer = page.locator(".input-surface");
    await composer.getByRole("button", { name: "Reopen", exact: true }).waitFor();
    const text = (await composer.innerText()).replace(/\s+/gu, " ").trim();
    const inputs = await composer.locator("textarea, [contenteditable=true]").count();
    expectThat(
      { text, inputs },
      text === "This task is Done · Reopen" && inputs === 0,
      "Done composer text or message-input exclusion is wrong",
    );
    return { text, inputs };
  });
  await step(page, "08-reopen-restores-input-and-leaves-done", async () => {
    await page
      .locator(".input-surface")
      .getByRole("button", { name: "Reopen", exact: true })
      .click();
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
    await page.getByRole("link", { name: "All tasks", exact: true }).click();
    await groupRow(page, "ready", unread).waitFor();
    expectThat(
      {},
      (await groupRow(page, "done", unread).count()) === 0,
      "Reopen left the task in Done",
    );
    return observed;
  });
  await step(page, "09-stopped-title-done-needs-no-confirmation", async () => {
    await groupRow(page, "ready", unread).click();
    await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
    await page.locator(".conv-header__switcher").click();
    await capture(page, "09-title-menu");
    await page
      .getByRole("group", { name: "This task", exact: true })
      .getByRole("button", { name: "Mark Done", exact: true })
      .click();
    await page
      .locator(".input-surface")
      .getByRole("button", { name: "Reopen", exact: true })
      .waitFor();
    const confirmations = await page.getByText("Stop and mark Done?", { exact: true }).count();
    const observed = await state(page, unread);
    expectThat(
      { ...observed, confirmations },
      observed.thread?.doneAt != null && confirmations === 0,
      "stopped title action asked for confirmation or failed to apply",
    );
    return { ...observed, confirmations };
  });
  await step(page, "10-chat-has-no-done", async () => {
    await page.locator(".side-home__main").click();
    await page.locator(".conv-header .chat-orb").waitFor();
    await page.locator(".conv-header__switcher").click();
    const menu = page.getByRole("dialog", { name: "Switch conversation", exact: true });
    await menu.waitFor();
    const doneActions = await menu.getByRole("button", { name: /^(Mark Done|Reopen)$/u }).count();
    expectThat({ doneActions }, doneActions === 0, "Chat offers Done or Reopen");
    return { doneActions, menu: await menu.innerText() };
  });
  await page.keyboard.press("Escape");
  await step(page, "11-tasks-working-ready-done-headings", async () => {
    await page.getByRole("link", { name: "All tasks", exact: true }).click();
    for (const group of ["working", "ready", "done"])
      await page.locator(`#tasks-${group}`).waitFor();
    const headings = await page.locator(".task-group__title").allTextContents();
    expectThat(
      { headings },
      headings.length === 3 &&
        headings.every((text, index) => text.startsWith(["Working", "Ready", "Done"][index]!)),
      "Tasks groups or order are wrong",
    );
    return { headings };
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
