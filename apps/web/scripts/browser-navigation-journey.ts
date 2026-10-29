import type { BrowserCommand } from "@opensteer/client/host";
import type { MockHostClient } from "@opensteer/client/mock";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expectThat, finishJourney, journeyChecks, openMockWeb } from "./mock-web-journey.js";

const artifactDirectory =
  process.env.OPENSTEER_NAVIGATION_WEB_EVIDENCE_DIR ??
  path.join(tmpdir(), "opensteer-navigation-web");
await mkdir(artifactDirectory, { recursive: true });
const { checks, check, abort } = journeyChecks();
const web = await openMockWeb("opensteer-navigation-web");
try {
  const context = await web.browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route(
    (url) => url.origin !== web.origin,
    (route) => route.fulfill({ body: "", status: 204 }),
  );
  await context.addInitScript("globalThis.__name = (value) => value;");
  const page = await context.newPage();
  await page.goto(web.origin);
  const row = page.locator('.side-tab[data-group="web"]').first();
  await row.waitFor();
  const key = (await row.getAttribute("data-place-key"))!;
  const sessionId = key.split(":")[1]!;
  const tabId = key.split(":").slice(2).join(":");
  await page.evaluate(() => {
    const client = Reflect.get(window, "opensteerMock") as MockHostClient;
    client.scriptPlaces();
    const commands: BrowserCommand[] = [];
    Reflect.set(window, "navigationCommands", commands);
    client.sendBrowserCommand = (_sessionId, command) => {
      commands.push(command);
    };
  });
  const setNavigation = (support: boolean, back?: boolean, forward?: boolean) =>
    page.evaluate(
      async ({ sessionId, tabId, support, back, forward }) => {
        const client = Reflect.get(window, "opensteerMock") as MockHostClient;
        client.setBrowserNavigation(sessionId, tabId, {
          navigationVersion: support ? 1 : undefined,
          canGoBack: back,
          canGoForward: forward,
        });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      },
      { sessionId, tabId, support, back, forward },
    );
  await setNavigation(false);
  await page.locator(`.side-tab[data-place-key="${key}"] .side-tab__main`).click();
  await page
    .locator(`.browser-view[data-browser-session="${sessionId}"][data-browser-tab="${tabId}"]`)
    .waitFor();
  await page.waitForFunction(
    ({ sessionId, tabId }) => {
      const client = Reflect.get(window, "opensteerMock") as MockHostClient;
      return client.browserViewerState(sessionId, tabId).status === "live";
    },
    { sessionId, tabId },
  );
  const back = page.getByRole("button", { name: "Go back", exact: true });
  const forward = page.getByRole("button", { name: "Go forward", exact: true });
  await back.waitFor();
  const shot = (name: string) => page.screenshot({ path: path.join(artifactDirectory, name) });
  await check(
    "unknown history stays enabled; explicit false disables only its direction",
    async () => {
      expectThat(
        {},
        (await back.isEnabled()) && (await forward.isEnabled()),
        "old Runtime navigation was disabled",
      );
      await setNavigation(true, false, false);
      await page.waitForFunction(
        (button) => button instanceof HTMLButtonElement && button.disabled,
        await back.elementHandle(),
      );
      await page.waitForFunction(
        (button) => button instanceof HTMLButtonElement && button.disabled,
        await forward.elementHandle(),
      );
      await shot("01-no-history.png");
      await setNavigation(true, true, false);
      await page.waitForFunction(
        (button) => button instanceof HTMLButtonElement && !button.disabled,
        await back.elementHandle(),
      );
      expectThat(
        {},
        (await back.isEnabled()) && (await forward.isDisabled()),
        "direction availability was lost",
      );
      await shot("02-back-available.png");
      await setNavigation(true, false, true);
      await page.waitForFunction(
        (button) => button instanceof HTMLButtonElement && !button.disabled,
        await forward.elementHandle(),
      );
      expectThat(
        {},
        (await back.isDisabled()) && (await forward.isEnabled()),
        "back traversal did not enable forward",
      );
      await shot("03-forward-available.png");
      return { sessionId, tabId };
    },
  );
  const commands = () =>
    page.evaluate(() => Reflect.get(window, "navigationCommands") as BrowserCommand[]);
  await check("web preserves the outer browser's reserved reload chord", async () => {
    const before = (await commands()).length;
    await page.getByRole("combobox", { name: "Search or enter address" }).evaluate((input) =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "R",
          code: "KeyR",
          metaKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expectThat(
      { before, commands: await commands() },
      (await commands()).length === before,
      "web stole hard reload",
    );
    return { before, after: (await commands()).length };
  });
  await shot("05-final-state.png");
  await context.close();
} catch (error) {
  abort(error);
} finally {
  await web.close();
  await finishJourney(artifactDirectory, checks);
}
