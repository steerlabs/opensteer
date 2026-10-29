import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expectThat, finishJourney, journeyChecks, openMockWeb } from "./mock-web-journey.js";

const artifactDirectory = path.resolve(
  process.env.OPENSTEER_TAB_REOPEN_EVIDENCE_DIR ??
    path.join(tmpdir(), "opensteer-tab-reopen-evidence/web"),
);
await mkdir(artifactDirectory, { recursive: true });
const { checks, check, abort } = journeyChecks();
const web = await openMockWeb("opensteer-tab-reopen-web");
const trace: Record<string, unknown>[] = [];
try {
  const context = await web.browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route(
    (url) => url.origin !== web.origin,
    (route) => route.fulfill({ body: "", status: 204 }),
  );
  await context.addInitScript("globalThis.__name = value => value;");
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${web.origin}/?mock-world=busy`);
  const rows = page.locator('.side-tab[data-group="web"]');
  await rows.first().waitFor();
  const inventory = () =>
    rows.evaluateAll((nodes) =>
      nodes.map((node) => ({
        id: (node as HTMLElement).dataset.motionKey,
        title: node.querySelector(".side-tab__title")?.textContent,
        selected: node.querySelector(".side-tab__main")?.getAttribute("aria-current"),
      })),
    );
  await check("the web tab menu reopens and selects a fresh tab", async () => {
    const before = await inventory();
    const target = before[1]!;
    const row = page.locator(`[data-motion-key="${target.id}"] .side-tab__main`);
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Close tab", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Close this tab?" })
      .getByRole("button", { name: "Close tab", exact: true })
      .click();
    await row.waitFor({ state: "detached" });
    const closed = await inventory();
    trace.push({ step: "closed", before, closed });
    await page.screenshot({ path: path.join(artifactDirectory, "01-closed.png") });
    await rows.first().locator(".side-tab__main").click({ button: "right" });
    const reopen = page.getByRole("menuitem", { name: "Reopen closed tab", exact: true });
    await reopen.waitFor();
    await page.screenshot({ path: path.join(artifactDirectory, "02-menu.png") });
    await reopen.click();
    await page.waitForFunction(
      ({ title, old }) =>
        [...document.querySelectorAll('.side-tab[data-group="web"]')].some(
          (node) =>
            (node as HTMLElement).dataset.motionKey !== old &&
            node.querySelector(".side-tab__title")?.textContent === title &&
            (node.classList.contains("is-active") ||
              node.querySelector(".side-tab__main")?.getAttribute("aria-current") === "true"),
        ),
      { title: target.title, old: target.id },
    );
    const after = await inventory();
    const restored = after.find((item) => item.title === target.title && item.id !== target.id);
    expectThat(
      { target, restored, before, after },
      !!restored && after.length === before.length && !after.some((item) => item.id === target.id),
      "reopen did not restore exactly one fresh selected tab",
    );
    trace.push({ step: "reopened", target, restored, after, url: page.url() });
    await page.screenshot({ path: path.join(artifactDirectory, "03-reopened-selected.png") });
    return { target, restored, before, after };
  });
  await check("the reopened tab activates and shows its page", async () => {
    await page.waitForFunction(() => {
      const client = Reflect.get(window, "opensteerMock") as {
        browserViewerState(sessionId: string, tabId: string): { status: string };
      };
      const params = new URLSearchParams(location.search);
      const sessionId = params.get("browser");
      const tabId = params.get("browserTab");
      return (
        !!sessionId && !!tabId && client.browserViewerState(sessionId, tabId).status === "live"
      );
    });
    const retry = await page.getByRole("button", { name: "Try again" }).count();
    const address = await page
      .getByRole("combobox", { name: "Search or enter address" })
      .isEnabled();
    expectThat({ retry, address }, retry === 0 && address, "the reopened tab did not activate");
    await page.screenshot({ path: path.join(artifactDirectory, "04-reopened-live.png") });
    return { retry, address, url: page.url() };
  });
  await check("the journey has no browser errors", async () => {
    expectThat({ errors }, errors.length === 0, "the web app raised an error");
    return { errors };
  });
  await context.tracing.stop({ path: path.join(artifactDirectory, "playwright-trace.zip") });
  await context.close();
} catch (error) {
  abort(error);
} finally {
  await web.close();
  await finishJourney(artifactDirectory, checks, { trace });
}
