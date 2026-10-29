/**
 * Links an agent writes in its replies, end to end in a real browser: the
 * production web build against the mock Host, served the way a Host serves
 * it, driven in headless Chromium with real clicks.
 *
 * Ways this journey can fail, each checked below:
 *  1. A file-path link replaces the app document or opens a page.
 *  2. A workspace-relative link navigates instead of staying words.
 *  3. A plain HTTPS click from Talk fails to open exactly one workspace tab
 *     at the exact address, loses the conversation, or opens a device page.
 *  4. A click from Work loses its covered place's default profile.
 *  5. A plain HTTP click does not follow the same workspace path as HTTPS.
 *  6. A modifier or middle click is intercepted or opens a workspace tab.
 *  7. Back/Forward or reload replays an already consumed arrival trigger.
 *  8. A narrow layout fails to open and show the new tab.
 *  9. A mail link stops being an outside link.
 * 10. Images are fetched, lose their words, or nest links.
 * 11. A refusal loses the address or cannot complete after a computer choice.
 *
 * Isolation failures covered in the existing interaction tests:
 * 12. Desktop web links call openExternalUrl, reject HTTP/autolinks, or let
 *     modifier or auxiliary clicks escape; web gestures or workspace-less
 *     links navigate.
 * 13. StrictMode opens twice, the navigate row switches to an existing tab,
 *     an unavailable result opens anyway, or a late answer steals a place.
 * 14. Untrusted launcher state accepts a non-URL or an oversized address.
 *
 * `result.json` and screenshots go to OPENSTEER_TRANSCRIPT_LINKS_E2E_ARTIFACT_DIR,
 * or `opensteer-transcript-links-e2e` in the system temporary directory.
 * Chromium is Playwright's (`playwright-core install chromium`) unless
 * OPENSTEER_CHROMIUM_EXECUTABLE names another.
 */
import type { MockHostClient } from "@opensteer/client/mock";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Frame, Locator, Page, Request } from "playwright-core";
import { expectThat, finishJourney, journeyChecks, openMockWeb } from "./mock-web-journey.js";

const artifactDirectory = path.resolve(
  process.env.OPENSTEER_TRANSCRIPT_LINKS_E2E_ARTIFACT_DIR ??
    path.join(tmpdir(), "opensteer-transcript-links-e2e"),
);
const portableFsThreadPath = "/threads/thr_00000000-0000-4000-8000-000000000002";
const documentKey = "__opensteerTranscriptJourneyDocument";

const { checks, check, abort } = journeyChecks();

await mkdir(artifactDirectory, { recursive: true });
const web = await openMockWeb("opensteer-transcript-links-web");
const { browser, origin } = web;

