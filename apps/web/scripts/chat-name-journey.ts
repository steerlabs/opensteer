/**
 * Failure checklist: the reader's Chat goes by another name where it is a
 * place — the sidebar row and what it says aloud, Chat's header at desktop and
 * phone widths, the first-message screen, the conversation switcher and its
 * search, the button that shows a closed conversation, an automation's
 * conversation, a task's brief that came from Chat, Find in that task, the
 * quote action that opens Chat and the quote it lands, and the stop
 * confirmation that says who is told. The opposite failures count as much:
 * "Chat" spreads to what it does not name — Chat's own replies in Find,
 * another person's Chat, a task's or an automation's updates, a task's own
 * header — or the Opensteer orb leaves Chat's row, or "Opensteer" stops
 * naming the agent (the field that writes to it, the owner of the work it
 * hands out) or the product (the window title). Evidence is captured from the
 * production build.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MockHostClient } from "@opensteer/client/mock";
import type { Page } from "playwright-core";
import { expectThat, finishJourney, journeyChecks, openMockWeb } from "./mock-web-journey.js";

const directory = process.env.OPENSTEER_CHAT_NAME_EVIDENCE_DIR
  ? path.resolve(process.env.OPENSTEER_CHAT_NAME_EVIDENCE_DIR)
  : await mkdtemp(path.join(tmpdir(), "opensteer-chat-name-evidence-"));
const { checks, check, abort } = journeyChecks();
await mkdir(directory, { recursive: true });
const web = await openMockWeb("opensteer-chat-name");
const screenshots: string[] = [];
const capture = async (page: Page, name: string, selector?: string) => {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.querySelectorAll<HTMLImageElement>(".chat-orb img")].map((img) => img.decode()),
    );
  });
  const file = path.join(directory, `${name}.png`);
  if (selector) await page.locator(selector).screenshot({ path: file, animations: "disabled" });
  else await page.screenshot({ path: file, animations: "disabled" });
  screenshots.push(file);
};
const text = (page: Page, selector: string) =>
  page.evaluate(
    (query) => [...document.querySelectorAll(query)].map((node) => node.textContent?.trim() ?? ""),
    selector,
  );
/** Finds `query` in the open conversation and returns each result's author. */
const findAuthors = async (page: Page, query: string) => {
  await page.getByRole("button", { name: "Find in conversation" }).first().click();
  await page.getByPlaceholder("Find in conversation…").fill(query);
  await page.getByPlaceholder("Find in conversation…").press("Enter");
  await page.locator(".thread-find__result").first().waitFor();
  const authors = await text(page, ".thread-find__result-author");
  await page.keyboard.press("Escape");
  return authors;
};

