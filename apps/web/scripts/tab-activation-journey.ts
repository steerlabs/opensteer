/** Selecting a tab activates it once; a failed activation says why and Try again recovers it. */
import type { MockHostClient } from "@opensteer/client/mock";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expectThat, finishJourney, journeyChecks, openMockWeb } from "./mock-web-journey.js";

const artifactDirectory = path.resolve(
  process.env.OPENSTEER_TAB_ACTIVATION_EVIDENCE_DIR ??
    path.join(tmpdir(), "opensteer-tab-activation-evidence"),
);
await mkdir(artifactDirectory, { recursive: true });
const { checks, check, abort } = journeyChecks();
const web = await openMockWeb("opensteer-tab-activation-web");
const trace: Record<string, unknown>[] = [];
try {
  const context = await web.browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript("globalThis.__name = (value) => value;");
  await context.route(
    (url) => url.origin !== web.origin,
    (route) => route.fulfill({ status: 204, body: "" }),
  );
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const shot = (name: string) =>
    page.screenshot({ path: path.join(artifactDirectory, `${name}.png`) });
  await page.goto(`${web.origin}/?panel=browser`);
  await page.waitForFunction(
    () =>
      (Reflect.get(window, "opensteerMock") as MockHostClient | undefined)?.getSnapshot()
        .connection === "connected",
  );
  // The first activation of the chosen page fails; every later one goes through.
  const tabId = await page.evaluate(() => {
    const client = Reflect.get(window, "opensteerMock") as MockHostClient;
    const tab = [...client.getSnapshot().tabs.rows.values()].find((row) => row.kind === "page")!;
    const activate = client.activateTab;
    const calls: string[] = [];
    Reflect.set(window, "activations", calls);
    let failed = false;
    Object.assign(client, {
      activateTab: async (id: typeof tab.tabId) => {
        calls.push(id);
        if (id === tab.tabId && !failed) {
          failed = true;
          throw new Error("The browser could not start.");
        }
        return activate(id);
      },
    });
    return tab.tabId;
  });
  const activations = () =>
    page.evaluate(() => (Reflect.get(window, "activations") as string[]).slice());

  await check("a selected tab is activated once and says it could not open", async () => {
    await page.locator(`.side-tab[data-place-key="${tabId}"] .side-tab__main`).click();
    // The tab's own fact, never the failure's raw text (67af87553).
    const title = page.locator(".place-state .place-state__title");
    await title.waitFor();
    const said = await title.textContent();
    const raw = await page.getByText("The browser could not start.").count();
    const calls = await activations();
    expectThat(
      { calls },
      calls.filter((id) => id === tabId).length === 1,
      "Activated more than once",
    );
    expectThat(
      { said, raw },
      said === "This tab could not open." && raw === 0,
      "The failed tab does not say it could not open, or shows the raw failure",
    );
    await shot("01-activation-failed");
    trace.push({ phase: "failed", calls });
    return { calls };
  });

  await check("Try again activates it and shows the page", async () => {
    await page.locator(".place-state button", { hasText: "Try again" }).click();
    await page.waitForFunction(() => {
      const canvas = document.querySelector<HTMLCanvasElement>(".browser-canvas canvas");
      return !!canvas && canvas.width > 0;
    });
    const calls = await activations();
    expectThat({ calls }, calls.filter((id) => id === tabId).length === 2, "Try again did nothing");
    await shot("02-activated");
    trace.push({ phase: "activated", calls });
    return { calls };
  });

  await check("no browser errors", async () => {
    expectThat({ errors }, errors.length === 0, "The browser reported errors");
    return { errors };
  });
  await context.close();
} catch (error) {
  abort(error);
} finally {
  await web.close();
}
await finishJourney(artifactDirectory, checks, { trace });