try {
  const context = await browser.newContext({ viewport: { height: 900, width: 1280 } });
  const requests: { readonly url: string; readonly navigation: boolean; readonly page: string }[] =
    [];
  const pages = new Map<Page, string>();
  context.on("page", (opened) => pages.set(opened, pages.size === 0 ? "app" : "opened"));
  context.on("request", (request) => {
    // A worker's request has no frame, nor does a new page's first navigation;
    // both still count as fetches, and neither navigates the app.
    const frame = request.serviceWorker() ? null : frameOf(request);
    requests.push({
      navigation:
        frame !== null && request.isNavigationRequest() && frame === frame.page().mainFrame(),
      page: frame ? (pages.get(frame.page()) ?? "unknown") : "worker",
      url: request.url(),
    });
  });
  // Nothing leaves the machine: anything outside the app answers here.
  await context.route(
    (url) => url.origin !== origin,
    (route) =>
      route.fulfill({
        body: "<title>Outside Opensteer</title>",
        contentType: "text/html",
        status: 200,
      }),
  );
  const page = await context.newPage();

  /** A fresh copy of the app on `route`, with the reply on screen and its document tagged. */
  const open = async (route: string, replyText: string) => {
    // Choose Talk before reloading: restoration runs after the transcript
    // appears. Use the chrome control because a live page can own the keyboard.
    if (
      page.url().startsWith(`${origin}/`) &&
      (await page.locator(".workspace--work").isVisible())
    ) {
      await page.getByRole("button", { name: /^(?:Expand chat|Hide computer)$/u }).click();
      await page.locator(".workspace--talk").waitFor();
    }
    await page.goto(`${origin}${route}`);
    const reply = page.locator(".md-prose").filter({ hasText: replyText });
    await reply.waitFor();
    await page.locator(".workspace--talk").waitFor();
    return { document: await markDocument(page), reply };
  };
  const pictureReplyText = "Picked a tiger charging through snow";
  const sourcesReplyText = "PortableFS mount guide";

  await check("the incident's file link keeps the app on its page", async () => {
    const { document, reply } = await open("/", pictureReplyText);
    const label = reply.getByText("tiger-in-snow.jpg", { exact: true });
    const isLink = await label.evaluate((element) => element.closest("a") !== null);
    await label.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifactDirectory, "chat-reply.png") });
    const before = requests.length;
    const opened = await clickWithoutOpening(page, label);
    const after = await documentState(page, document);
    const navigations = appNavigations(requests.slice(before));
    await page.screenshot({ path: path.join(artifactDirectory, "chat-after-click.png") });
    const observed = { after, isLink, navigations, opened };
    expectThat(observed, navigations.length === 0, "the click navigated the app's document");
    expectThat(observed, after.sameDocument && after.path === "/", "the app document changed");
    expectThat(observed, after.rendered, "the app is no longer on screen");
    expectThat(observed, !isLink && !opened, "a file path was offered as a link");
    return observed;
  });

  await check("a Workspace-relative file link keeps the app on its page", async () => {
    const { document, reply } = await open(portableFsThreadPath, sourcesReplyText);
    await reply.getByText("Mount sequence", { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifactDirectory, "sources-reply.png") });
    const label = reply.getByText("portablefs-contract.md", { exact: true });
    const isLink = await label.evaluate((element) => element.closest("a") !== null);
    const before = requests.length;
    const opened = await clickWithoutOpening(page, label);
    const after = await documentState(page, document);
    const navigations = appNavigations(requests.slice(before));
    const observed = { after, isLink, navigations, opened };
    expectThat(observed, navigations.length === 0, "the click navigated the app's document");
    expectThat(observed, after.sameDocument, "the app document changed");
    expectThat(observed, after.path === portableFsThreadPath, "the app route changed");
    expectThat(observed, !isLink && !opened, "a file path was offered as a link");
    return observed;
  });

  const https = "https://portablefs.example/docs/mounts";
  const usePersonal = async () =>
    page.evaluate(() => {
      const snapshot = (Reflect.get(window, "opensteerMock") as MockHostClient).getSnapshot();
      const profile = snapshot.browserProfiles.find((item) => item.name === "Personal")!;
      localStorage.setItem(
        `opensteer.browse-with.v1:${encodeURIComponent(snapshot.deploymentId!)}:${encodeURIComponent(snapshot.user!.id)}`,
        JSON.stringify({ kind: "profile", profileId: profile.id }),
      );
      return profile.id;
    });

  for (const { name, label, expected, work, narrow } of [
    {
      name: "HTTPS from Talk",
      label: "PortableFS mount guide",
      expected: https,
      work: false,
      narrow: false,
    },
    {
      name: "HTTPS from Work uses the covered tab's profile",
      label: "PortableFS mount guide",
      expected: https,
      work: true,
      narrow: false,
    },
    {
      name: "HTTP from Talk",
      label: "old mirror",
      expected: "http://mirror.portablefs.example/docs",
      work: false,
      narrow: false,
    },
    {
      name: "phone-width HTTPS",
      label: "PortableFS mount guide",
      expected: https,
      work: false,
      narrow: true,
    },
    {
      name: "linked image",
      label: "Grant flow",
      expected: "https://portablefs.example/docs/grants",
      work: false,
      narrow: false,
    },
  ]) {
    await check(`${name} opens exactly one workspace tab at its exact URL`, async () => {
      await page.setViewportSize({ height: 900, width: narrow ? 390 : 1280 });
      const { document, reply } = await open(portableFsThreadPath, sourcesReplyText);
      let profileId = await usePersonal();
      let coveredKey: string | null = null;
      if (work) {
        const covered = (await mockTabs(page)).find(
          (tab) => tab.profileId && tab.profileId !== profileId,
        )!;
        expectThat({ covered }, !!covered, "the mock has no other profile tab to cover");
        profileId = covered.profileId!;
        coveredKey = `browser:${covered.sessionId}:${covered.id}`;
        await page.locator(`.side-tab[data-place-key="${coveredKey}"] .side-tab__main`).click();
      }
      const beforeTabs = await mockTabs(page);
      const before = requests.length;
      let devicePages = 0;
      const onPage = () => {
        devicePages += 1;
      };
      context.on("page", onPage);
      try {
        await reply.getByRole("link", { name: label, exact: true }).click();
        await page.waitForFunction(
          (url) => {
            const params = new URLSearchParams(location.search);
            const snapshot = (Reflect.get(window, "opensteerMock") as MockHostClient).getSnapshot();
            return snapshot.browserSessions.some(
              (session) =>
                session.id === params.get("browser") &&
                session.tabs.some((tab) => tab.id === params.get("browserTab") && tab.url === url),
            );
          },
          expected,
          { timeout: 5_000 },
        );
        await page.locator(".browser-stage").waitFor();
        if (narrow) await page.locator(".browser-page-name").click();
        await page.locator(".browser-address input").waitFor();
        await page.waitForTimeout(1_100);
        const tabs = await mockTabs(page);
        const added = tabs.filter((tab) => !beforeTabs.some((old) => old.id === tab.id));
        const after = await documentState(page, document);
        const navigations = appNavigations(requests.slice(before));
        const shown = await page.locator(".place").getAttribute("data-place-key");
        const conversation = narrow ? true : await reply.isVisible();
        const address = await page.locator(".browser-address input").inputValue();
        const observed = {
          added,
          after,
          address,
          conversation,
          coveredKey,
          devicePages,
          navigations,
          profileId,
          shown,
        };
        expectThat(
          observed,
          after.sameDocument &&
            after.path === portableFsThreadPath &&
            after.rendered &&
            navigations.length === 0,
          "the app document changed",
        );
        expectThat(observed, devicePages === 0, "a device browser page opened");
        expectThat(
          observed,
          added.length === 1 && added[0]?.url === expected && added[0]?.profileId === profileId,
          "the exact tab and default profile were not opened once",
        );
        expectThat(
          observed,
          shown === `browser:${added[0]!.sessionId}:${added[0]!.id}` &&
            address === expected &&
            conversation,
          "the tab or conversation is not shown",
        );
        await page.screenshot({
          path: path.join(
            artifactDirectory,
            `${narrow ? "narrow" : work ? "work" : label === "old mirror" ? "http" : "https"}-opened.png`,
          ),
        });
        await page.goBack();
        const back = await documentState(page, document);
        await page.goForward();
        await page.waitForTimeout(1_100);
        const forward = await documentState(page, document);
        const historyTabs = await mockTabs(page);
        const history = { back, forward, tabs: historyTabs };
        expectThat(
          { ...observed, history },
          back.sameDocument && forward.sameDocument,
          "Back/Forward left the app document",
        );
        expectThat(
          { ...observed, history },
          JSON.stringify(historyTabs) === JSON.stringify(tabs),
          "Back/Forward changed the workspace tabs",
        );
        await page.reload();
        await page.locator(".browser-stage, .start-page__input").waitFor();
        await page.waitForTimeout(1_100);
        const reloaded = await mockTabs(page);
        expectThat(
          { ...observed, reloaded },
          reloaded.every((tab) => tab.url !== expected),
          "reload replayed the arrival",
        );
        return {
          ...observed,
          history,
          backForwardCount: tabs.length,
          reloadedCount: reloaded.length,
        };
      } finally {
        context.off("page", onPage);
      }
    });
  }

  await page.setViewportSize({ height: 900, width: 1280 });
  for (const gesture of ["modifier", "middle"] as const) {
    await check(`${gesture} click opens a device page and no workspace tab`, async () => {
      const { document, reply } = await open(portableFsThreadPath, sourcesReplyText);
      const beforeTabs = await mockTabs(page);
      const before = requests.length;
      const opening = context.waitForEvent("page", { timeout: 5_000 }).catch(() => null);
      await reply
        .getByRole("link", { name: "PortableFS mount guide", exact: true })
        .click(gesture === "middle" ? { button: "middle" } : { modifiers: ["ControlOrMeta"] });
      const opened = await opening;
      const openedUrl = opened?.url() ?? null;
      await opened?.close();
      const after = await documentState(page, document);
      const tabs = await mockTabs(page);
      const navigations = appNavigations(requests.slice(before));
      const observed = { after, navigations, openedUrl, newTab: opened !== null, beforeTabs, tabs };
      expectThat(
        observed,
        after.sameDocument && navigations.length === 0,
        "the app document changed",
      );
      expectThat(observed, opened !== null, "no device browser page opened");
      expectThat(
        observed,
        JSON.stringify(tabs) === JSON.stringify(beforeTabs),
        "the gesture opened an Opensteer tab",
      );
      return observed;
    });
  }

  await check(
    "an ambiguous computer refusal keeps its address, consumes arrival across history and reload, then a chip completes it",
    async () => {
      const { reply } = await open(portableFsThreadPath, sourcesReplyText);
      await page.evaluate(() => localStorage.clear());
      const beforeTabs = await mockTabs(page);
      await reply.getByRole("link", { name: "PortableFS mount guide", exact: true }).click();
      await page
        .getByRole("alert")
        .filter({ hasText: "Which computer" })
        .waitFor({ timeout: 5_000 });
      const refusedAddress = await page.locator(".start-page__input").inputValue();
      const consumed = await page.evaluate(() => history.state.usr);
      const chips = await page.locator(".start-page__refusal-actions button").allTextContents();
      const refusalCount = (await mockTabs(page)).length;
      await page.locator(".side-task .side-task__main").first().click();
      await page.goBack();
      await page.locator(".start-page__input").waitFor();
      await page.goForward();
      await page.goBack();
      await page.reload();
      await page.locator(".start-page__input").waitFor();
      await page.waitForTimeout(1_100);
      const reloadAddress = await page.locator(".start-page__input").inputValue();
      const reloadedTabs = await mockTabs(page);
      const autoRefusal = await page.locator(".start-page__refusal").count();
      const observed = {
        refusedAddress,
        reloadAddress,
        consumed,
        chips,
        refusalCount,
        autoRefusal,
      };
      expectThat(
        observed,
        refusedAddress === https &&
          reloadAddress === https &&
          consumed.startOpen === false &&
          consumed.startAddress === https,
        "the address or consumed trigger was lost",
      );
      expectThat(
        observed,
        chips.length > 1 &&
          refusalCount === beforeTabs.length &&
          reloadedTabs.length === beforeTabs.length &&
          autoRefusal === 0,
        "history or reload reran the refused arrival",
      );
      await page.locator(".start-page__input").press("Enter");
      await page.locator(".start-page__refusal-actions button").first().click();
      await page.locator(".browser-address input").waitFor();
      const tabs = await mockTabs(page);
      expectThat(
        { ...observed, tabs },
        tabs.length === beforeTabs.length + 1 && tabs.some((tab) => tab.url === https),
        "an explicit computer choice did not complete the open",
      );
      await page.screenshot({ path: path.join(artifactDirectory, "computer-choice-opened.png") });
      return { ...observed, tabs };
    },
  );

  await check("a mail link stays a link the browser hands to its mail app", async () => {
    const { reply } = await open(portableFsThreadPath, sourcesReplyText);
    const link = reply.getByRole("link", { name: "storage@portablefs.example" });
    const observed = {
      href: await link.getAttribute("href"),
      target: await link.getAttribute("target"),
    };
    expectThat(
      observed,
      observed.href === "mailto:storage@portablefs.example" && observed.target === "_blank",
      "the mail link is not an outside link",
    );
    return observed;
  });

  await check("images an agent names are never fetched, and keep their words", async () => {
    const before = requests.length;
    const { reply } = await open(portableFsThreadPath, sourcesReplyText);
    const fetched = requests
      .slice(before)
      .filter(({ url }) => /mount-sequence|grant-flow/u.test(url));
    const observed = {
      fetched,
      images: await reply.locator("img").count(),
      nestedLinks: await reply.locator("a a").count(),
      text: await reply.innerText(),
    };
    expectThat(observed, fetched.length === 0, "an agent's image was fetched");
    expectThat(observed, observed.images === 0, "an agent's image was rendered");
    expectThat(observed, observed.nestedLinks === 0, "a linked image nests links");
    expectThat(observed, observed.text.includes("Mount sequence"), "an image lost its words");
    return observed;
  });
  await context.close();
} catch (error) {
  abort(error);
} finally {
  await web.close();
}

