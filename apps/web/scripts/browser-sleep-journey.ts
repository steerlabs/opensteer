/**
 * Pictures of every state a Cloud Computer's browser shows while it sleeps and wakes, on the
 * web and desktop app at desktop and phone widths, against the mock Host. Also checks each one
 * says what it should. Pictures go to OPENSTEER_BROWSER_SLEEP_EVIDENCE_DIR, or a temp folder.
 */
import type { BrowserSleepScene, MockHostClient } from "@opensteer/client/mock";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "playwright-core";
import { expectThat, finishJourney, journeyChecks, openMockWeb } from "./mock-web-journey.js";

const artifactDirectory = path.resolve(
  process.env.OPENSTEER_BROWSER_SLEEP_EVIDENCE_DIR ??
    path.join(tmpdir(), "opensteer-browser-sleep-evidence"),
);
await mkdir(artifactDirectory, { recursive: true });
const { checks, check, abort } = journeyChecks();
const web = await openMockWeb("opensteer-browser-sleep-web");

const widths = [
  { name: "desktop", viewport: { width: 1440, height: 900 } },
  { name: "phone", viewport: { width: 390, height: 844 } },
] as const;

/** Opens the first running page tab, its picture drawn unless `before` says otherwise. */
async function openPage(
  width: (typeof widths)[number],
  before?: BrowserSleepScene,
): Promise<{ page: Page; tabId: string }> {
  const context = await web.browser.newContext({ viewport: width.viewport, deviceScaleFactor: 2 });
  await web.routeBuild(context);
  await context.route(
    (url) => url.origin !== web.origin,
    (route) => route.fulfill({ body: "", status: 204 }),
  );
  await context.addInitScript(() => {
    Reflect.set(globalThis, "__name", (value: unknown) => value);
  });
  const page = await context.newPage();
  await page.goto(web.origin);
  const tabId = await page
    .waitForFunction(() => {
      const client = Reflect.get(window, "opensteerMock") as MockHostClient | undefined;
      const tabs = client?.getSnapshot().tabs;
      if (!tabs) return null;
      return (
        (tabs.strip.ordered as readonly string[]).find((id) => {
          const tab = tabs.get(id as never);
          return tab?.kind === "page" && tab.state === "open";
        }) ?? null
      );
    })
    .then((handle) => handle.jsonValue() as Promise<string>);
  await page.evaluate(() =>
    (Reflect.get(window, "opensteerMock") as MockHostClient).scriptPlaces(),
  );
  const address = `/?panel=browser&tab=${encodeURIComponent(tabId)}`;
  if (before) {
    // Within the app, so the mock Host keeps what it was told before the page is opened.
    await report(page, tabId, before);
    await page.evaluate((address) => {
      history.pushState(null, "", address);
      dispatchEvent(new PopStateEvent("popstate"));
    }, address);
  } else await page.goto(`${web.origin}${address}`);
  await page.locator(".browser-view").waitFor();
  if (!before) await page.locator(".browser-canvas canvas").waitFor();
  await page.waitForTimeout(before ? 50 : 600);
  return { page, tabId };
}

async function report(page: Page, tabId: string, scene: BrowserSleepScene | null) {
  await page.evaluate(
    async ({ tabId, scene }) => {
      (Reflect.get(window, "opensteerMock") as MockHostClient).showBrowserSleepScene(tabId, scene);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    },
    { tabId, scene },
  );
}

