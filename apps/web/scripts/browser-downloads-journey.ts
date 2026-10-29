/** Download renderer failure journeys; authored before the production implementation. */
import type { DesktopDownload } from "@opensteer/protocol/desktop";
import type { MockHostClient } from "@opensteer/client/mock";
import type { DesktopPreviewDownloads } from "../src/desktop/desktop-preview-bridge.js";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "playwright-core";
import { expectThat, finishJourney, journeyChecks, openMockWeb } from "./mock-web-journey.js";

const artifactDirectory = path.resolve(
  process.env.OPENSTEER_BROWSER_DOWNLOADS_EVIDENCE_DIR ??
    path.join(tmpdir(), "opensteer-browser-downloads"),
);
await mkdir(artifactDirectory, { recursive: true });
const { checks, check, abort } = journeyChecks();
const web = await openMockWeb("opensteer-browser-downloads");
const entry = (
  id: string,
  state: DesktopDownload["state"],
  totalBytes: number | null = 10 * 1024 * 1024,
): DesktopDownload => ({
  id,
  filename: `${id}.zip`,
  site: "downloads.example.com",
  state,
  receivedBytes: state === "completed" ? (totalBytes ?? 1024) : (2.1 * 1024 * 1024) | 0,
  totalBytes,
});
const preview = (page: Page, download: DesktopDownload) =>
  page.evaluate((download) => {
    (Reflect.get(window, "opensteerPreviewDownloads") as DesktopPreviewDownloads).scriptDownload(
      download,
    );
  }, download);