await finishJourney(artifactDirectory, checks);

/** Navigations of the app's own document: what replaced the app in the incident. */
function appNavigations(
  observed: readonly {
    readonly url: string;
    readonly navigation: boolean;
    readonly page: string;
  }[],
): string[] {
  return observed.filter(({ navigation, page }) => navigation && page === "app").map((r) => r.url);
}

/** Tags this document; a navigation replaces it, and the tag with it. */
async function markDocument(page: Page): Promise<string> {
  const id = randomUUID();
  await page.evaluate(({ key, value }) => Reflect.set(window, key, value), {
    key: documentKey,
    value: id,
  });
  return id;
}

async function documentState(page: Page, id: string) {
  await page.waitForLoadState("load");
  return page.evaluate(
    ({ key, expected }) => ({
      path: location.pathname,
      rendered: (document.getElementById("root")?.childElementCount ?? 0) > 0,
      sameDocument: Reflect.get(window, key) === expected,
    }),
    { expected: id, key: documentKey },
  );
}

/**
 * Clicks something that must open nothing. Playwright's click waits for any
 * navigation the click starts, so the document state read next is the state
 * the click left; a page opened by it arrives as a context event.
 */
async function clickWithoutOpening(page: Page, target: Locator): Promise<boolean> {
  let opened = false;
  const onPage = () => {
    opened = true;
  };
  page.context().on("page", onPage);
  try {
    await target.click();
    await page.waitForLoadState("load");
  } finally {
    page.context().off("page", onPage);
  }
  return opened;
}

async function mockTabs(page: Page) {
  return page.evaluate(() =>
    (Reflect.get(window, "opensteerMock") as MockHostClient)
      .getSnapshot()
      .browserSessions.flatMap((session) =>
        session.tabs.map((tab) => ({
          id: tab.id,
          sessionId: session.id,
          profileId: session.profileId,
          url: tab.url,
        })),
      ),
  );
}

function frameOf(request: Request): Frame | null {
  try {
    return request.frame();
  } catch {
    return null;
  }
}