async function shoot(page: Page, width: (typeof widths)[number], name: string) {
  const file = path.join(artifactDirectory, `${width.name}-${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

const text = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .textContent({ timeout: 2_000 })
    .then((value) => value?.trim() ?? null)
    .catch(() => null);

try {
  for (const width of widths) {
    await check(`${width.name}: a browser without a pool, as it always was`, async () => {
      const { page } = await openPage(width);
      const shot = await shoot(page, width, "00-not-pooled");
      await page.context().close();
      return { shot };
    });

    await check(`${width.name}: awake and asleep show nothing new`, async () => {
      const { page, tabId } = await openPage(width);
      await report(page, tabId, "asleep");
      const shot = await shoot(page, width, "01-asleep-shows-nothing");
      expectThat(
        { shot },
        (await page.locator(".browser-stale, .browser-return-note, .browser-status").count()) === 0,
        "a sleeping browser showed something",
      );
      await page.context().close();
      return { shot };
    });

    await check(`${width.name}: a warm wake, step by step`, async () => {
      const { page, tabId } = await openPage(width);
      await report(page, tabId, "waking");
      await page.waitForTimeout(150);
      const quiet = await shoot(page, width, "02-waking-under-400ms");
      await page.waitForTimeout(700);
      const dimmed = await shoot(page, width, "03-waking-400ms-last-picture");
      const atOne = await text(page, ".browser-stale");
      await page.waitForTimeout(1_400);
      const slow = await shoot(page, width, "04-waking-2s");
      const atTwo = await text(page, ".browser-stale");
      await page.waitForTimeout(6_100);
      const long = await shoot(page, width, "05-waking-8s");
      const atEight = await text(page, ".browser-stale");
      expectThat(
        { atOne, atTwo, atEight },
        atOne === "Last picture" &&
          atTwo === "Last picture · Waking browser…" &&
          atEight === "Last picture · Taking longer than usual…",
        "the wait's line did not follow its steps",
      );
      await page.locator(".browser-stale").dispatchEvent("pointerdown");
      await page.waitForTimeout(200);
      const refused = await shoot(page, width, "06-waking-tap-not-sent");
      const said = await text(page, ".browser-stale");
      expectThat({ said }, said === "Not sent · Taking longer than usual…", "a tap was not said");
      await report(page, tabId, "awake");
      await page.locator(".browser-stale").waitFor({ state: "detached" });
      const back = await shoot(page, width, "07-woke-exactly");
      await page.context().close();
      return { quiet, dimmed, slow, long, refused, back, atOne, atTwo, atEight };
    });

    await check(`${width.name}: a fresh start dims the picture at once`, async () => {
      const { page, tabId } = await openPage(width);
      await report(page, tabId, "starting");
      await page.waitForTimeout(400);
      const shot = await shoot(page, width, "08-starting-with-picture");
      const said = await text(page, ".browser-stale");
      expectThat({ said }, said === "Last picture · Starting browser…", "the start was not said");
      await report(page, tabId, "restarting");
      await page.waitForTimeout(400);
      const restarting = await shoot(page, width, "09-restarting-with-picture");
      await page.context().close();
      return { shot, restarting, said };
    });

    for (const [scene, name, words] of [
      ["waking", "10-waking-no-picture-2s", "Waking browser…"],
      ["starting", "11-starting-no-picture", "Starting browser…"],
      ["restarting", "12-restarting-no-picture", "Restarting browser…"],
    ] as const)
      await check(`${width.name}: ${scene} with no picture says one line`, async () => {
        const { page } = await openPage(width, scene);
        await page.waitForTimeout(scene === "waking" ? 2_300 : 700);
        const shot = await shoot(page, width, name);
        const said = await text(page, ".browser-status--wake");
        expectThat({ said }, said === words, `${scene} did not say "${words}"`);
        await page.context().close();
        return { shot, said };
      });

    for (const [scene, name] of [
      ["failed", "13-failed"],
      ["failed-again", "14-failed-again"],
    ] as const)
      await check(`${width.name}: ${scene}`, async () => {
        const { page, tabId } = await openPage(width);
        await report(page, tabId, scene);
        await page.locator(".place-state").waitFor();
        const shot = await shoot(page, width, name);
        const said = await text(page, ".place-state");
        await page.context().close();
        return { shot, said };
      });

    for (const [scene, name] of [
      ["reloaded", "15-note-reloaded"],
      ["reloaded-typed", "16-note-reloaded-typed"],
      ["reloaded-by-you", "17-note-reloaded-by-you"],
      ["reloaded-security", "18-note-reloaded-security-update"],
      ["lost", "19-note-could-not-be-restored"],
      ["lost-typed", "20-note-could-not-be-restored-typed"],
    ] as const)
      await check(`${width.name}: the note for ${scene}`, async () => {
        const { page, tabId } = await openPage(width);
        await report(page, tabId, scene);
        await page.locator(".browser-return-note").waitFor();
        const shot = await shoot(page, width, name);
        const said = await text(page, ".browser-return-note");
        await page.locator('.browser-return-note [aria-label="Dismiss"]').click();
        await page.locator(".browser-return-note").waitFor({ state: "detached" });
        await page.context().close();
        return { shot, said };
      });

    await check(
      `${width.name}: Restart browser, its one confirmation, and its refusal`,
      async () => {
        const { page, tabId } = await openPage(width);
        await report(page, tabId, "awake");
        await page.locator('.place [aria-label="Browser options"]').click();
        await page.getByRole("menuitem", { name: /Restart browser/u }).waitFor();
        const menu = await shoot(page, width, "21-restart-in-menu");
        await page.getByRole("menuitem", { name: /Restart browser/u }).click();
        await page.getByRole("dialog").waitFor();
        const confirm = await shoot(page, width, "22-restart-confirm");
        await page.getByRole("dialog").getByRole("button", { name: "Restart browser" }).click();
        await page.getByText("Your Cloud Computer can’t restart its browser yet.").waitFor();
        const refused = await shoot(page, width, "23-restart-refused");
        await page.context().close();
        return { menu, confirm, refused };
      },
    );

    await check(`${width.name}: no Restart browser without a pool`, async () => {
      const { page } = await openPage(width);
      await page.locator('.place [aria-label="Browser options"]').click();
      await page.getByRole("menuitem").first().waitFor();
      const shot = await shoot(page, width, "24-menu-not-pooled");
      const offered = await page.getByRole("menuitem", { name: /Restart browser/u }).count();
      expectThat({ offered }, offered === 0, "Restart browser was offered without a pool");
      await page.context().close();
      return { shot };
    });
  }
} catch (error) {
  abort(error);
} finally {
  await web.close();
}
await finishJourney(artifactDirectory, checks);