try {
  const context = await web.browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route(
    (url) => url.origin !== web.origin,
    (route) => route.fulfill({ status: 204, body: "" }),
  );
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${web.origin}/`);
  await page.locator(".thread--home .conv-header__name").waitFor();

  await check("the sidebar's first row is Chat, beside the Opensteer orb", async () => {
    const observed = await page.evaluate(() => {
      const row = document.querySelector<HTMLElement>(".side-home__main")!;
      return {
        title: row.querySelector(".side-home__title")?.textContent,
        label: row.getAttribute("aria-label"),
        orb: row.querySelector<HTMLImageElement>(".chat-orb img")?.getAttribute("src") ?? null,
      };
    });
    await capture(page, "sidebar", ".sidebar");
    expectThat(observed, observed.title === "Chat", "the row is not called Chat");
    expectThat(
      observed,
      observed.label?.startsWith("Chat") === true,
      "the row is not read as Chat",
    );
    expectThat(observed, observed.orb === "/opensteer.png", "the Opensteer orb left the row");
    return observed;
  });

  await check("Chat's header says Chat; its field and its tasks are Opensteer's", async () => {
    const observed = {
      header: await text(page, ".thread--home .conv-header__name"),
      switcher: await page
        .locator(".thread--home .conv-header__switcher")
        .getAttribute("aria-label"),
      placeholder: await page
        .getByRole("textbox", { name: "Message", exact: true })
        .getAttribute("placeholder"),
      owners: [...new Set(await text(page, ".thread--home .task-bubble__byline"))],
      windowTitle: await page.title(),
    };
    await capture(page, "chat");
    expectThat(observed, observed.header[0] === "Chat", "Chat's header is not Chat");
    expectThat(
      observed,
      observed.switcher === "Chat. Switch conversation",
      "Chat's switcher is not read as Chat",
    );
    expectThat(
      observed,
      observed.placeholder === "Ask Opensteer…",
      "Chat no longer asks Opensteer",
    );
    expectThat(
      observed,
      observed.owners.length > 0 && observed.owners.every((name) => name === "Opensteer·"),
      "the tasks Chat handed out are not Opensteer's",
    );
    expectThat(observed, observed.windowTitle === "Opensteer", "the window lost the product name");
    return observed;
  });

  await check(
    "updates in Chat keep their senders' names; Find signs Chat's replies Opensteer",
    async () => {
      const sources = await text(page, ".thread--home .update-line__source");
      const found = await findAuthors(page, "tiger");
      const observed = { sources, found };
      expectThat(
        observed,
        sources.includes("Prepare the product launch") && sources.includes("Nightly typecheck"),
        "a task's or an automation's update lost its own name",
      );
      expectThat(
        observed,
        found.includes("Opensteer"),
        "Find does not sign Chat's reply Opensteer",
      );
      expectThat(observed, !found.includes("Chat"), "Find signs a message in Chat as Chat");
      return observed;
    },
  );

  await check(
    "a task handed out from Chat says it came from Chat, in place and in Find",
    async () => {
      await page.locator(".thread--home a.task-bubble").first().click();
      await page.locator(".msg--input__from").first().waitFor();
      const brief = (await text(page, ".msg--input__bubble"))[0] ?? "";
      const observed = {
        path: new URL(page.url()).pathname,
        header: await text(page, ".conv-header__name"),
        from: await text(page, ".msg--input__from"),
        fromHref: await page.locator(".msg--input__from").first().getAttribute("href"),
        ask: await text(page, ".msg--input__actions button"),
        found: await findAuthors(page, brief.split(/\s+/u).slice(0, 2).join(" ")),
      };
      await capture(page, "task-from-chat");
      expectThat(
        observed,
        observed.path.startsWith("/threads/"),
        "the bubble did not open the task",
      );
      expectThat(
        observed,
        observed.header[0] === "Book a table for Friday",
        "the task lost its own name",
      );
      expectThat(
        observed,
        observed.from[0]?.startsWith("Chat·") === true,
        "the brief does not say it came from Chat",
      );
      expectThat(observed, observed.fromHref === "/", "the brief does not lead back to Chat");
      expectThat(
        observed,
        observed.ask[0] === "Ask in Chat",
        "the quote action does not name Chat",
      );
      expectThat(
        observed,
        observed.found[0] === "Chat",
        "Find does not say the brief came from Chat",
      );
      return observed;
    },
  );

  await check("another person's Chat keeps the name the Host gives it", async () => {
    await page.evaluate(() => {
      const mock = Reflect.get(window, "opensteerMock") as MockHostClient;
      const threadId = decodeURIComponent(location.pathname.slice("/threads/".length));
      const main = mock.getSnapshot().workspaces.find(({ kind }) => kind === "main")!;
      // The Host's attribution for a teammate's Chat; the mock has no second person.
      mock.receiveAgentInput(
        threadId,
        {
          displayName: "Ana’s Opensteer",
          kind: "agent",
          runId: "run_00000000-0000-4000-8000-0000000000a1",
          threadId: "thr_00000000-0000-4000-8000-0000000000a1",
          workspaceId: main.id,
          workspaceName: main.name,
        },
        "Ana would like the same table for Saturday.",
      );
    });
    await page.getByText("Ana would like the same table for Saturday.").waitFor();
    const named = await text(page, ".msg--input__from, .update-line__source");
    const observed = { named };
    expectThat(
      observed,
      named.some((name) => name.includes("Ana’s Opensteer")),
      "another person's Chat lost the Host's name",
    );
    return observed;
  });

  await check(
    "the switcher lists and finds Chat, and stopping the task says Chat is told",
    async () => {
      await page.locator(".conv-header__switcher").first().click();
      await page.locator(".switcher__list").waitFor();
      const rows = await text(page, ".switcher__title");
      const homeLabel = await page
        .locator(".switcher__row")
        .evaluateAll((nodes) =>
          nodes
            .map((node) => node.getAttribute("aria-label"))
            .find((label) => label === "Chat" || label === "Opensteer"),
        );
      await capture(page, "switcher", ".popover--switcher");
      await page.getByRole("searchbox", { name: "Search tasks" }).fill("chat");
      const searched = await text(page, ".switcher__title");
      await page.getByRole("searchbox", { name: "Search tasks" }).fill("");
      await page.getByRole("button", { name: "Stop task…" }).click();
      const detail = await text(page, ".task-stop__detail");
      await capture(page, "stop-confirmation", ".popover--switcher");
      await page.getByRole("button", { name: "Keep working" }).click();
      await page.keyboard.press("Escape");
      const observed = { rows, homeLabel, searched, detail };
      expectThat(observed, rows.includes("Chat"), "the switcher does not list Chat");
      expectThat(
        observed,
        !rows.includes("Opensteer"),
        "the switcher lists a conversation as Opensteer",
      );
      expectThat(observed, homeLabel === "Chat", "the switcher reads Chat under another name");
      expectThat(observed, searched[0] === "Chat", "searching for Chat does not find it");
      expectThat(
        observed,
        detail[0]?.startsWith("It stops for good, and Chat is told.") === true,
        "the stop confirmation does not say Chat is told",
      );
      return observed;
    },
  );

  await check("asking in Chat about the brief lands a quote from Chat", async () => {
    await page.locator(".msg--input").first().hover();
    await page.locator(".msg--input__actions button").first().click();
    await page.locator(".composer-quote__attribution").waitFor();
    const observed = {
      path: new URL(page.url()).pathname,
      attribution: await text(page, ".composer-quote__attribution"),
    };
    await capture(page, "quote-in-chat");
    expectThat(observed, observed.path === "/", "the quote did not open Chat");
    expectThat(observed, observed.attribution[0] === "Chat", "the quote is not attributed to Chat");
    return observed;
  });

  await check("with a tab in the middle, the closed conversation is shown as Chat", async () => {
    await page.locator(".side-tab__main").first().click();
    await page.getByRole("button", { name: "Close conversation" }).click();
    const button = page.locator(".chat-btn");
    await button.waitFor();
    const observed = {
      label: await button.getAttribute("aria-label"),
      windowTitle: await page.title(),
    };
    await capture(page, "closed-conversation");
    await button.click();
    expectThat(
      observed,
      observed.label === "Show the conversation: Chat",
      "it is not shown as Chat",
    );
    expectThat(
      observed,
      observed.windowTitle.endsWith(" — Opensteer"),
      "the window lost the product name beside its tab",
    );
    return observed;
  });

  await check("automations that talk in Chat name Chat", async () => {
    await page.goto(`${web.origin}/automations`);
    await page.locator(".automation-row__where").first().waitFor();
    const where = await text(page, ".automation-row__where");
    await capture(page, "automations");
    const observed = { where };
    expectThat(observed, where.includes("Chat"), "no automation names Chat");
    expectThat(
      observed,
      !where.includes("Opensteer"),
      "an automation names its conversation Opensteer",
    );
    expectThat(
      observed,
      where.includes("Review PortableFS integration"),
      "an automation in a task lost the task's name",
    );
    return observed;
  });

  await check("at phone width Chat's header still says Chat", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${web.origin}/`);
    await page.locator(".conv-header .conv-header__name").first().waitFor();
    const observed = { header: await text(page, ".conv-header .conv-header__name") };
    await capture(page, "chat-phone");
    expectThat(observed, observed.header[0] === "Chat", "Chat's phone header is not Chat");
    return observed;
  });

  await check("no renderer errors", async () => {
    expectThat({ pageErrors }, pageErrors.length === 0, "renderer errors occurred");
    return { pageErrors };
  });
  await context.close();

  const fresh = await web.browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await fresh.route(
    (url) => url.origin !== web.origin,
    (route) => route.fulfill({ status: 204, body: "" }),
  );
  const first = await fresh.newPage();
  const firstErrors: string[] = [];
  first.on("pageerror", (error) => firstErrors.push(error.message));
  await first.goto(`${web.origin}/?mock-world=first-run`);
  await first.locator(".conv-header--area .conv-header__name").waitFor();
  await check("before the first message, the screen is Chat and asks Opensteer", async () => {
    const observed = {
      header: await text(first, ".conv-header--area .conv-header__name"),
      row: await text(first, ".side-home__title"),
      placeholder: await first
        .getByRole("textbox", { name: "Message", exact: true })
        .getAttribute("placeholder"),
      pageErrors: firstErrors,
    };
    await capture(first, "first-message");
    expectThat(observed, observed.header[0] === "Chat", "the first-message screen is not Chat");
    expectThat(
      observed,
      observed.row[0] === "Chat",
      "the sidebar row is not Chat before a message",
    );
    expectThat(observed, observed.placeholder === "Ask Opensteer…", "it no longer asks Opensteer");
    expectThat(observed, firstErrors.length === 0, "renderer errors occurred");
    return observed;
  });
  await fresh.close();
} catch (error) {
  abort(error);
} finally {
  await web.close();
}
await finishJourney(directory, checks, {
  artifactDirectory: directory,
  screenshots,
  command: "pnpm --filter @opensteer/web test:chat-name",
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
});
