/** Saved-tab continuity, slow starts, failure/retry and long profile names in headless Chromium. */
import type { MockHostClient } from "@opensteer/client/mock";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expectThat, finishJourney, journeyChecks, openMockWeb } from "./mock-web-journey.js";

const artifactDirectory = path.resolve(
  process.env.OPENSTEER_BROWSER_RESTORE_EVIDENCE_DIR ??
    path.join(tmpdir(), "opensteer-browser-restore-evidence"),
);
await mkdir(artifactDirectory, { recursive: true });
const { checks, check, abort } = journeyChecks();
const web = await openMockWeb("opensteer-browser-restore-web");
const trace: Record<string, unknown>[] = [];
const profileName =
  "Work Shopping Research Travel Projects Personal Accounts International Client Services";
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
  const waitForPaint = async () => {
    await page.waitForFunction(() => {
      const canvas = document.querySelector<HTMLCanvasElement>(".browser-canvas canvas");
      const pixel = canvas?.getContext("2d")?.getImageData(0, 0, 1, 1).data;
      return pixel && pixel[0]! + pixel[1]! + pixel[2]! > 0;
    });
    await page.locator(".browser-status").waitFor({ state: "hidden" });
  };
  const open = async (options: { connected?: boolean; unavailableReason?: string } = {}) => {
    await page.goto(`${web.origin}/?panel=browser`);
    await page.locator(".start-page__pill").waitFor();
    await page.waitForFunction(
      () =>
        (Reflect.get(window, "opensteerMock") as MockHostClient).getSnapshot().connection ===
        "connected",
    );
    const saved = await page.evaluate(
      (input) =>
        (Reflect.get(window, "opensteerMock") as MockHostClient).scriptDormantBrowser(input),
      { profileName, ...options },
    );
    const row = page.locator(
      `.side-tab[data-motion-key="browser:${saved.sessionId}:${saved.tabId}"]`,
    );
    await row.locator(".side-tab__main").evaluate((button) => {
      const timing = { selectedAt: 0, bubbleAt: 0 };
      Reflect.set(window, "restoreTiming", timing);
      button.addEventListener(
        "click",
        () => {
          timing.selectedAt = performance.now();
        },
        { once: true },
      );
      const observer = new MutationObserver(() => {
        if (!document.querySelector(".browser-status")) return;
        timing.bubbleAt = performance.now();
        observer.disconnect();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
    await row.locator(".side-tab__main").click();
    await page.locator(`[data-browser-tab="${saved.tabId}"]`).waitFor();
    // Observe what can actually paint, after layout effects publish activation.
    await page.evaluate(() => new Promise(requestAnimationFrame));
    return saved;
  };
  const state = async () =>
    page.evaluate(() => {
      const field = document.querySelector<HTMLInputElement>(
        '[aria-label="Search or enter address"]',
      );
      const chip = document.querySelector<HTMLElement>(".profile-chip__name");
      const address = document.querySelector<HTMLElement>(".browser-address");
      return {
        address: field?.value,
        disabled: field?.disabled,
        chip: chip?.textContent,
        chipWidth: chip?.clientWidth,
        chipScroll: chip?.scrollWidth,
        addressWidth: address?.clientWidth,
        stopDisabled: document.querySelector<HTMLButtonElement>('[aria-label="Stop loading"]')
          ?.disabled,
        backDisabled: document.querySelector<HTMLButtonElement>('[aria-label="Go back"]')?.disabled,
        forwardDisabled: document.querySelector<HTMLButtonElement>('[aria-label="Go forward"]')
          ?.disabled,
        spinner: !!document.querySelector(
          '.side-tab[aria-current="true"] .spinner, .side-tab:has([aria-current="true"]) .spinner, .side-tab.is-active .spinner',
        ),
        stage: document.querySelector(".browser-stage")?.textContent?.trim(),
        bubble: document.querySelector(".browser-status")?.textContent,
      };
    });
  await check("dormant selection keeps the real toolbar and a blank stage", async () => {
    const saved = await open();
    await page.evaluate(() => {
      Reflect.set(window, "restoreView", document.querySelector(".browser-view"));
      Reflect.set(window, "restoreToolbar", document.querySelector(".browser-toolbar"));
      Reflect.set(
        window,
        "restoreAddress",
        document.querySelector('[aria-label="Search or enter address"]'),
      );
    });
    const observed = { ...(await state()), saved };
    trace.push({ phase: "selected", ...observed });
    await shot("01-selected");
    expectThat(
      observed,
      observed.address === saved.site &&
        observed.disabled === true &&
        observed.chip === profileName,
      "Saved address and identity disappeared",
    );
    expectThat(
      observed,
      observed.stopDisabled === true &&
        observed.backDisabled === true &&
        observed.forwardDisabled === true &&
        observed.spinner,
      "Restore must spin with disabled Stop/Back/Forward",
    );
    expectThat(
      observed,
      observed.stage === "" && !observed.bubble,
      "Transient stage prose appeared before one second",
    );
    return observed;
  });
  await check("slow activation shows only a delayed status bubble", async () => {
    await page.locator(".browser-status").waitFor({ timeout: 3000 });
    const timing = await page.evaluate(
      () => Reflect.get(window, "restoreTiming") as { selectedAt: number; bubbleAt: number },
    );
    const observed = { ...(await state()), bubbleDelayMs: timing.bubbleAt - timing.selectedAt };
    expectThat(
      observed,
      observed.bubbleDelayMs >= 1000,
      "Status bubble appeared before one second",
    );
    trace.push({ phase: "slow", ...observed });
    await shot("02-slow-start");
    expectThat(
      observed,
      observed.bubble === "Starting browser…" && observed.stage === observed.bubble,
      "Slow start must show only its status bubble",
    );
    return observed;
  });
  await check("activation failure keeps chrome and offers retry", async () => {
    await page.evaluate(() =>
      (Reflect.get(window, "opensteerMock") as MockHostClient).finishBrowserActivation(
        "The saved tab could not reopen.",
      ),
    );
    await page.getByRole("button", { name: "Try again" }).waitFor();
    const observed = await state();
    trace.push({ phase: "failed", ...observed });
    await shot("03-failure");
    expectThat(
      observed,
      observed.stage?.includes("The saved tab could not reopen.") === true &&
        !observed.bubble &&
        observed.chip === profileName &&
        !observed.spinner,
      "Failure must end loading and retain retry and identity",
    );
    await page.getByRole("button", { name: "Try again" }).click();
    await page.evaluate(() =>
      (Reflect.get(window, "opensteerMock") as MockHostClient).finishBrowserActivation(),
    );
    await waitForPaint();
    expectThat(
      observed,
      (await page.locator(".browser-status, .place-state").count()) === 0,
      "First paint retained waiting state",
    );
    const continuity = await page.evaluate(() => ({
      view: Reflect.get(window, "restoreView") === document.querySelector(".browser-view"),
      toolbar: Reflect.get(window, "restoreToolbar") === document.querySelector(".browser-toolbar"),
      address:
        Reflect.get(window, "restoreAddress") ===
        document.querySelector('[aria-label="Search or enter address"]'),
    }));
    expectThat(
      continuity,
      continuity.view && continuity.toolbar && continuity.address,
      "Restoration replaced the view, toolbar or address field",
    );
    const painted = await state();
    expectThat(
      painted,
      painted.spinner && painted.stopDisabled === false,
      "Loading must continue after first paint until the tab's load ends",
    );
    await page.waitForTimeout(1100);
    expectThat(
      painted,
      (await page.locator(".browser-status").count()) === 0,
      "An ordinary navigation load showed a pre-paint bubble",
    );
    const tabId = await page.locator(".browser-view").getAttribute("data-browser-tab");
    await page.evaluate(
      (id) =>
        (Reflect.get(window, "opensteerMock") as MockHostClient).setBrowserLoading(id!, false),
      tabId,
    );
    await page.getByRole("button", { name: "Reload page", exact: true }).waitFor();
    const loaded = await state();
    expectThat(loaded, !loaded.spinner, "The sidebar spinner outlived the tab load");
    trace.push({ phase: "painted", ...painted, continuity }, { phase: "loaded", ...loaded });
    await shot("04-restored");
    return { ...observed, continuity, painted, loaded };
  });
  await check("long profile names stay within the toolbar and menu", async () => {
    const observed = await state();
    expectThat(
      observed,
      Number(observed.chipWidth) < Number(observed.chipScroll) &&
        Number(observed.addressWidth) - Number(observed.chipWidth) > 200,
      "Profile name displaced the readable address",
    );
    await page.locator(".profile-chip").click();
    await page.locator(".chip-menu__using").waitFor();
    const menu = await page.locator(".chip-menu__using").evaluate((node) => ({
      title: node.getAttribute("title"),
      width: node.clientWidth,
      scroll: node.scrollWidth,
    }));
    expectThat(
      menu,
      menu.title === profileName && menu.width < menu.scroll,
      "Profile menu did not contain the full name with a tooltip",
    );
    await shot("05-profile-menu");
    await page.keyboard.press("Escape");
    return { ...observed, menu };
  });
  await check("unconnected computer waits quietly then names the computer", async () => {
    await open({ connected: false });
    const early = await state();
    expectThat(early, early.stage === "", "Disconnected computer showed early prose");
    expectThat(
      early,
      early.spinner && early.stopDisabled === true,
      "Disconnected selection must immediately spin with disabled Stop",
    );
    await page.locator(".browser-status").waitFor({ timeout: 3000 });
    const observed = await state();
    expectThat(
      observed,
      observed.bubble?.startsWith("Waiting for ") === true,
      "Disconnected computer did not get the delayed bubble",
    );
    await shot("06-waiting-computer");
    trace.push({ phase: "disconnected", ...observed });
    await page.evaluate(() =>
      (Reflect.get(window, "opensteerMock") as MockHostClient).setDormantBrowserState({
        connected: true,
      }),
    );
    await page.evaluate(() =>
      (Reflect.get(window, "opensteerMock") as MockHostClient).finishBrowserActivation(),
    );
    await waitForPaint();
    expectThat(
      observed,
      (await page.locator(".browser-status, .place-state").count()) === 0,
      "Reconnecting did not activate and paint the selected tab",
    );
    await shot("09-reconnected");
    return { ...observed, reconnected: true };
  });
  await check("lasting unavailable reason stays centered", async () => {
    await open({ connected: false, unavailableReason: "This computer is no longer available." });
    await page.getByText("This computer is no longer available.", { exact: true }).waitFor();
    const observed = await state();
    expectThat(
      observed,
      !observed.bubble && (await page.locator(".place-state").count()) === 1,
      "Unavailable reason must be a lasting centered state",
    );
    await shot("07-unavailable");
    return observed;
  });
  await check("New tab contains its long profile pill", async () => {
    await page.getByRole("button", { name: "New tab", exact: true }).first().click();
    await page.locator(".start-page__pill").click();
    await page.getByRole("menuitemradio", { name: profileName, exact: false }).click();
    const observed = await page.locator(".start-page__pill-name").evaluate((node) => ({
      title: node.parentElement?.title,
      width: node.clientWidth,
      scroll: node.scrollWidth,
      name: node.textContent,
    }));
    await shot("08-new-tab");
    expectThat(
      observed,
      observed.name === profileName &&
        observed.title === profileName &&
        observed.width < observed.scroll,
      "New tab profile name must truncate with a full tooltip",
    );
    return observed;
  });
  await check("a live tab awaiting its first frame names the computer", async () => {
    await open();
    const computer = await page.evaluate(() => {
      const client = Reflect.get(window, "opensteerMock") as MockHostClient;
      const retain = client.retainBrowserViewer;
      Reflect.set(
        client,
        "retainBrowserViewer",
        (...args: Parameters<MockHostClient["retainBrowserViewer"]>) => {
          let release: (() => void) | null = null;
          Reflect.set(window, "resumeBrowserViewer", () => {
            release = retain(...args);
          });
          return () => release?.();
        },
      );
      const snapshot = client.getSnapshot();
      const group = snapshot.workspaceTabs!.find((lineage) =>
        lineage.tabs?.some((tab) => tab.id === snapshot.activatingWorkspaceTabs![0]),
      )!;
      const label = snapshot.browserPlacements.find(
        (placement) => placement.runnerId === group.session.placement.runnerId,
      )!.label;
      client.finishBrowserActivation();
      return label;
    });
    await page.locator(".browser-status").waitFor({ timeout: 3000 });
    const observed = await state();
    expectThat(
      observed,
      observed.bubble === `Waiting for ${computer}…`,
      "A live viewer awaiting a frame must name its computer",
    );
    await shot("13-live-viewer-waiting");
    await page.evaluate(() => (Reflect.get(window, "resumeBrowserViewer") as () => void)());
    await waitForPaint();
    trace.push({ phase: "live-viewer-waiting", ...observed });
    return observed;
  });
  await check("closing a tab while waiting settles without an error or spinner", async () => {
    const saved = await open({ connected: false });
    await page.evaluate(() =>
      (Reflect.get(window, "opensteerMock") as MockHostClient).setDormantBrowserState({
        closed: true,
      }),
    );
    await page.waitForFunction(
      () =>
        (Reflect.get(window, "opensteerMock") as MockHostClient).getSnapshot()
          .activatingWorkspaceTabs?.length === 0,
    );
    const observed = {
      ...(await state()),
      removed: await page
        .locator(`.side-tab[data-motion-key="browser:${saved.sessionId}:${saved.tabId}"]`)
        .count(),
      retry: await page.getByRole("button", { name: "Try again" }).count(),
    };
    expectThat(
      observed,
      observed.removed === 0 && observed.retry === 0 && !observed.spinner,
      "Closed waiting tab left a spinner or activation error",
    );
    trace.push({ phase: "closed-while-waiting", ...observed });
    await shot("10-closed-while-waiting");
    return observed;
  });
  await check("lasting reason appearing mid-wait stops restoration loading", async () => {
    await open({ connected: false });
    await page.evaluate(() =>
      (Reflect.get(window, "opensteerMock") as MockHostClient).setDormantBrowserState({
        restoring: true,
        unavailableReason: "This computer is no longer available.",
      }),
    );
    await page.getByText("This computer is no longer available.", { exact: true }).waitFor();
    const pending = await page.evaluate(
      () =>
        (Reflect.get(window, "opensteerMock") as MockHostClient).getSnapshot()
          .activatingWorkspaceTabs,
    );
    const observed = { ...(await state()), pending };
    expectThat(
      observed,
      !observed.spinner &&
        !observed.bubble &&
        observed.pending?.length === 0 &&
        (await page.locator(".place-state").count()) === 1,
      "Lasting unavailability did not override restoring/loading",
    );
    trace.push({ phase: "unavailable-mid-wait", ...observed });
    await shot("11-unavailable-mid-wait");
    return observed;
  });
  await check("account change settles the old waiting operation", async () => {
    const saved = await open({ connected: false });
    await page.evaluate(() => {
      const client = Reflect.get(window, "opensteerMock") as MockHostClient;
      Reflect.set(
        window,
        "oldActivation",
        client
          .activateWorkspaceTab(client.getSnapshot().activatingWorkspaceTabs![0]!)
          .then((outcome) => {
            Reflect.set(window, "oldActivationOutcome", outcome);
          }),
      );
      client.setDormantBrowserState({ accountChanged: true, closed: true });
    });
    await page.waitForFunction(() => Reflect.get(window, "oldActivationOutcome") === null);
    const observed = await page.evaluate(() => {
      const snapshot = (Reflect.get(window, "opensteerMock") as MockHostClient).getSnapshot();
      return {
        pending: snapshot.activatingWorkspaceTabs,
        oldOutcome: Reflect.get(window, "oldActivationOutcome"),
        sessions: snapshot.browserSessions.map((session) => session.id),
      };
    });
    expectThat(
      observed,
      observed.pending?.length === 0 &&
        observed.oldOutcome === null &&
        !observed.sessions.includes(saved.sessionId),
      "Account change retained or applied the old activation",
    );
    trace.push({ phase: "account-changed", ...observed });
    await shot("12-account-changed");
    return observed;
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
