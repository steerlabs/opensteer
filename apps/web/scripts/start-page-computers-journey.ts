/**
 * The New tab's computers, end to end in a real browser: the production web
 * build against the mock Host, driven in headless Chromium while the mock's
 * computers go offline, need their owner and come back.
 *
 * Ways this journey can fail, each checked below:
 *  1. An offline computer's apps still show as tiles that look openable.
 *  2. The offline computer vanishes with no trace, or its line sits among the
 *     rows that open instead of after them, or takes more than one quiet line.
 *  3. The offline line can be clicked, focused, reached with the arrow keys,
 *     or lights up under the pointer.
 *  4. A computer waiting on its owner offers no way to its page, or the arrow
 *     keys cannot reach it.
 *  5. Typing hides an offline computer's app, ranks it before a row that
 *     opens, offers to open it, lets the highlight land on it, or asks the
 *     Host for a view of it.
 *  6. A row that folds under the keyboard drops it on the page body, or a row
 *     that stays loses it while another folds or unfolds (Chromium drops focus
 *     from any node that moves), or a line that stops needing its owner drops
 *     it as it stops being a button.
 *  7. A narrow window wraps a folded line or cuts its words.
 *  8. A computer that is back does not unfold in its own place, or its apps
 *     do not open.
 *  9. A search opens its page at a size other than the pane it is shown in.
 *
 * `result.json` and screenshots go to
 * OPENSTEER_START_PAGE_COMPUTERS_E2E_ARTIFACT_DIR, or
 * `opensteer-start-page-computers-e2e` in the system temporary directory.
 */
import type { MockHostClient } from "@opensteer/client/mock";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expectThat, finishJourney, journeyChecks, openMockWeb } from "./mock-web-journey.js";

const artifactDirectory = path.resolve(
  process.env.OPENSTEER_START_PAGE_COMPUTERS_E2E_ARTIFACT_DIR ??
    path.join(tmpdir(), "opensteer-start-page-computers-e2e"),
);
const away = ".start-apps__away .start-apps__row";
const keynote = ".start-tile[aria-label^='Keynote on']";
const pixel = ".start-tile[aria-label^='Pixel 7']";
type Status = "online" | "offline" | "update-pending";

const { checks, check, abort } = journeyChecks();

await rm(artifactDirectory, { force: true, recursive: true });
await mkdir(artifactDirectory, { recursive: true });
const web = await openMockWeb("opensteer-start-page-computers-web");
const { browser, origin } = web;

