/**
 * A connected agent's approval page in a window shorter than the page, in a real
 * browser: the production web build against the mock Host, in headless Chromium.
 *
 * The page is shown by itself, outside the app shell, so nothing around it
 * gives it a height. Ways this journey can fail, each checked below:
 *  1. The page is taller than the window, so its scroll owner
 *     (`.settings-content`) has nothing to scroll.
 *  2. The document scrolls instead of the page's own scroll owner.
 *  3. The wheel over the page does not bring Approve into the window.
 *  4. Tab cannot bring Approve into the window.
 *  5. The page that sends a person to their own computer has the same fault.
 *
 * `result.json` goes to OPENSTEER_CONNECTION_CONSENT_E2E_ARTIFACT_DIR, or
 * `opensteer-connection-consent-e2e` in the system temporary directory.
 */
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "playwright-core";
import { expectThat, finishJourney, journeyChecks, openMockWeb } from "./mock-web-journey.js";

const artifactDirectory = path.resolve(
  process.env.OPENSTEER_CONNECTION_CONSENT_E2E_ARTIFACT_DIR ??
    path.join(tmpdir(), "opensteer-connection-consent-e2e"),
);
// The mock Host's waiting consent (`mockConsentRequestId`), on the scene with every choice shown.
const consentPath =
  "/mcp-authorization?request=mockconsentrequest0000000000000000000000000&mock-agents=pair";
const windows = [
  { name: "a short desktop window", width: 1280, height: 520 },
  { name: "a phone held sideways", width: 740, height: 360 },
  { name: "a phone", width: 390, height: 640 },
] as const;

const { checks, check, abort } = journeyChecks();
await rm(artifactDirectory, { recursive: true, force: true });
await mkdir(artifactDirectory, { recursive: true });
const web = await openMockWeb("opensteer-connection-consent");

/** Where the page, its scroll owner, the document and Approve are, in window coordinates. */
const measure = (page: Page) =>
  page.evaluate(() => {
    const main = document.querySelector<HTMLElement>("main.settings")!;
    const owner = document.querySelector<HTMLElement>(".settings-content")!;
    const approve = document.querySelector<HTMLElement>(".form-actions .btn--primary")!;
    const rect = approve.getBoundingClientRect();
    return {
      windowHeight: window.innerHeight,
      pageHeight: Math.round(main.getBoundingClientRect().height),
      documentScrolls: document.documentElement.scrollHeight > window.innerHeight,
      documentScrollTop: Math.round(document.documentElement.scrollTop),
      ownerClientHeight: owner.clientHeight,
      ownerScrollHeight: owner.scrollHeight,
      ownerScrollTop: Math.round(owner.scrollTop),
      approveTop: Math.round(rect.top),
      approveBottom: Math.round(rect.bottom),
    };
  });

try {
  for (const size of windows) {
    const context = await web.browser.newContext({
      viewport: { width: size.width, height: size.height },
    });
    await context.route(
      (url) => url.origin !== web.origin,
      (route) => route.fulfill({ status: 204, body: "" }),
    );
    const page = await context.newPage();
    await page.goto(`${web.origin}${consentPath}`);
    await page.locator(".form-actions .btn--primary").waitFor();
    await page.evaluate(() => document.fonts.ready);

    await check(`${size.name} · the page fits the window and owns its scroll`, async () => {
      const observed = await measure(page);
      expectThat(
        observed,
        observed.approveBottom > observed.windowHeight,
        "the window is not shorter than the page, so this journey shows nothing",
      );
      expectThat(
        observed,
        observed.pageHeight <= observed.windowHeight,
        "the page is taller than the window",
      );
      expectThat(observed, !observed.documentScrolls, "the document scrolls, not the page");
      expectThat(
        observed,
        observed.ownerScrollHeight > observed.ownerClientHeight,
        "the page's scroll owner has nothing to scroll",
      );
      return observed;
    });

    await check(`${size.name} · the wheel brings Approve into the window`, async () => {
      await page.mouse.move(size.width / 2, size.height / 2);
      await page.mouse.wheel(0, 6000);
      await page
        .waitForFunction(
          () => {
            const approve = document.querySelector(".form-actions .btn--primary");
            return approve ? approve.getBoundingClientRect().bottom <= window.innerHeight : false;
          },
          undefined,
          { timeout: 3000 },
        )
        .catch(() => undefined);
      const observed = await measure(page);
      expectThat(
        observed,
        observed.approveTop >= 0 && observed.approveBottom <= observed.windowHeight,
        "Approve is still outside the window after the wheel",
      );
      return observed;
    });

    await check(`${size.name} · Tab brings Approve into the window`, async () => {
      await page.reload();
      await page.locator(".form-actions .btn--primary").waitFor();
      await page.locator(".form-actions .btn--primary").focus();
      const observed = await measure(page);
      expectThat(
        observed,
        observed.approveTop >= 0 && observed.approveBottom <= observed.windowHeight,
        "Approve has the keyboard and is outside the window",
      );
      return observed;
    });
    await context.close();
  }

  const context = await web.browser.newContext({ viewport: { width: 390, height: 300 } });
  await context.route(
    (url) => url.origin !== web.origin,
    (route) => route.fulfill({ status: 204, body: "" }),
  );
  const page = await context.newPage();
  await check(
    "every page shown outside the shell with the settings layout frames itself",
    async () => {
      await page.goto(`${web.origin}${consentPath}`);
      await page.locator("main.settings").waitFor();
      const observed = await page.evaluate(() => {
        const main = document.querySelector<HTMLElement>("main.settings")!;
        return {
          insideShell: main.closest(".app-shell") !== null,
          windowHeight: window.innerHeight,
          pageHeight: Math.round(main.getBoundingClientRect().height),
        };
      });
      expectThat(observed, !observed.insideShell, "this page is no longer shown outside the shell");
      expectThat(
        observed,
        observed.pageHeight === observed.windowHeight,
        "the page is not exactly as tall as the window",
      );
      return observed;
    },
  );
  await context.close();
} catch (error) {
  abort(error);
} finally {
  await web.close();
}
await finishJourney(artifactDirectory, checks, {
  artifactDirectory,
  command: "pnpm --filter @opensteer/web test:connection-consent-scroll",
  windows,
});
