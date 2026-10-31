import { mkdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { Locator } from "playwright-core";
import type { MockHostClient } from "@opensteer/client/mock";
import { expectThat, finishJourney, journeyChecks, openMockWeb } from "./mock-web-journey.js";

const artifactDirectory = path.resolve(
  process.env.OPENSTEER_OMNIBOX_EVIDENCE_DIR ?? path.join(tmpdir(), "opensteer-omnibox-evidence"),
);
await mkdir(artifactDirectory, { recursive: true });
const { checks, check: recordCheck, abort } = journeyChecks();
const check: typeof recordCheck = async (name, run) => {
  process.stdout.write(`Checking ${name}\n`);
  await recordCheck(name, run);
  const result = checks.at(-1)!;
  process.stdout.write(`${result.status}: ${result.error ?? name}\n`);
  if (result.status === "failed") throw new Error(result.error ?? name);
};
const web = await openMockWeb("opensteer-omnibox-web");
const context = await web.browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addInitScript("globalThis.__name = (value) => value;");
const page = await context.newPage();
const trace: Record<string, unknown>[] = [];
const field = () => page.getByRole("combobox", { name: "Search websites and apps" });
const address = () => page.getByRole("combobox", { name: "Search or enter address" });
const rows = () => page.getByRole("option");
const value = (input: Locator) =>
  input.evaluate((node: HTMLInputElement) => ({
    value: node.value,
    start: node.selectionStart,
    end: node.selectionEnd,
  }));
const shot = (name: string) => page.screenshot({ path: path.join(artifactDirectory, name) });
const launcher = async () => {
  await page.locator('.side-section--tabs [aria-label="New tab"]').click();
  await field().waitFor();
};
try {
  await page.goto(`${web.origin}/?panel=browser&mock-world=busy`);
  await field().waitFor();
  const profileName = await page.evaluate(
    () =>
      (Reflect.get(window, "opensteerMock") as MockHostClient).getSnapshot().browserProfiles[0]!
        .name,
  );
  await page.locator(".start-page__pill").click();
  await page.getByRole("menuitemradio").filter({ hasText: profileName }).click();
  await check("profile history starts fresh without importing local sites", async () => {
    await field().pressSequentially("gma");
    const text = await value(field());
    const historyRows = await page.locator("[data-history-url]").count();
    expectThat(
      { text, historyRows },
      text.value === "gma" && historyRows === 0,
      "unexpected imported history",
    );
    await field().fill("");
    return { text, historyRows };
  });
  await check(
    "provider suggestions in New tab; requests spaced and URL input excluded",
    async () => {
      await field().fill("weath");
      await rows().filter({ hasText: "weather tomorrow" }).waitFor();
      await shot("01-new-tab-suggestions.png");
      const labels = await rows().allTextContents();
      expectThat(
        { labels },
        labels.length <= 8 && labels[0]!.includes("weath"),
        "wrong default or row limit",
      );
      for (const query of ["weather", "weather ny", "weather nyc"]) {
        await field().fill(query);
        await page.waitForTimeout(40);
      }
      await page.waitForTimeout(160);
      await field().fill("gmail.com");
      await page.waitForTimeout(250);
      const requests = await page.evaluate(
        () => (Reflect.get(window, "opensteerMock") as MockHostClient).searchSuggestionRequests,
      );
      expectThat(
        { requests },
        requests.length >= 2 &&
          requests.every(
            (r, i) => r.query !== "gmail.com" && (i === 0 || r.at - requests[i - 1]!.at >= 100),
          ),
        "URL request or throttle violation",
      );
      return { labels, requests };
    },
  );
  await check(
    "typed URL history inline-completes in both inputs; Enter navigates once",
    async () => {
      await field().fill("gmail.com");
      await field().press("Enter");
      await address().waitFor();
      await page.waitForTimeout(1200);
      await launcher();
      await field().pressSequentially("gma");
      const completion = await value(field());
      expectThat(
        completion,
        completion.value === "gmail.com" && completion.start === 3 && completion.end === 9,
        "New tab has no selected completion",
      );
      await field().press("Enter");
      await address().waitFor();
      await address().fill("");
      await address().pressSequentially("gma");
      const toolbar = await value(address());
      expectThat(toolbar, toolbar.value === "gmail.com" && toolbar.start === 3, "toolbar differs");
      await shot("02-toolbar-inline.png");
      return { completion, toolbar };
    },
  );
  await check(
    "another browsing identity drops a completion from this profile's history",
    async () => {
      await launcher();
      await field().pressSequentially("gma");
      const before = await value(field());
      await page.locator(".start-page__pill").click();
      await page.getByRole("menuitemradio").filter({ hasText: "Guest" }).click();
      const after = await value(field());
      await page.locator(".start-page__pill").click();
      await page.getByRole("menuitemradio").filter({ hasText: profileName }).click();
      await field().fill("");
      await field().press("Escape");
      await address().waitFor();
      expectThat(
        { before, after },
        before.value === "gmail.com" && after.value === "gma",
        "Guest kept the profile's inline completion",
      );
      return { before, after };
    },
  );
  await check(
    "completion respects deletion, paste, IME, caret and Right/End acceptance",
    async () => {
      const observations: Record<string, unknown> = {};
      await address().fill("");
      await address().pressSequentially("gma");
      await address().press("ArrowDown");
      await address().press("Escape");
      observations.restoredPrefix = await value(address());
      expectThat(
        observations,
        (observations.restoredPrefix as { value: string }).value === "gma",
        "highlighting a completed URL lost raw typing",
      );
      for (const key of ["Backspace", "Delete"]) {
        await address().fill("");
        await address().pressSequentially("gma");
        await address().press(key);
        const observed = await value(address());
        observations[key] = observed;
        expectThat(observed, observed.value === "gma", `${key} deleted typed text or recompleted`);
      }
      for (const key of ["ArrowRight", "End"]) {
        await address().fill("");
        await address().pressSequentially("gma");
        await address().press(key);
        const observed = await value(address());
        observations[key] = observed;
        expectThat(
          observed,
          observed.value === "gmail.com" && observed.start === 9 && observed.end === 9,
          `${key} failed to accept`,
        );
      }
      await address().fill("");
      await address().evaluate((node: HTMLInputElement) => {
        node.dispatchEvent(new ClipboardEvent("paste", { bubbles: true }));
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        setter.call(node, "gma");
        node.dispatchEvent(
          new InputEvent("input", { bubbles: true, inputType: "insertFromPaste" }),
        );
      });
      observations.paste = await value(address());
      expectThat(
        observations,
        (observations.paste as { value: string }).value === "gma",
        "paste inline-completed",
      );
      await address().fill("");
      await address().dispatchEvent("compositionstart");
      await address().pressSequentially("gma");
      observations.ime = await value(address());
      expectThat(
        observations,
        (observations.ime as { value: string }).value === "gma",
        "IME inline-completed",
      );
      const urlBeforeImeEnter = page.url();
      await address().press("Enter");
      await page.waitForTimeout(250);
      observations.imeEnter = await value(address());
      expectThat(
        observations,
        page.url() === urlBeforeImeEnter &&
          (observations.imeEnter as { value: string }).value === "gma",
        "IME Enter submitted uncommitted text",
      );
      await address().dispatchEvent("compositionend", { data: "gma" });
      await address().fill("gma");
      await address().press("Home");
      await address().press("ArrowRight");
      await address().press("m");
      observations.caret = await value(address());
      expectThat(
        observations,
        (observations.caret as { value: string }).value === "gmma",
        "caret edit completed",
      );
      return observations;
    },
  );
  await check("a late provider answer cannot change a highlighted history action", async () => {
    await page.evaluate(async () => {
      const client = Reflect.get(window, "opensteerMock") as MockHostClient;
      const session = client
        .getSnapshot()
        .browserSessions.find(
          (session) => session.id === new URLSearchParams(location.search).get("browser"),
        )!;
      await client.openBrowserTab(
        { sessionId: session.id },
        { url: "https://slow.example.com/weather" },
      );
    });
    await launcher();
    await field().fill("slow weather");
    await field().press("ArrowDown");
    const before = await value(field());
    const action = await field().getAttribute("aria-activedescendant");
    expectThat(
      { before },
      before.value === "slow.example.com/weather",
      "history not selected before provider answer",
    );
    await page.waitForTimeout(650);
    const after = await value(field());
    const afterAction = await field().getAttribute("aria-activedescendant");
    expectThat(
      { before, after, action, afterAction },
      before.value === after.value && action === afterAction,
      "late provider replaced highlighted history action",
    );
    await field().press("Escape");
    await field().fill("gmail.com");
    await field().press("Enter");
    await address().waitFor();
    await page.waitForTimeout(1200);
    return { before, after, action, afterAction };
  });
  await check(
    "provider answers cannot replace a highlighted action; stale results are dropped",
    async () => {
      await address().fill("weath");
      await rows().filter({ hasText: "weather tomorrow" }).waitFor();
      await address().press("ArrowDown");
      const before = await value(address());
      await shot("05-toolbar-suggestions.png");
      await page.waitForTimeout(350);
      const after = await value(address());
      expectThat(
        { before, after },
        before.value === after.value && before.value !== "weath",
        "highlight changed",
      );
      await address().fill("slow weather");
      await page.waitForTimeout(130);
      await address().fill("fresh weather");
      await page.waitForTimeout(700);
      const labels = await rows().allTextContents();
      expectThat(
        { labels },
        labels.every((label) => !label.includes("slow weather")),
        "stale provider rows adopted",
      );
      return { before, after, labels };
    },
  );
  await check(
    "Escape restores typing, closes list, reverts/selects URL, then focuses page",
    async () => {
      await address().fill("weath");
      await rows().filter({ hasText: "weather tomorrow" }).waitFor();
      await address().press("ArrowDown");
      await address().press("Escape");
      const restored = await value(address());
      expectThat(restored, restored.value === "weath", "first Esc did not restore typing");
      await address().press("Escape");
      const closed = await rows().count();
      expectThat({ closed }, closed === 0, "second Esc left list open");
      await address().press("Escape");
      const reverted = await value(address());
      expectThat(
        reverted,
        reverted.value === "https://gmail.com/" &&
          reverted.start === 0 &&
          reverted.end === reverted.value.length,
        "third Esc did not revert/select",
      );
      await address().press("Escape");
      const focused = await address().evaluate(
        (node) => document.hasFocus() && document.activeElement === node,
      );
      expectThat({ focused }, !focused, "fourth Esc kept input focus");
      return { restored, closed, reverted, focused };
    },
  );
  await check(
    "host:port uses http and port is displayed; submitted text persists until commit",
    async () => {
      await page.evaluate(() => {
        const client = Reflect.get(window, "opensteerMock") as MockHostClient;
        const send = client.sendBrowserCommand.bind(client);
        let calls = 0;
        Reflect.set(window, "personNavigationCalls", () => calls);
        client.sendBrowserCommand = (sessionId, command) => {
          if (command.type !== "navigation.go") {
            send(sessionId, command);
            return;
          }
          calls++;
          setTimeout(() => send(sessionId, command), 150);
        };
      });
      await address().fill("localhost:3000");
      await address().press("Enter");
      const submitted = await address().inputValue();
      expectThat(
        { submitted },
        submitted === "localhost:3000",
        "submitted text reverted before commit",
      );
      await page.waitForTimeout(1200);
      const committed = await address().inputValue();
      expectThat({ committed }, committed === "http://localhost:3000/", "wrong scheme");
      await page.locator(".browser-address__host").filter({ hasText: "localhost:3000" }).waitFor();
      await shot("03-port.png");
      await address().click();
      const firstAfterEnter = await value(address());
      expectThat(
        firstAfterEnter,
        firstAfterEnter.start === 0 && firstAfterEnter.end === firstAfterEnter.value.length,
        "click after Enter did not select all",
      );
      await address().fill("localhost:3000");
      await address().press("Enter");
      await page.waitForTimeout(1200);
      const sameUrl = await address().inputValue();
      const calls = await page.evaluate(() =>
        (Reflect.get(window, "personNavigationCalls") as () => number)(),
      );
      expectThat(
        { sameUrl, calls },
        sameUrl === "http://localhost:3000/" && calls === 2,
        "same-URL submission failed or Enter fired twice",
      );
      return { submitted, committed, firstAfterEnter, sameUrl, calls };
    },
  );
  await check("resubmitting the loading address settles once the load ends", async () => {
    await address().fill("localhost:3000");
    await address().press("Enter");
    await page.locator('[aria-label="Stop loading"]').waitFor();
    await address().fill("localhost:3000");
    await address().press("Enter");
    await page.locator('[aria-label="Reload page"]').waitFor();
    await page.waitForTimeout(300);
    const settled = await address().inputValue();
    const dressed = await page
      .locator(".browser-address__host")
      .filter({ hasText: "localhost:3000" })
      .count();
    expectThat(
      { settled, dressed },
      settled === "http://localhost:3000/" && dressed === 1,
      "the submitted text stayed after the load ended",
    );
    return { settled, dressed };
  });
  await check("Stop from the keyboard preserves a page already committed by the mock", async () => {
    const history = () =>
      page.evaluate(async () => {
        const client = Reflect.get(window, "opensteerMock") as MockHostClient;
        const params = new URLSearchParams(location.search);
        const session = client
          .getSnapshot()
          .browserSessions.find((session) => session.id === params.get("browser"))!;
        await client.browserHistory.load(session.profileId!);
        return client.browserHistory.entries(session.profileId!).map((entry) => entry.url);
      });
    await address().fill("stopped.example.com");
    await address().press("Enter");
    await page.locator('[aria-label="Stop loading"]').waitFor();
    await page.locator("[data-live-page]").focus();
    await page.keyboard.press("Escape");
    await page.locator('[aria-label="Reload page"]').waitFor();
    await page.waitForTimeout(300);
    const urls = await history();
    expectThat(
      { urls },
      urls.some((url) => url.includes("stopped.example.com")),
      "the mock lost a committed visit",
    );
    return { urls };
  });
  await check(
    "unfocused click selects all; focused click caret; drag partial; double/triple click native",
    async () => {
      await page.locator("[data-live-page]").click({ position: { x: 100, y: 100 } });
      await address().click();
      const first = await value(address());
      expectThat(
        first,
        first.start === 0 && first.end === first.value.length,
        "first click did not select all",
      );
      await address().click();
      const second = await value(address());
      expectThat(second, second.start === second.end, "focused click did not place caret");
      await address().dblclick();
      const word = await value(address());
      expectThat(
        word,
        word.end! > word.start! && word.end! - word.start! < word.value.length,
        "double click failed",
      );
      await address().click({ clickCount: 3 });
      const triple = await value(address());
      expectThat(
        triple,
        triple.start === 0 && triple.end === triple.value.length,
        "triple click failed",
      );
      await page.locator("[data-live-page]").click({ position: { x: 100, y: 100 } });
      const box = (await address().boundingBox())!;
      await page.mouse.move(box.x + 8, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 90, box.y + box.height / 2, { steps: 12 });
      await page.mouse.up();
      const drag = await value(address());
      expectThat(
        drag,
        drag.end! > drag.start! && drag.end! - drag.start! < drag.value.length,
        "drag did not preserve partial selection",
      );
      return { first, second, word, triple, drag };
    },
  );
  await check(
    "open tab never steals Enter; arrow fills switch row; equivalent navigate action stays",
    async () => {
      await address().fill("notion");
      const labels = await rows().allTextContents();
      expectThat({ labels }, labels[0]!.includes("Search the web"), "open tab stole default");
      const switchRow = rows()
        .filter({ hasText: "Switch to tab" })
        .filter({ hasText: "notion.so" });
      await switchRow.waitFor();
      await address().press("Enter");
      await page.waitForTimeout(1200);
      const searched = await address().inputValue();
      expectThat(
        { searched },
        searched === "https://www.google.com/search?q=notion",
        "Enter didn't search",
      );
      await address().fill("notion");
      await address().press("ArrowDown");
      const filled = await value(address());
      expectThat(filled, filled.value !== "notion", "arrow didn't fill tab URL");
      await address().press("Enter");
      await page.waitForTimeout(300);
      const switched = await address().inputValue();
      expectThat({ switched }, switched.includes("notion.so"), "didn't switch");
      await address().fill("https://www.notion.so");
      const same = await rows().allTextContents();
      expectThat(
        { same },
        same.some((label) => label.includes("Go to site")) &&
          same.some((label) => label.includes("Switch to tab")),
        "same-URL actions were deduped",
      );
      return { labels, searched, filled, switched, same };
    },
  );
  await check("Shift+Delete removes a history row", async () => {
    await launcher();
    await page.locator(".start-page__pill").click();
    await page.getByRole("menuitemradio").filter({ hasText: profileName }).click();
    await field().fill("history-delete.example.com/journey");
    await field().press("Enter");
    await address().waitFor();
    await page.waitForTimeout(1200);
    await address().fill("history-delete");
    const history = page.locator('[role="option"][data-history-url]');
    await history.waitFor();
    for (
      let attempt = 0;
      attempt < 8 &&
      (await address().getAttribute("aria-activedescendant")) !==
        (await history.getAttribute("id"));
      attempt++
    )
      await address().press("ArrowDown");
    await address().press("Shift+Delete");
    const remaining = await history.count();
    expectThat({ remaining }, remaining === 0, "history row survived");
    return { remaining };
  });
  await check(
    "Host history records full committed URLs and typed intent; Guest keeps none",
    async () => {
      await address().fill("person-history.example.com/path?q=1#hash");
      await address().press("Enter");
      await page.waitForTimeout(1200);
      await address().fill("");
      await address().pressSequentially("person-hist");
      const toolbarHistory = await value(address());
      expectThat(
        toolbarHistory,
        toolbarHistory.value === "person-history.example.com/path?q=1#hash" &&
          toolbarHistory.start === 11,
        "toolbar did not refresh history after its own navigation",
      );
      const person = await page.evaluate(async () => {
        const client = Reflect.get(window, "opensteerMock") as MockHostClient;
        const snapshot = client.getSnapshot();
        const params = new URLSearchParams(location.search);
        const session = snapshot.browserSessions.find(
          (session) => session.id === params.get("browser"),
        )!;
        const tab = session.tabs.find((tab) => tab.id === params.get("browserTab"))!;
        const identity = { kind: "profile", profileId: session.profileId! } as const;
        await client.browserHistory.load(identity.profileId);
        const entry = client.browserHistory
          .entries(identity.profileId)
          .find((entry) => entry.url === "https://person-history.example.com/path?q=1#hash")!;
        Reflect.set(window, "historyIdentity", identity);
        const before = JSON.stringify(client.browserHistory.entries(identity.profileId));
        client.sendBrowserCommand(session.id, {
          type: "navigation.go",
          surfaceId: tab.id,
          url: "https://agent-history.example.com/private",
        });
        return { entry, title: tab.title, before };
      });
      await page.waitForTimeout(1200);
      const afterNavigation = await page.evaluate(async () => {
        const client = Reflect.get(window, "opensteerMock") as MockHostClient;
        const identity = Reflect.get(window, "historyIdentity") as {
          kind: "profile";
          profileId: string;
        };
        await client.browserHistory.load(identity.profileId);
        return client.browserHistory.entries(identity.profileId);
      });
      expectThat(
        { person, afterNavigation },
        person.entry.title === person.title &&
          person.entry.typedCount > 0 &&
          person.entry.visitCount > 0 &&
          afterNavigation.some(
            (entry) =>
              entry.url === "https://agent-history.example.com/private" && entry.typedCount === 0,
          ),
        "consumer navigation lost committed history or typed metadata",
      );
      await launcher();
      await page.locator(".start-page__pill").click();
      await page.getByRole("menuitemradio").filter({ hasText: "Guest" }).click();
      await field().fill("guest-history.example.com");
      await field().press("Enter");
      const computer = page.locator(".start-page__refusal-actions button").first();
      await computer.waitFor();
      await computer.click();
      await address().waitFor();
      await page.waitForTimeout(1200);
      const guest = await page.evaluate(
        () =>
          (Reflect.get(window, "opensteerMock") as MockHostClient).browserHistory.entries(null)
            .length,
      );
      expectThat({ guest }, guest === 0, "Guest recorded history");
      return { person, afterNavigation, guest };
    },
  );
  await check("URL classification and scheme choice agree at the address field", async () => {
    const cases: [string, string][] = [
      ["localhost", "http://localhost/"],
      ["localhost:3000", "http://localhost:3000/"],
      ["intranet:8080/path", "http://intranet:8080/path"],
      ["127.0.0.1", "http://127.0.0.1/"],
      ["[::1]:3000", "http://[::1]:3000/"],
      ["::1", "http://[::1]/"],
      ["example.com", "https://example.com/"],
      ["https://example.com:8443/a", "https://example.com:8443/a"],
      ["barewords", "https://www.google.com/search?q=barewords"],
      ["weather", "https://www.google.com/search?q=weather"],
      ["example.unknowntld", "https://www.google.com/search?q=example.unknowntld"],
    ];
    const observed = [];
    for (const [typed, expected] of cases) {
      await address().fill(typed);
      await address().press("Enter");
      await page.waitForFunction(
        (expected) =>
          document.querySelector<HTMLInputElement>('[aria-label="Search or enter address"]')
            ?.value === expected && !document.querySelector('[aria-label="Stop loading"]'),
        expected,
      );
      const actual = await address().inputValue();
      observed.push({ typed, expected, actual });
      expectThat({ typed, expected, actual }, actual === expected, "classification differed");
    }
    return { cases: observed };
  });
  await check(
    "clearing profile history removes tiles, matches and inline completion immediately",
    async () => {
      await launcher();
      await page.locator(".start-page__pill").click();
      await page.getByRole("menuitemradio").filter({ hasText: profileName }).click();
      const tiles = page.locator(".start-page__recents .start-tile");
      await tiles.first().waitFor();
      const before = await tiles.count();
      expectThat({ before }, before > 0 && before <= 12, "missing recent-origin tiles or too many");
      await tiles.first().click({ button: "right" });
      await page.getByRole("menuitem", { name: /Clear browsing history/ }).click();
      await field().pressSequentially("person-history");
      const text = await value(field());
      const historyRows = await page.locator("[data-history-url]").count();
      expectThat(
        { text, historyRows },
        text.value === "person-history" && historyRows === 0,
        "clear retained cached history",
      );
      await field().fill("");
      const after = await tiles.count();
      expectThat({ after }, after === 0, "clear retained tiles");
      return { before, after, text, historyRows };
    },
  );
  await check("setting off and old Host make no request", async () => {
    await page.goto(`${web.origin}/settings/general`);
    const setting = page.getByRole("switch", { name: "Show search suggestions" });
    await setting.waitFor();
    await setting.click();
    await shot("04-suggestions-off.png");
    await page.goto(`${web.origin}/?panel=browser&mock-world=busy`);
    await field().waitFor();
    const before = await page.evaluate(
      () =>
        (Reflect.get(window, "opensteerMock") as MockHostClient).searchSuggestionRequests.length,
    );
    await field().fill("weather forecast");
    await page.waitForTimeout(400);
    const after = await page.evaluate(
      () =>
        (Reflect.get(window, "opensteerMock") as MockHostClient).searchSuggestionRequests.length,
    );
    expectThat({ before, after }, before === after, "setting off still requested");
    await page.evaluate(() => {
      const client = Reflect.get(window, "opensteerMock") as MockHostClient;
      client.browserPreferences.showSearchSuggestions = true;
      client.setSearchSuggestionsAvailable(false);
    });
    await field().fill("weath");
    await page.waitForTimeout(400);
    const oldHost = await page.evaluate(
      () =>
        (Reflect.get(window, "opensteerMock") as MockHostClient).searchSuggestionRequests.length,
    );
    expectThat({ oldHost, after }, oldHost === after, "old Host received request");
    return { before, after, oldHost };
  });
  trace.push(...checks.map((item) => ({ name: item.name, ...item.observed })));
} catch (error) {
  abort(error);
} finally {
  await context.close();
  await web.close();
  await finishJourney(artifactDirectory, checks, { trace });
}