const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
const button = (page: Page) => page.getByRole("button", { name: "Downloads", exact: true });
const panel = (page: Page) => page.getByRole("dialog", { name: "Downloads", exact: true });
const toastText = (page: Page) => page.locator(".toast__message").allTextContents();
const dismiss = async (page: Page) => {
  while (await page.locator(".toast__dismiss").count())
    await page.locator(".toast__dismiss").first().click();
};
async function openBrowser(page: Page) {
  await page.locator('.side-tab[data-group="web"]').first().waitFor();
  await page.evaluate(() =>
    (Reflect.get(window, "opensteerMock") as MockHostClient).scriptPlaces(),
  );
  await page.locator('.side-tab[data-group="web"] .side-tab__main').first().click();
  await page.getByRole("button", { name: "Reload page", exact: true }).waitFor();
}
const screenshots: string[] = [];
const shot = async (page: Page, name: string) => {
  const file = path.join(artifactDirectory, name);
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
  await page.screenshot({ path: file });
  screenshots.push(file);
};
try {
  const context = await web.browser.newContext({ viewport: { width: 1440, height: 1000 } });
  context.setDefaultTimeout(5000);
  await context.route(
    (url) => url.origin !== web.origin,
    (route) => route.fulfill({ body: "", status: 204 }),
  );
  await context.addInitScript("globalThis.__name = (value) => value;");
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(web.origin);
  await openBrowser(page);
  await check("web without desktop bridge has no Downloads button", async () => {
    expectThat(
      {},
      (await button(page).count()) === 0 &&
        (await page.evaluate(() => !Reflect.get(window, "opensteerDesktop"))),
      "web exposed desktop downloads",
    );
    await shot(page, "01-web.png");
    return {};
  });
  await page.goto(`${web.origin}/?mock-downloads=[]`);
  await openBrowser(page);
  await check("empty desktop list has no Downloads button", async () => {
    expectThat(
      {},
      await page.evaluate(() => !!Reflect.get(window, "opensteerPreviewDownloads")),
      "download preview is absent",
    );
    expectThat({}, (await button(page).count()) === 0, "empty downloads button shown");
    return {};
  });
  if (checks.some((item) => item.status === "failed"))
    throw new Error("Downloads preview is absent; dependent checks cannot run.");

  await check(
    "progress aggregates known sizes and becomes indeterminate for unknown sizes",
    async () => {
      await preview(page, entry("first", "progressing"));
      const progress = button(page).getByRole("progressbar");
      await progress.waitFor();
      await preview(page, { ...entry("second", "progressing"), receivedBytes: 3 * 1024 * 1024 });
      await settle(page);
      const value = Number(await progress.getAttribute("aria-valuenow"));
      expectThat({ value }, Math.abs(value - 25.5) < 0.01, "aggregate progress wrong");
      await shot(page, "02-determinate.png");
      await preview(page, entry("unknown", "progressing", null));
      await settle(page);
      expectThat(
        {},
        (await progress.getAttribute("aria-valuenow")) === null,
        "unknown total was determinate",
      );
      await shot(page, "03-indeterminate.png");
      return { value };
    },
  );
  await check(
    "popover orders all states newest first and displays filenames, bytes and sites",
    async () => {
      await preview(page, entry("complete", "completed"));
      await preview(page, entry("cancelled", "cancelled"));
      await preview(page, entry("failed", "failed"));
      await button(page).click();
      await panel(page).waitFor();
      const rows = panel(page).locator(".browser-download");
      const names = await rows.locator(".browser-download__filename").allTextContents();
      const statuses = await rows.locator(".browser-download__status").allTextContents();
      expectThat(
        { names, statuses },
        JSON.stringify(names) ===
          JSON.stringify([
            "failed.zip",
            "cancelled.zip",
            "complete.zip",
            "unknown.zip",
            "second.zip",
            "first.zip",
          ]) &&
          JSON.stringify(statuses) ===
            JSON.stringify([
              "Failed",
              "Cancelled",
              "10.0 MB",
              "2.1 MB",
              "3.0 MB of 10.0 MB",
              "2.1 MB of 10.0 MB",
            ]),
        "download rows incorrect",
      );
      expectThat(
        {},
        (await rows.locator(".browser-download__site").allTextContents()).every(
          (site) => site === "downloads.example.com",
        ),
        "site lost",
      );
      expectThat(
        {},
        (await panel(page)
          .getByRole("button", { name: "Open complete.zip", exact: true })
          .isEnabled()) &&
          (await panel(page)
            .getByRole("button", { name: "Cancel unknown.zip", exact: true })
            .isEnabled()),
        "actions missing",
      );
      await shot(page, "04-all-states.png");
      await page.keyboard.press("Escape");
      await dismiss(page);
      return { names, statuses };
    },
  );
  await check(
    "keyboard opens, focuses, navigates and Escape restores focus; overlay token balances",
    async () => {
      await page.evaluate(() => {
        const events: { action: string; overlayId: string }[] = [];
        Reflect.set(window, "downloadOverlays", events);
        Reflect.set(window.opensteerDesktop!, "browserPresentation", {
          acquireOverlay: async ({ overlayId }: { overlayId: string }) => {
            events.push({ action: "acquire", overlayId });
          },
          releaseOverlay: async ({ overlayId }: { overlayId: string }) => {
            events.push({ action: "release", overlayId });
          },
        });
      });
      await button(page).focus();
      await page.keyboard.press("Enter");
      await panel(page).waitFor();
      const before = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
      expectThat(
        { before },
        await panel(page).evaluate((element) => element.contains(document.activeElement)),
        "focus stayed outside",
      );
      await page.keyboard.press("ArrowDown");
      const after = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
      expectThat({ before, after }, before !== after, "arrow key did not navigate");
      await page.keyboard.press("Escape");
      await panel(page).waitFor({ state: "hidden" });
      await settle(page);
      const overlays = await page.evaluate(
        () => Reflect.get(window, "downloadOverlays") as { action: string; overlayId: string }[],
      );
      expectThat(
        { overlays },
        overlays.length === 2 &&
          overlays[0]?.action === "acquire" &&
          overlays[1]?.action === "release" &&
          overlays[0].overlayId === overlays[1].overlayId &&
          (await button(page).evaluate((element) => element === document.activeElement)),
        "overlay or focus leaked",
      );
      await page.evaluate(() =>
        Reflect.deleteProperty(window.opensteerDesktop!, "browserPresentation"),
      );
      return { before, after, overlays };
    },
  );
  await check("Open, Show and Cancel send id-only targets and action failures toast", async () => {
    await button(page).click();
    await panel(page).getByRole("button", { name: "Open complete.zip", exact: true }).click();
    await panel(page)
      .getByRole("button", { name: "Show complete.zip in Finder", exact: true })
      .click();
    await panel(page).getByRole("button", { name: "Cancel unknown.zip", exact: true }).click();
    await settle(page);
    expectThat(
      { toasts: await toastText(page) },
      (await toastText(page)).length === 0,
      "cancel toasted",
    );
    await page.evaluate(() =>
      (
        Reflect.get(window, "opensteerPreviewDownloads") as DesktopPreviewDownloads
      ).scriptActionResult("show", "complete", "missing"),
    );
    await panel(page)
      .getByRole("button", { name: "Show complete.zip in Finder", exact: true })
      .click();
    await page.getByText("complete.zip was moved or deleted", { exact: true }).waitFor();
    await page.evaluate(() =>
      (
        Reflect.get(window, "opensteerPreviewDownloads") as DesktopPreviewDownloads
      ).scriptActionResult("open", "complete", "failed"),
    );
    await panel(page).getByRole("button", { name: "Open complete.zip", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.getByText("Couldn't open complete.zip", { exact: true }).waitFor();
    const actions = await page.evaluate(
      () => (Reflect.get(window, "opensteerPreviewDownloads") as DesktopPreviewDownloads).actions,
    );
    expectThat(
      { actions },
      JSON.stringify(actions) ===
        JSON.stringify([
          { action: "open", target: { id: "complete" } },
          { action: "show", target: { id: "complete" } },
          { action: "cancel", target: { id: "unknown" } },
          { action: "show", target: { id: "complete" } },
          { action: "open", target: { id: "complete" } },
        ]),
      "actions were not id-only",
    );
    await shot(page, "05-action-feedback.png");
    await page.keyboard.press("Escape");
    await dismiss(page);
    return { actions };
  });
  await check(
    "hydration suppresses old outcomes, later outcomes notify once without browser toolbar",
    async () => {
      const initial = [
        entry("old-complete", "completed"),
        entry("old-failed", "failed"),
        entry("slow", "progressing"),
      ];
      await page.goto(
        `${web.origin}/?mock-downloads=${encodeURIComponent(JSON.stringify(initial))}`,
      );
      await page.locator(".side-tab").first().waitFor();
      await settle(page);
      expectThat(
        { toasts: await toastText(page) },
        (await toastText(page)).length === 0 && (await button(page).count()) === 0,
        "hydration toasted or toolbar was visible",
      );
      await page.bringToFront();
      expectThat(
        {},
        await page.evaluate(() => document.hasFocus()),
        "feedback window was not focused",
      );
      await preview(page, entry("slow", "completed"));
      await page.getByText("Downloaded slow.zip", { exact: true }).waitFor();
      await dismiss(page);
      await preview(page, entry("instant", "completed"));
      await page.getByText("Downloaded instant.zip", { exact: true }).waitFor();
      await dismiss(page);
      await preview(page, entry("instant-fail", "failed"));
      await page.getByText("Couldn't download instant-fail.zip", { exact: true }).waitFor();
      await shot(page, "06-conversation-feedback.png");
      await dismiss(page);
      for (const item of [
        entry("slow", "completed"),
        entry("instant", "completed"),
        entry("instant-fail", "failed"),
        entry("silent-cancel", "cancelled"),
      ])
        await preview(page, item);
      await settle(page);
      expectThat(
        { toasts: await toastText(page) },
        (await toastText(page)).length === 0,
        "duplicate or cancel toast",
      );
      await preview(page, entry("slow-fail", "progressing"));
      await preview(page, entry("slow-fail", "failed"));
      await page.getByText("Couldn't download slow-fail.zip", { exact: true }).waitFor();
      await dismiss(page);
      return { initial };
    },
  );
  await check(
    "background windows consume outcomes silently and never replay on focus",
    async () => {
      // Headless Chromium reports every page focused, even after a tab switch.
      // Control only the document focus boundary; keep the production notification path.
      await page.evaluate(() => {
        Reflect.set(window, "downloadFocused", false);
        document.hasFocus = () => Reflect.get(window, "downloadFocused") as boolean;
      });
      const backgroundFocused = await page.evaluate(() => document.hasFocus());
      expectThat({ backgroundFocused }, !backgroundFocused, "background window still had focus");
      await preview(page, entry("background", "completed"));
      await preview(page, entry("background-fail", "failed"));
      await settle(page);
      expectThat({}, (await toastText(page)).length === 0, "background toasted");
      await page.evaluate(() => Reflect.set(window, "downloadFocused", true));
      expectThat({}, await page.evaluate(() => document.hasFocus()), "window did not regain focus");

      await preview(page, entry("background", "completed"));
      await preview(page, entry("background-fail", "failed"));
      await settle(page);
      expectThat({}, (await toastText(page)).length === 0, "background outcome replayed");
      return {
        backgroundFocused,
        focusBoundary: "scripted document.hasFocus; native blur requires VM",
      };
    },
  );
  await check(
    "preview keeps active downloads and newest 50 finished; rejects paths and unknown ids",
    async () => {
      const observed = await page.evaluate(async () => {
        const downloads = Reflect.get(
          window,
          "opensteerPreviewDownloads",
        ) as DesktopPreviewDownloads;
        for (let index = 0; index < 160; index++)
          downloads.scriptDownload({
            id: `bounded-${index}`,
            filename: `${index}.txt`,
            state: "completed",
            site: null,
            receivedBytes: 0,
            totalBytes: 0,
          });
        const snapshot = await downloads.get();
        let rejected = false;
        try {
          await downloads.open({ id: "bounded-159", path: "/tmp/unsafe" } as { id: string });
        } catch {
          rejected = true;
        }
        for (let index = 0; index < 101; index++)
          downloads.scriptDownload({
            id: `active-${index}`,
            filename: `${index}.bin`,
            state: "progressing",
            site: null,
            receivedBytes: 0,
            totalBytes: null,
          });
        const bounded = await downloads.get();
        for (const download of bounded.downloads.filter((item) => item.state === "progressing"))
          await downloads.cancel({ id: download.id });
        return {
          activeCount: bounded.downloads.filter((item) => item.state === "progressing").length,
          boundedCount: bounded.downloads.length,
          overflowState: bounded.downloads.find((item) => item.id === "active-100")?.state,
          count: snapshot.downloads.length,
          newest: snapshot.downloads[0]?.id,
          rejected,
          missing: await downloads.open({ id: "unknown-id" }),
        };
      });
      expectThat(
        observed,
        observed.count === 50 &&
          observed.activeCount === 100 &&
          observed.boundedCount === 150 &&
          observed.overflowState === "failed" &&
          observed.newest === "bounded-159" &&
          observed.rejected &&
          observed.missing.status === "missing",
        "preview contract incorrect",
      );
      return observed;
    },
  );
  await check("download panel fits a narrow viewport with a long filename", async () => {
    await preview(page, {
      ...entry("long", "completed"),
      filename: `${"long-".repeat(45)}.zip`,
      site: null,
      receivedBytes: 0,
      totalBytes: 0,
    });
    await openBrowser(page);
    await dismiss(page);
    await page.setViewportSize({ width: 600, height: 850 });
    await button(page).click();
    await panel(page).waitFor();
    const bounds = await panel(page).boundingBox();
    expectThat(
      { bounds },
      !!bounds &&
        bounds.x >= 0 &&
        bounds.x + bounds.width <= 600 &&
        (await panel(page).evaluate((element) => element.scrollWidth <= element.clientWidth)),
      "downloads overflowed viewport",
    );
    await shot(page, "07-narrow.png");
    await page.keyboard.press("Escape");
    return { bounds };
  });
  await check(
    "one store subscription survives toolbar mounts and a late get cannot overwrite broadcasts",
    async () => {
      const race = await context.newPage();
      await race.addInitScript(() => {
        let bridge: typeof window.opensteerDesktop;
        Object.defineProperty(window, "opensteerDesktop", {
          configurable: true,
          get: () => bridge,
          set: (value: typeof window.opensteerDesktop) => {
            bridge = value;
            const downloads = value?.downloads;
            if (!downloads) return;
            let subscriptions = 0;
            const subscribe = downloads.onChanged;
            downloads.onChanged = (listener) => {
              Reflect.set(window, "downloadSubscriptions", ++subscriptions);
              return subscribe(listener);
            };
            const get = downloads.get;
            downloads.get = async () => {
              const initial = await get();
              return new Promise((resolve) => {
                Reflect.set(window, "resolveDownloadHydration", () => resolve(initial));
              });
            };
          },
        });
      });
      await race.goto(`${web.origin}/?mock-downloads=[]`);
      await race.locator(".side-tab").first().waitFor();
      await race.waitForFunction(
        () => typeof Reflect.get(window, "resolveDownloadHydration") === "function",
      );
      await preview(race, entry("raced", "progressing"));
      await race.evaluate(() => (Reflect.get(window, "resolveDownloadHydration") as () => void)());
      await openBrowser(race);
      await button(race).waitFor();
      await button(race).click();
      await panel(race).getByText("raced.zip", { exact: true }).waitFor();
      await race.keyboard.press("Escape");
      await race.locator('.side-tab[data-group="web"] .side-tab__main').nth(1).click();
      await button(race).waitFor();
      const subscriptions = await race.evaluate(
        () => Reflect.get(window, "downloadSubscriptions") as number,
      );
      expectThat(
        { subscriptions },
        subscriptions === 1,
        "store subscribed for every toolbar or StrictMode mount",
      );
      await shot(race, "08-hydration-race.png");
      await race.close();
      return { subscriptions };
    },
  );
  await check("no renderer errors", async () => {
    expectThat({ errors }, errors.length === 0, "renderer errors");
    return { errors };
  });
  await context.close();
} catch (error) {
  abort(error);
} finally {
  await web.close();
  await finishJourney(artifactDirectory, checks, { screenshots });
}