try {
  const context = await browser.newContext({ viewport: { height: 900, width: 1280 } });
  // Nothing leaves the machine: anything outside the app answers here.
  await context.route(
    (url) => url.origin !== origin,
    (route) => route.fulfill({ body: "", contentType: "text/plain", status: 204 }),
  );
  const page = await context.newPage();
  const shot = (name: string) => page.screenshot({ path: path.join(artifactDirectory, name) });

  /** A fresh mock world on the New tab, counting the views the page asks the Host for. */
  const openStartPage = async () => {
    await page.goto(`${origin}/?panel=browser`);
    await page.locator(keynote).waitFor();
    await page.evaluate(() => {
      const client = Reflect.get(window, "opensteerMock") as MockHostClient;
      const open = client.openComputerView.bind(client);
      Reflect.set(window, "viewsAsked", 0);
      // Handed over as an argument, the counter gets no injected name helper the page lacks.
      Reflect.set(
        client,
        "openComputerView",
        (...args: Parameters<MockHostClient["openComputerView"]>) => {
          Reflect.set(window, "viewsAsked", Number(Reflect.get(window, "viewsAsked")) + 1);
          return open(...args);
        },
      );
    });
  };
  const setStatus = (name: string, status: Status) =>
    page.evaluate(
      ([machineName, next]) => {
        const client = Reflect.get(window, "opensteerMock") as MockHostClient;
        const machine = client.getSnapshot().machines.find((item) => item.name === machineName)!;
        client.setMachineStatus(machine.id, next);
      },
      [name, status] as const,
    );
  const needsPermission = (name: string) =>
    page.evaluate((machineName) => {
      const client = Reflect.get(window, "opensteerMock") as MockHostClient;
      const machine = client.getSnapshot().machines.find((item) => item.name === machineName)!;
      client.setComputerUseReadiness(machine.id, "permission-required");
      return machine.id;
    }, name);
  const captions = (scope = ".start-page__apps") =>
    page.$$eval(`${scope} .start-apps__caption`, (nodes) => nodes.map((node) => node.textContent));
  const viewsAsked = () => page.evaluate(() => Number(Reflect.get(window, "viewsAsked")));
  const focused = () =>
    page.evaluate(() => {
      const active = document.activeElement;
      return active === document.body
        ? "body"
        : (active?.getAttribute("aria-label") ?? active?.className ?? null);
    });

  await check(
    "an offline computer folds into one quiet line after the rows that open",
    async () => {
      await openStartPage();
      const before = await captions();
      await shot("1-all-online.png");
      await setStatus("Studio Mac", "offline");
      await page.locator(away).waitFor();
      const line = page.locator(away);
      const phoneRow = page.locator(".start-apps__row", { has: page.locator(pixel) });
      const [lineBox, phoneBox] = [await line.boundingBox(), await phoneRow.boundingBox()];
      await line.hover();
      const observed = {
        before,
        after: await captions(),
        keynoteTiles: await page.locator(keynote).count(),
        status: await line.locator(".start-apps__status").textContent(),
        tag: await line.evaluate((node) => node.tagName),
        reachable: await line.evaluate(
          (node) =>
            node.matches("[data-start-tile], [tabindex]") ||
            node.querySelector("button, a, [tabindex], [data-start-tile]") !== null,
        ),
        underPointer: await line.evaluate((node) => {
          const style = getComputedStyle(node);
          return { background: style.backgroundColor, cursor: style.cursor };
        }),
        lineHeight: lineBox?.height ?? null,
        belowPhone: lineBox && phoneBox ? lineBox.y >= phoneBox.y + phoneBox.height : null,
      };
      await shot("2-studio-mac-offline.png");
      expectThat(
        observed,
        JSON.stringify(observed.before) === JSON.stringify(["Mac mini", "Studio Mac", "Phone"]),
        "the rows did not start in their own order",
      );
      expectThat(
        observed,
        JSON.stringify(observed.after) === JSON.stringify(["Mac mini", "Phone", "Studio Mac"]),
        "the offline computer is not after the rows that open",
      );
      expectThat(
        observed,
        observed.keynoteTiles === 0,
        "the offline computer's app is still a tile",
      );
      expectThat(observed, observed.status === "Offline", "the line does not say Offline");
      expectThat(observed, observed.tag === "DIV" && !observed.reachable, "the line can be chosen");
      expectThat(
        observed,
        observed.underPointer.background === "rgba(0, 0, 0, 0)" &&
          observed.underPointer.cursor !== "pointer",
        "the line lights up under the pointer",
      );
      expectThat(observed, observed.belowPhone === true, "the line is not below the phone's row");
      expectThat(observed, (observed.lineHeight ?? 99) <= 40, "the line is more than one line");
      return observed;
    },
  );

  await check(
    "a computer waiting on its owner folds into a line the keys reach and that opens its page",
    async () => {
      await openStartPage();
      await setStatus("Studio Mac", "offline");
      const miniId = await needsPermission("Mac mini");
      await setStatus("Pixel 7", "update-pending");
      await page.locator(`${away}:nth-child(3)`).waitFor();
      await shot("3-needs-you.png");
      const lines = await page.$$eval(away, (nodes) =>
        nodes.map((node) => ({
          tag: node.tagName,
          name: node.querySelector(".start-apps__caption")?.textContent,
          status: node.querySelector(".start-apps__status")?.textContent,
          title: node.getAttribute("title"),
        })),
      );
      // Down from the field to the first line, then over the offline one to the phone's.
      await page.locator(".start-page__input").focus();
      await page.keyboard.press("ArrowDown");
      const first = await focused();
      await page.keyboard.press("ArrowDown");
      const second = await focused();
      await page.keyboard.press("ArrowUp");
      await page.keyboard.press("Enter");
      await page.waitForURL((url) => url.pathname.startsWith("/settings/computers/"));
      const observed = { lines, first, second, path: new URL(page.url()).pathname };
      expectThat(
        observed,
        JSON.stringify(lines.map(({ tag, name, status }) => [tag, name, status])) ===
          JSON.stringify([
            ["BUTTON", "Mac mini", "Needs permission"],
            ["DIV", "Studio Mac", "Offline"],
            ["BUTTON", "Pixel 7", "Needs update"],
          ]),
        "the folded lines are not the computers in order with their words",
      );
      expectThat(
        observed,
        lines[0]?.title === "Allow Screen Recording on Mac mini to see its apps.",
        "the line does not say what its owner can do",
      );
      expectThat(
        observed,
        first === "Mac mini, Needs permission" && second === "Pixel 7, Needs update",
        "the arrow keys do not pass from line to line over the offline one",
      );
      expectThat(
        observed,
        observed.path === `/settings/computers/${encodeURIComponent(miniId)}`,
        "the line did not open its computer's page",
      );
      return observed;
    },
  );

  await check(
    "typing finds an offline computer's app after what opens, says why and never opens it",
    async () => {
      await openStartPage();
      await setStatus("Studio Mac", "offline");
      await page.locator(away).waitFor();
      const field = page.locator(".start-page__input");
      await field.fill("k");
      const keynoteRow = page.locator(".start-result", { hasText: "Keynote" });
      await keynoteRow.waitFor();
      const active = () =>
        page.locator(".start-result.is-active .start-result__title").textContent();
      const rows = await page.$$eval(".start-result", (nodes) =>
        nodes.map((node) => [
          node.querySelector(".start-result__title")?.textContent,
          node.querySelector(".start-result__action")?.textContent,
          node.classList.contains("is-inert"),
        ]),
      );
      const highlighted = [await active()];
      for (const key of ["ArrowDown", "ArrowUp", "ArrowUp"]) {
        await field.press(key);
        highlighted.push(await active());
      }
      await keynoteRow.hover();
      highlighted.push(await active());
      await shot("4-typed-offline-app.png");
      const url = page.url();
      // It is aria-disabled, which Playwright won't click; a person's pointer still can.
      await keynoteRow.click({ force: true });
      await page.waitForTimeout(300);
      const observed = {
        rows,
        highlighted,
        cursor: await keynoteRow.evaluate((node) => getComputedStyle(node).cursor),
        urlAfterClick: page.url() === url,
        refusal: await page.locator(".start-page__refusal").count(),
        viewsAsked: await viewsAsked(),
      };
      expectThat(
        observed,
        JSON.stringify(rows) ===
          JSON.stringify([
            ["k", "Search the web · Guest", false],
            ["Keynote", "Offline", true],
          ]),
        "the search is not first, or the offline app is not found, said and inert after it",
      );
      expectThat(
        observed,
        highlighted.every((title) => title === "k"),
        "the highlight landed on the offline app",
      );
      expectThat(observed, observed.cursor === "default", "the offline app looks choosable");
      expectThat(
        observed,
        observed.urlAfterClick && observed.refusal === 0 && observed.viewsAsked === 0,
        "choosing the offline app did something",
      );
      return observed;
    },
  );

  await check(
    "a row that folds hands the keyboard to the field; rows that stay keep it",
    async () => {
      await openStartPage();
      await page.locator(keynote).focus();
      const before = await focused();
      await setStatus("Studio Mac", "offline");
      await page.locator(away).waitFor();
      const afterFold = await focused();
      await page.locator(pixel).focus();
      await setStatus("Studio Mac", "online");
      await page.locator(keynote).waitFor();
      const afterUnfold = await focused();
      // A row above the focused one folds, and the one before it moves nothing either.
      await needsPermission("Mac mini");
      await page.locator(away).waitFor();
      const afterAboveFolds = await focused();
      // The Mac that needs its owner goes to sleep while its line has the keyboard.
      await page.locator(`${away} >> nth=0`).focus();
      const onLine = await focused();
      await setStatus("Mac mini", "offline");
      await page.locator(`${away} .start-apps__status`, { hasText: "Offline" }).waitFor();
      const afterLineGoesAway = await focused();
      const observed = {
        before,
        afterFold,
        afterUnfold,
        afterAboveFolds,
        onLine,
        afterLineGoesAway,
      };
      expectThat(observed, before?.startsWith("Keynote on") === true, "Keynote never had focus");
      expectThat(
        observed,
        afterFold === "Search websites and apps",
        "the folded row's focus did not go to the search field",
      );
      expectThat(
        observed,
        afterUnfold === "Pixel 7" && afterAboveFolds === "Pixel 7",
        "a row that stayed lost the keyboard",
      );
      expectThat(
        observed,
        onLine === "Mac mini, Needs permission" && afterLineGoesAway === "Search websites and apps",
        "a line that stopped needing its owner dropped the keyboard",
      );
      return observed;
    },
  );

  await check(
    "a narrow window keeps each folded computer on one line, its words whole",
    async () => {
      await page.setViewportSize({ height: 844, width: 390 });
      await openStartPage();
      await setStatus("Studio Mac", "offline");
      await needsPermission("Mac mini");
      await page.locator(`${away}:nth-child(2)`).waitFor();
      const lines = await page.$$eval(away, (nodes) =>
        nodes.map((node) => {
          const caption = node.querySelector(".start-apps__caption")!.getBoundingClientRect();
          const status = node.querySelector<HTMLElement>(".start-apps__status")!;
          const box = status.getBoundingClientRect();
          return {
            height: node.getBoundingClientRect().height,
            sameLine: Math.abs(box.top + box.height / 2 - (caption.top + caption.height / 2)) < 4,
            whole: status.scrollWidth <= status.clientWidth,
          };
        }),
      );
      await shot("5-narrow.png");
      await page.setViewportSize({ height: 900, width: 1280 });
      const observed = { lines };
      expectThat(
        observed,
        lines.length === 2 &&
          lines.every((line) => line.height <= 40 && line.sameLine && line.whole),
        "a folded line wraps or cuts its words",
      );
      return observed;
    },
  );

  await check("a computer that is back unfolds in its own place and its apps open", async () => {
    await openStartPage();
    await setStatus("Studio Mac", "offline");
    await page.locator(away).waitFor();
    await setStatus("Studio Mac", "online");
    await page.locator(keynote).waitFor();
    const back = await captions();
    const folded = await page.locator(away).count();
    await page.locator(keynote).click();
    await page.locator(".owner-view").waitFor();
    const observed = {
      back,
      folded,
      view: await page.locator(".owner-view").getAttribute("aria-label"),
      viewsAsked: await viewsAsked(),
    };
    await shot("6-back-and-open.png");
    expectThat(
      observed,
      JSON.stringify(back) === JSON.stringify(["Mac mini", "Studio Mac", "Phone"]) && folded === 0,
      "the computer did not come back in its own place",
    );
    expectThat(
      observed,
      observed.viewsAsked === 1 && observed.view?.includes("Keynote") === true,
      "its app did not open",
    );
    return observed;
  });

  await check("a search opens its page at the size of the pane it is shown in", async () => {
    // A window that is not focused never resizes its page, so the size the
    // New tab opens a page at is the size that page is shown at until then.
    // Wide enough that the pane is above the page's floor width, so the two
    // sizes are equal rather than scaled.
    await page.setViewportSize({ height: 900, width: 1680 });
    await openStartPage();
    await page.evaluate(() => {
      const client = Reflect.get(window, "opensteerMock") as MockHostClient;
      const open = client.openBrowserTab.bind(client);
      Reflect.set(
        client,
        "openBrowserTab",
        (...args: Parameters<MockHostClient["openBrowserTab"]>) => {
          Reflect.set(window, "openedAt", args[1]?.viewport ?? null);
          return open(...args);
        },
      );
    });
    const field = page.getByRole("combobox", { name: "Search websites and apps" });
    await field.fill("al di là Trattoria");
    const content = await page
      .locator(".start-page__column")
      .evaluate((node) => node.getBoundingClientRect().height);
    await field.press("Enter");
    // The mock has two computers, so the New tab asks which one to browse on.
    await page.locator(".start-page__refusal-actions button", { hasText: "Mac mini" }).click();
    const stage = page.locator(".browser-stage");
    await stage.waitFor();
    const observed = {
      content,
      openedAt: await page.evaluate(() => Reflect.get(window, "openedAt") as unknown),
      stage: await stage.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return { height: Math.round(rect.height), width: Math.round(rect.width) };
      }),
    };
    await shot("8-search-opened.png");
    await page.setViewportSize({ height: 900, width: 1280 });
    expectThat(
      observed,
      observed.content < observed.stage.height && observed.stage.width >= 768,
      "the New tab's results fill its pane, so the size it measures is not tested",
    );
    expectThat(
      observed,
      JSON.stringify(observed.openedAt) === JSON.stringify(observed.stage),
      "the page opened at a size other than the pane it is shown in",
    );
    return observed;
  });

  await check(
    "a first read of the approved apps that fails is read again, without reopening the tab",
    async () => {
      // A Host or Runner restarting (an update does both) can refuse the New
      // tab's first read; the tab that stays open must still get its apps.
      const restarting = await browser.newContext({ viewport: { height: 900, width: 1280 } });
      await restarting.route(
        (url) => url.origin !== origin,
        (route) => route.fulfill({ body: "", contentType: "text/plain", status: 204 }),
      );
      // A plain script: a function handed over would carry tsx's injected name
      // helper, which the page lacks, and the hook would silently not install.
      await restarting.addInitScript({
        content: `
          let installed;
          Object.defineProperty(window, "opensteerMock", {
            configurable: true,
            get() { return installed; },
            set(client) {
              const read = client.listApprovedComputerApps.bind(client);
              window.approvedReads = 0;
              client.listApprovedComputerApps = function () {
                window.approvedReads += 1;
                return window.approvedReads === 1
                  ? Promise.reject(new Error("The Host is restarting."))
                  : read();
              };
              installed = client;
            },
          });
        `,
      });
      const reopened = await restarting.newPage();
      await reopened.goto(`${origin}/?panel=browser`);
      const appeared = await reopened
        .locator(keynote)
        .waitFor({ timeout: 15_000 })
        .then(
          () => true,
          () => false,
        );
      const observed = {
        appeared,
        reads: await reopened.evaluate(() => Number(Reflect.get(window, "approvedReads"))),
      };
      await reopened.screenshot({ path: path.join(artifactDirectory, "7-read-again.png") });
      await restarting.close();
      expectThat(observed, observed.reads >= 1, "the restart hook did not install");
      expectThat(
        observed,
        appeared && observed.reads >= 2,
        "the New tab stayed without its apps after one failed read",
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

await finishJourney(artifactDirectory, checks);
