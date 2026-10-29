/**
 * Failure modes / acceptance assertions, written before the one-control rewrite:
 *
 * 1. The primary control loses the engine/model/options accessible name, duplicates
 *    settings controls, or leaves a removed Model options pill behind.
 * 2. Account/access folding breaks its declared order, leaves a glyph beside
 *    another settings control, wraps a footer control away from Send, clips a
 *    model below 72px, or clips Home's complete placeholder at 320/360.
 * 3. Browsing an engine/account commits early; choosing a model fails to commit
 *    its exact route atomically or restore account+model options and fallbacks.
 * 4. Search merges routes, loses descriptions/checks, or Recent loses ordering.
 * 5. Current settings describe the browsed route instead of the committed route,
 *    cannot be read/changed at 320, or disappear after a committed change.
 * 6. Select/access drill-ins lose checked focus; Escape/back fail to restore the
 *    row, a second Escape fails to close/restore primary focus, or choosing a
 *    value fails to apply and close. A toggle closes the menu or loses its state.
 * 7. Draft changes look applied but the mock Host preferences or sent Thread
 *    retain a different account/model/reasoning/speed/access selection.
 * 8. Unsupported access silently changes, permits send, loses its reason or
 *    disabled choices, or cannot be resolved through the primary menu.
 * 9. Unavailable accounts lose their reason/fix action or permit selection.
 * 10. Thread review commits before confirmation, preselects access, loses its
 *     session/messages/draft on cancel, or fails to apply the reviewed change.
 * 11. Fixture injection changes unrelated catalogs; setup, cleanup or PNGs fail
 *     without nonzero status and repeatable journey.json/source evidence.
 */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MockHostClient } from "@opensteer/client/mock";
import type { Locator, Page } from "playwright-core";
import { finishJourney, type CheckRecord, type MockWeb, openMockWeb } from "./mock-web-journey.js";

const assertionPlan = {
  "initial-draft": [
    "composer controls share the trailing action line",
    "no glyph-only setting beside another setting",
    "removed options pill and default access pill are absent",
    "Home placeholder is complete at 320 and 360",
    "primary accessible name includes the complete summary",
    "stored choices retain their exact names",
    "desktop primary labels unfold; optional pills fold only when needed",
    "folded parts precede or share the stage of unfolded parts",
    "visible pills stay inside composer",
    "visible cut labels are at least 72px",
    "folded account remains reachable and checked in engine menu",
  ],
  "initial-home": [
    "composer controls share the trailing action line",
    "no glyph-only setting beside another setting",
    "removed options pill and default access pill are absent",
    "Home placeholder is complete at 320 and 360",
    "primary accessible name includes the complete summary",
    "stored choices retain their exact names",
    "desktop primary labels unfold; optional pills fold only when needed",
    "folded parts precede or share the stage of unfolded parts",
    "visible pills stay inside composer",
    "visible cut labels are at least 72px",
    "folded account remains reachable and checked in engine menu",
  ],
  "browse-engine": [
    "named dialog and search",
    "five engine tabs with readiness",
    "browsing engine leaves choice unchanged",
    "single available account has no accounts group",
    "menu fits viewport",
  ],
  "browse-account": [
    "three Codex accounts",
    "checked account and model",
    "browsing account leaves choice unchanged",
    "browsed model is not checked",
  ],
  "commit-account": [
    "model commits engine account and model",
    "reasoning carries to the new account",
  ],
  "remember-options": [
    "changed options are shown",
    "another engine commits only on model selection",
    "single-account engine hides account pill",
    "valid reasoning carries across engines",
  ],
  "restore-options": [
    "returning restores account and model",
    "remembered options win over carried options",
  ],
  "account-keep": ["account menu lists three accounts", "offered model survives account switch"],
  "account-default": [
    "missing model falls back to account default",
    "models without options have no summary or option rows",
  ],
  "account-remembered": [
    "missing model falls back to remembered account model",
    "remembered model is checked",
  ],
  "search-routes": [
    "same model has separate routes",
    "each route describes engine and account",
    "only current route is checked",
    "search menu fits viewport",
  ],
  "search-account": ["account word narrows search", "search result commits exact route"],
  recent: [
    "Recent tab exists",
    "last complete choices appear newest first",
    "recent keeps duplicate models on distinct routes",
  ],
  "options-default": [
    "default speed is hidden",
    "Reasoning and Speed rows exist",
    "default values are checked",
  ],
  "options-fast": [
    "Fast appears in summary",
    "Fast is checked on reopen",
    "returning to default hides speed",
  ],
  "draft-conflict": [
    "nonempty draft initially permits send",
    "unsupported access remains named unavailable",
    "send is disabled with the conflict reason",
    "all four access modes remain listed",
    "unsupported mode is aria-disabled with reason",
  ],
  "draft-resolved": [
    "supported mode resolves conflict",
    "nonempty send becomes enabled",
    "draft text is preserved",
  ],
  "unavailable-auth": [
    "fixture changes only targeted catalog",
    "unavailable account retains reason",
    "unavailable account offers fix button",
    "browsing unavailable account cannot commit",
  ],
  "unavailable-location": [
    "missing Cursor account retains install reason",
    "missing CLI has no selectable models",
    "selected choice is preserved",
  ],
  "review-open": [
    "existing session opens Review this change",
    "Keep and Use actions exist",
    "supported access radios are offered",
    "unsupported Auto radio is absent",
    "no access mode is chosen for the reader",
    "choice and session stay unchanged before confirmation",
    "review fits viewport",
  ],
  "review-cancel": ["Keep closes review", "cancel preserves choice session and draft"],
  "review-confirm": [
    "Use commits engine and chosen access",
    "new engine gets a new session",
    "existing messages and draft survive",
  ],
  "menu-settings-home": [
    "menu reads current account reasoning speed and access",
    "account browsing preserves the choice until a model is picked",
    "reopened account and model are checked",
    "changed setting rows and checked values survive reopening",
    "changed composer stays on one line without adjacent glyph settings",
  ],
  "menu-settings-draft": [
    "menu reads current account reasoning speed and access",
    "account browsing preserves the choice until a model is picked",
    "reopened account and model are checked",
    "changed setting rows and checked values survive reopening",
    "changed composer stays on one line without adjacent glyph settings",
    "mock Host stores the sent account model options and access",
  ],
  "drill-in-keyboard": [
    "each drill-in focuses its checked choice",
    "Escape returns to the setting row without closing",
    "second Escape returns to the primary control",
    "Back returns to the setting row without closing",
    "choosing a value applies it and closes the picker",
  ],
  "toggle-option": [
    "toggle reads its current value",
    "toggling applies without closing the picker",
    "toggle value survives reopening",
  ],
  "saved-option": [
    "a saved level the engine dropped reads as saved, not as the default",
    "its choices check none and say why",
    "choosing a listed level replaces it",
  ],
  "keyboard-engine": [
    "arrow keys move focus inside picker",
    "Escape closes picker",
    "focus returns to primary control",
  ],
  "keyboard-account": [
    "browsing an account keeps focus on its row",
    "arrow keys move among menu items",
    "Escape closes menu",
    "focus returns to primary control",
    "keyboard account selection commits the intended route",
  ],
  "keyboard-options": [
    "arrow keys move among menu items",
    "Escape closes menu",
    "focus returns to primary control",
  ],
  "keyboard-access": [
    "arrow keys move among menu items",
    "Escape closes menu",
    "focus returns to primary control",
  ],
} as const;
type StepId = keyof typeof assertionPlan;
type Verify = (name: string, passed: boolean, observed?: Record<string, unknown>) => void;
interface StepRecord {
  id: string;
  viewport: { width: number; height: number };
  screenshot: string;
  assertions: CheckRecord[];
  diagnostics: Record<string, unknown>;
}
const viewports = [
  { width: 1280, height: 800 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
  { width: 360, height: 780 },
  { width: 320, height: 740 },
];
const evidenceDirectory = path.resolve(
  process.env.OPENSTEER_MODEL_PICKER_EVIDENCE_DIR ?? path.join(tmpdir(), "opensteer-model-picker"),
);
const checkout = await realpath(path.resolve(import.meta.dirname, "../../.."));
await mkdir(evidenceDirectory, { recursive: true });
const evidenceRealPath = await realpath(evidenceDirectory);
if (evidenceRealPath === checkout || evidenceRealPath.startsWith(`${checkout}${path.sep}`))
  throw new Error("Model picker evidence must be outside the checkout.");
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: checkout,
  encoding: "utf8",
}).trim();
const sourceStatus = execFileSync("git", ["status", "--short"], {
  cwd: checkout,
  encoding: "utf8",
});
await writeFile(
  path.join(evidenceDirectory, "source.diff"),
  execFileSync("git", ["diff", "--binary", "HEAD"], {
    cwd: checkout,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  }),
);
await writeFile(
  path.join(evidenceDirectory, "model-picker-journey.ts"),
  await readFile(import.meta.filename),
);
const startedAt = new Date().toISOString();
const checks: CheckRecord[] = [];
const steps: StepRecord[] = [];
const enginePill = (page: Page) =>
  page.getByRole("button", { name: /^Engine and model:|^Choose AI$/ });
const accountPill = (page: Page, includeHidden = false) =>
  page.getByRole("button", { name: /^Account:/, includeHidden });
const removedOptionsPill = (page: Page) => page.getByRole("button", { name: /^Model options:/ });
const accessPill = (page: Page, includeHidden = false) =>
  page.getByRole("button", { name: /^Access mode:/, includeHidden });
const picker = (page: Page) =>
  page.getByRole("dialog", { name: "Choose an engine and model", exact: true });
const row = (scope: Page | Locator, name: string) =>
  scope.getByRole("menuitemradio", { name, exact: true });
const codexName = "Engine and model: Codex · GPT-5.6-Sol";
const demo = "demo@opensteer.test";
const alex = "alex@opensteer.test";
const sol = "GPT-5.6-Sol";
const terra = "GPT-5.6-Terra";
let web: MockWeb | undefined;

async function writeEvidence() {
  await writeFile(
    path.join(evidenceDirectory, "journey.json"),
    `${JSON.stringify(
      {
        command: "pnpm --filter @opensteer/web test:model-picker",
        sourceSha,
        sourceStatus,
        sourcePatch: "source.diff",
        journeySource: "model-picker-journey.ts",
        processId: process.pid,
        startedAt,
        finishedAt: new Date().toISOString(),
        browserExecutable: process.env.OPENSTEER_CHROMIUM_EXECUTABLE ?? "Playwright Chromium",
        viewports,
        selectedAssertions: assertionPlan,
        steps,
        checks,
        passed: checks.length > 0 && checks.every((check) => check.status === "passed"),
      },
      null,
      2,
    )}\n`,
  );
}

async function names(locator: Locator) {
  return locator.evaluateAll((elements) =>
    elements.map(
      (element) => element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "",
    ),
  );
}
async function rowDescriptions(locator: Locator) {
  return locator.evaluateAll((elements) =>
    elements.map((element) =>
      (element.getAttribute("aria-describedby") ?? "")
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" "),
    ),
  );
}

/** Search commits on React's deferred render; wait for its observable row count. */
async function waitForCount(locator: Locator, expected: number) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if ((await locator.count()) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Expected ${expected} named rows, observed ${await locator.count()}`);
}

/** Read the summary from the primary name even when its visual words fold. */
async function summary(page: Page) {
  const primary = (await names(enginePill(page)))[0] ?? "";
  return primary.split(" · ").slice(2).join(" · ");
}
async function choice(page: Page, includeHiddenAccounts = true) {
  const primary = await names(enginePill(page));
  const value = await summary(page);
  return {
    engine: primary.map((name) => name.split(" · ").slice(0, 2).join(" · ")),
    account: await names(accountPill(page, includeHiddenAccounts)),
    options: value ? [`Options: ${value}`] : [],
    access: await names(accessPill(page, true)),
  };
}
const settingsStrip = (page: Page) =>
  picker(page).getByRole("group", { name: /^Current · |^Settings$/ });
async function openSetting(page: Page, title: string) {
  await enginePill(page).click();
  const setting = settingsStrip(page).getByRole("button", { name: new RegExp(`^${title}:`) });
  await setting.click();
  const menu = picker(page).getByRole("menu", { name: title, exact: true });
  await menu.waitFor();
  return { menu, setting };
}
/** The same accounts have two entry points; folding only changes which one can be pressed. */
async function openAccountMenu(page: Page, engine: string, forceEngine = false) {
  const storedPill = accountPill(page, true);
  await waitForCount(storedPill, 1);
  const folded = (await storedPill.getAttribute("data-folded")) !== null;
  if (folded && (await storedPill.isVisible()))
    throw new Error("A folded account pill is still visible");
  const viaEngine = forceEngine || folded;
  const anchor = viaEngine ? enginePill(page) : accountPill(page);
  await anchor.click();
  const menu = viaEngine
    ? picker(page)
    : page.getByRole("menu", { name: `${engine} accounts`, exact: true });
  await menu.waitFor();
  if (viaEngine) await menu.getByRole("tab", { name: engine, exact: true }).click();
  const group = menu.getByRole("group", { name: `${engine} accounts`, exact: true });
  await group.waitFor();
  return { anchor, menu, group, folded, path: viaEngine ? "engine-menu" : "account-pill" };
}

async function checkedAccount(page: Page, engine: string, forceEngine = false) {
  const entry = await openAccountMenu(page, engine, forceEngine);
  try {
    const accounts = await names(entry.group.getByRole("menuitemradio"));
    const checked = await names(entry.group.getByRole("menuitemradio", { checked: true }));
    return {
      accounts,
      checked,
      folded: entry.folded,
      path: entry.path,
      menu: await entry.group.ariaSnapshot(),
    };
  } finally {
    await page.keyboard.press("Escape");
    await entry.menu.waitFor({ state: "hidden" });
  }
}

/** The checked account is evidence of the route, including when its pill folds. */
async function committedChoice(page: Page, engine: string) {
  const current = await choice(page);
  const proof = await checkedAccount(page, engine, true);
  if (proof.checked.length !== 1)
    throw new Error(`Expected exactly one checked account: ${JSON.stringify(proof)}`);
  return { ...current, account: [`Account: ${proof.checked[0]}`], accountProof: proof };
}

async function selectAccount(
  page: Page,
  entry: Awaited<ReturnType<typeof openAccountMenu>>,
  account: string,
  model: string,
) {
  const before = await choice(page);
  await row(entry.group, account).click();
  if (entry.path === "engine-menu") {
    const afterBrowse = await choice(page);
    if (JSON.stringify(afterBrowse) !== JSON.stringify(before))
      throw new Error(
        `Browsing an account committed a choice: ${JSON.stringify({ before, afterBrowse })}`,
      );
    await row(entry.menu, model).click();
  }
  await entry.menu.waitFor({ state: "hidden" });
  return { path: entry.path, account, model };
}

async function choose(page: Page, engine: string, model: string, account?: string) {
  await enginePill(page).click();
  const dialog = picker(page);
  await dialog.getByRole("tab", { name: engine, exact: true }).click();
  if (account)
    await row(
      dialog.getByRole("group", { name: `${engine} accounts`, exact: true }),
      account,
    ).click();
  await row(dialog, model).click();
  await dialog.waitFor({ state: "hidden" });
}
async function option(page: Page, title: string, value: string) {
  const { menu } = await openSetting(page, title);
  await menu.getByRole("menuitemradio", { name: new RegExp(`^${value}(?:\\s|$)`) }).click();
  await picker(page).waitFor({ state: "hidden" });
}
async function access(page: Page, value: string) {
  await option(page, "Access", value);
  if (value === "Full access") await waitForCount(accessPill(page, true), 0);
  else
    await page
      .getByRole("button", { name: `Access mode: ${value}`, exact: true, includeHidden: true })
      .waitFor({ state: "attached" });
}
async function fitsViewport(locator: Locator, page: Page) {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize()!;
  return {
    box,
    viewport,
    fits:
      box !== null &&
      box.x >= 0 &&
      box.y >= 0 &&
      box.x + box.width <= viewport.width &&
      box.y + box.height <= viewport.height,
  };
}

/** Named controls supply the roots; data-fold is observed only to check the folding contract. */
async function composerGeometry(page: Page) {
  const field = await page.getByRole("textbox", { name: "Message", exact: true }).elementHandle();
  const pills = await Promise.all(
    [enginePill(page), accountPill(page, true), accessPill(page, true)].map(async (pill) =>
      (await pill.count()) ? pill.elementHandle() : null,
    ),
  );
  return page.evaluate(
    ({ field, pills }) => {
      if (!field || !pills[0]) throw new Error("Missing named field or stored-choice pill");
      let composer = field.parentElement;
      while (
        composer &&
        (getComputedStyle(composer).display === "contents" ||
          !pills.every((pill) => !pill || composer?.contains(pill)))
      )
        composer = composer.parentElement;
      if (!composer || composer === document.body)
        throw new Error("Pills have no composer ancestor");
      const bounds = composer.getBoundingClientRect();
      const epsilon = 1 / 64; // Chromium's layout unit.
      const parts: {
        name: string | null;
        stage: number;
        expectedStage: number;
        folded: boolean;
        visible: boolean;
        text: string;
      }[] = [];
      const labels: { name: string | null; text: string; width: number; cut: boolean }[] = [];
      const measurements = pills
        .filter((pill) => pill !== null)
        .map((pill) => {
          if (!pill) throw new Error("Missing pill");
          const name = pill.getAttribute("aria-label");
          const box = pill.getBoundingClientRect();
          const visible =
            pill.getClientRects().length > 0 &&
            box.width > 0 &&
            box.height > 0 &&
            getComputedStyle(pill).visibility !== "hidden";
          const walker = document.createTreeWalker(pill, NodeFilter.SHOW_ELEMENT);
          let element: Element | null = pill;
          while (element) {
            // The chevron is an SVG part of the fold order too.
            if (element instanceof HTMLElement || element instanceof SVGElement) {
              const style = getComputedStyle(element);
              const shown = element.getClientRects().length > 0 && style.visibility !== "hidden";
              if (element.hasAttribute("data-fold"))
                parts.push({
                  name,
                  stage: Number(element.dataset.fold),
                  expectedStage: name?.startsWith("Account:")
                    ? 1
                    : name?.startsWith("Access mode:")
                      ? 2
                      : element.classList.contains("exec-pill__meta")
                        ? 3
                        : element.classList.contains("exec-pill__summary")
                          ? 4
                          : element.classList.contains("exec-pill__engine")
                            ? 5
                            : element.classList.contains("exec-pill__chevron")
                              ? 6
                              : element.classList.contains("exec-pill__label")
                                ? 7
                                : NaN,
                  folded: element.hasAttribute("data-folded"),
                  visible: shown,
                  text: element.textContent?.trim() ?? "",
                });
              if (shown && style.textOverflow === "ellipsis")
                labels.push({
                  name,
                  text: element.textContent?.trim() ?? "",
                  width: element.clientWidth,
                  // Match composerQa's integer scroll/client metric for an actually cut label.
                  cut: element.scrollWidth > element.clientWidth + 1,
                });
            }
            element = walker.nextNode() as Element | null;
          }
          return {
            name,
            visible,
            folded: pill.hasAttribute("data-folded"),
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
            inside:
              !visible ||
              (box.left >= bounds.left - epsilon &&
                box.right <= bounds.right + epsilon &&
                box.top >= bounds.top - epsilon &&
                box.bottom <= bounds.bottom + epsilon),
          };
        });
      // Measure the complete controls without changing the composer's layout.
      // Home caps their budget independently of the field's remaining width.
      const controlRoot = composer.querySelector<HTMLElement>(".exec-controls");
      const settingsRow = controlRoot?.closest<HTMLElement>(".composer__settings");
      if (!controlRoot || !settingsRow) throw new Error("Missing execution controls row");
      const unfoldedControls = controlRoot.cloneNode(true) as HTMLElement;
      unfoldedControls.style.cssText =
        "position:fixed;left:-10000px;visibility:hidden;width:max-content;flex-wrap:nowrap";
      for (const part of unfoldedControls.querySelectorAll<HTMLElement>("[data-fold]")) {
        part.removeAttribute("data-folded");
        part.style.removeProperty("max-width");
      }
      document.body.append(unfoldedControls);
      const naturalWidth = unfoldedControls.getBoundingClientRect().width;
      unfoldedControls.remove();
      const cappedWidth = parseFloat(getComputedStyle(settingsRow).maxWidth);
      const controlsBudget = Number.isFinite(cappedWidth) ? cappedWidth : settingsRow.clientWidth;
      const folded = parts.filter((part) => part.folded).map((part) => part.stage);
      const unfolded = parts.filter((part) => !part.folded).map((part) => part.stage);
      const visibility = {
        shown(element: Element) {
          const box = element.getBoundingClientRect();
          return (
            element.getClientRects().length > 0 &&
            box.width > 0 &&
            box.height > 0 &&
            getComputedStyle(element).visibility !== "hidden"
          );
        },
      };
      const controls = [
        ...composer.querySelectorAll<HTMLElement>(".composer__footer button"),
      ].filter(visibility.shown);
      const action = controls.at(-1)?.getBoundingClientRect();
      const settingControls = [
        ...composer.querySelectorAll<HTMLElement>(".exec-controls > button"),
      ].filter(visibility.shown);
      const glyphOnly = settingControls.filter((control) => {
        const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node) {
          if (
            node.textContent?.trim() &&
            node.parentElement &&
            visibility.shown(node.parentElement)
          )
            return false;
          node = walker.nextNode();
        }
        return true;
      });
      const style = getComputedStyle(field);
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d")!;
      context.font = style.font;
      const placeholder = field.getAttribute("placeholder") ?? "";
      const placeholderWidth = context.measureText(placeholder).width;
      const fieldWidth =
        field.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      return {
        composer: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        measurements,
        parts,
        labels,
        placeholder: { text: placeholder, width: placeholderWidth, available: fieldWidth },
        placeholderComplete: placeholder === "Ask Opensteer…" && placeholderWidth <= fieldWidth,
        oneLine:
          !!action &&
          controls.every((control) => {
            const box = control.getBoundingClientRect();
            return Math.abs(box.y + box.height / 2 - action.y - action.height / 2) <= epsilon;
          }),
        noAdjacentGlyph: glyphOnly.length === 0 || settingControls.length === 1,
        requiredMarksVisible:
          measurements[0]!.visible &&
          measurements.every((pill) => (pill.folded ? !pill.visible : pill.visible)),
        naturalWidth,
        controlsBudget,
        foldingNecessary: folded.length === 0 || naturalWidth > controlsBudget,
        desktopUnfolded: parts
          .filter((part) => part.name === measurements[0]!.name)
          .every((part) => !part.folded),
        ordered:
          parts.every((part) => Number.isFinite(part.stage) && part.stage === part.expectedStage) &&
          (folded.length === 0 ||
            unfolded.length === 0 ||
            Math.max(...folded) <= Math.min(...unfolded)),
        inside: measurements.every((pill) => pill.inside),
        noFragments: labels.every((label) => !label.cut || label.width >= 72),
      };
    },
    { field, pills },
  );
}

async function threadState(page: Page) {
  return page.evaluate(() => {
    const client = Reflect.get(window, "opensteerMock") as MockHostClient;
    const snapshot = client.getSnapshot();
    const thread = snapshot.threads.find((thread) => thread.id === snapshot.homeThreadId)!;
    return {
      thread,
      messageIds: (snapshot.transcripts[thread.id] ?? [])
        .filter((entry) => entry.kind === "message")
        .map((entry) => entry.id),
    };
  });
}

try {
  web = await openMockWeb("opensteer-model-picker-web");
  checks.push({
    name: "production build, loopback server and Chromium start",
    status: "passed",
    observed: { origin: web.origin },
  });
  // One healthy shared-setup case before the sweep; unrelated setup failure stops it.
  const smoke = await web.browser.newContext();
  try {
    const page = await smoke.newPage();
    await page.goto(`${web.origin}/new`);
    await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
    await page.waitForFunction(
      () =>
        (Reflect.get(window, "opensteerMock") as MockHostClient).getSnapshot().connection ===
        "connected",
    );
    await page.screenshot({ path: path.join(evidenceDirectory, "setup.png") });
    checks.push({
      name: "shared setup renders the mock Host composer",
      status: "passed",
      observed: { url: page.url(), screenshot: "setup.png" },
    });
  } finally {
    await smoke.close();
  }

  for (const viewport of viewports) {
    const scenario = async (
      ids: readonly StepId[],
      route: string,
      run: (
        page: Page,
        step: (id: StepId, action: (verify: Verify) => Promise<void>) => Promise<void>,
      ) => Promise<void>,
      existing = false,
    ) => {
      const context = await web!.browser.newContext({ viewport, reducedMotion: "reduce" });
      const page = await context.newPage();
      page.setDefaultTimeout(4_000);
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await context.route(
        (url) => url.origin !== web!.origin,
        (route) => route.fulfill({ body: "", contentType: "text/plain", status: 204 }),
      );
      let failedPrerequisite: string | undefined;
      const completed = new Set<StepId>();
      const step = async (id: StepId, action: (verify: Verify) => Promise<void>) => {
        if (!ids.includes(id) || completed.has(id))
          throw new Error(`Unplanned or repeated step ${id}`);
        completed.add(id);
        const assertions: CheckRecord[] = [];
        const verify: Verify = (name, passed, observed = {}) => {
          if (
            !(assertionPlan[id] as readonly string[]).includes(name) ||
            assertions.some((item) => item.name === name)
          )
            throw new Error(`Unplanned or repeated assertion ${id}: ${name}`);
          assertions.push({
            name,
            observed,
            status: passed ? "passed" : "failed",
            ...(passed ? {} : { error: `Contract failed: ${name}` }),
          });
        };
        let error = failedPrerequisite;
        if (!error) {
          try {
            await action(verify);
          } catch (caught) {
            error = caught instanceof Error ? caught.message : String(caught);
            failedPrerequisite = `${id}: ${error}`;
          }
        }
        for (const name of assertionPlan[id])
          if (!assertions.some((item) => item.name === name))
            assertions.push({
              name,
              status: "failed",
              observed: { pageErrors },
              error: error ?? "Planned assertion did not execute",
            });
        const screenshot = `${viewport.width}x${viewport.height}-${id}.png`;
        try {
          await page.screenshot({ path: path.join(evidenceDirectory, screenshot) });
        } catch (caught) {
          assertions.push({
            name: "PNG evidence",
            status: "failed",
            observed: {},
            error: String(caught),
          });
        }
        const diagnostics = {
          pageErrors,
          accessibility: await page.locator("body").ariaSnapshot(),
          alerts: await page.getByRole("alert").allTextContents(),
          preferences: await page.evaluate(
            () =>
              (Reflect.get(window, "opensteerMock") as MockHostClient | undefined)?.getSnapshot()
                .executionPreferences,
          ),
        };
        steps.push({ id, viewport, screenshot, assertions, diagnostics });
        for (const assertion of assertions)
          checks.push({
            ...assertion,
            name: `${viewport.width}x${viewport.height} / ${id} / ${assertion.name}`,
          });
        await writeEvidence();
      };
      try {
        await page.goto(`${web!.origin}${route}`);
        await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
        await page.waitForFunction(
          () =>
            (Reflect.get(window, "opensteerMock") as MockHostClient).getSnapshot().connection ===
            "connected",
        );
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        // A stored choice is fixture input. All subsequent choices use the public UI.
        await page.evaluate(async (existing) => {
          const client = Reflect.get(window, "opensteerMock") as MockHostClient;
          const snapshot = client.getSnapshot();
          const main = snapshot.environments.find((environment) => environment.kind === "main")!;
          const catalog = main.harnessCatalogs.find(
            (catalog) => catalog.driverKind === "codex" && catalog.status === "ready",
          )!;
          if (catalog.status !== "ready") throw new Error("Default Codex catalog is not ready");
          const model = catalog.models.find((model) => model.isDefault)!;
          await client.rememberExecution({
            accessMode: "full-access",
            selection: {
              environmentId: main.id,
              harnessInstanceId: catalog.harnessInstanceId,
              modelSelection: {
                providerId: model.providerId,
                modelId: model.modelId,
                options: { effort: "low" },
              },
            },
          });
          if (existing) {
            const home = snapshot.homeThreadId!;
            while (client.getSnapshot().runQueue.some((run) => run.threadId === home))
              await client.stopRun(home);
          }
        }, existing);
        await enginePill(page).waitFor();
        await run(page, step);
      } catch (caught) {
        failedPrerequisite = caught instanceof Error ? caught.message : String(caught);
      } finally {
        for (const id of ids)
          if (!completed.has(id))
            await step(id, async () => {
              throw new Error(failedPrerequisite ?? "Scenario ended before this step");
            });
        await context.close();
      }
    };

    for (const [id, route] of [
      ["initial-draft", "/new"],
      ["initial-home", "/"],
    ] as const) {
      await scenario([id], route, async (page, step) => {
        await step(id, async (verify) => {
          const current = await choice(page, true);
          verify(
            "stored choices retain their exact names",
            JSON.stringify(current) ===
              JSON.stringify({
                engine: [codexName],
                account: [`Account: ${demo}`],
                options: ["Options: Low"],
                access: [],
              }),
            current,
          );
          const geometry = await composerGeometry(page);
          verify("composer controls share the trailing action line", geometry.oneLine, geometry);
          verify(
            "no glyph-only setting beside another setting",
            geometry.noAdjacentGlyph,
            geometry,
          );
          verify(
            "removed options pill and default access pill are absent",
            (await removedOptionsPill(page).count()) === 0 &&
              (await accessPill(page, true).count()) === 0,
          );
          verify(
            "Home placeholder is complete at 320 and 360",
            route !== "/" || viewport.width > 360 || geometry.placeholderComplete,
            geometry,
          );
          verify(
            "primary accessible name includes the complete summary",
            (await names(enginePill(page)))[0] === `${codexName} · Low`,
          );

          verify(
            "desktop primary labels unfold; optional pills fold only when needed",
            geometry.requiredMarksVisible &&
              geometry.foldingNecessary &&
              (viewport.width !== 1280 || geometry.desktopUnfolded),
            geometry,
          );
          verify(
            "folded parts precede or share the stage of unfolded parts",
            geometry.ordered,
            geometry,
          );
          verify("visible pills stay inside composer", geometry.inside, geometry);
          verify("visible cut labels are at least 72px", geometry.noFragments, geometry);
          const proof = await checkedAccount(page, "Codex", true);
          verify(
            "folded account remains reachable and checked in engine menu",
            proof.checked.length === 1 &&
              proof.checked[0] === demo &&
              JSON.stringify(proof.accounts) === JSON.stringify([demo, alex, "OpenRouter"]),
            proof,
          );
        });
      });
    }

    await scenario(
      ["browse-engine", "browse-account", "commit-account", "remember-options", "restore-options"],
      "/new",
      async (page, step) => {
        await option(page, "Reasoning", "High");
        const before = await choice(page);
        await step("browse-engine", async (verify) => {
          await enginePill(page).click();
          const dialog = picker(page);
          await dialog.waitFor();
          await dialog.getByRole("searchbox", { name: "Search models", exact: true }).waitFor();
          verify(
            "named dialog and search",
            (await dialog.isVisible()) &&
              (await dialog
                .getByRole("searchbox", { name: "Search models", exact: true })
                .isVisible()),
          );
          const tabs = dialog.getByRole("tablist", { name: "Engines", exact: true });
          const statuses = await Promise.all(
            ["Codex", "Claude Code", "OpenCode", "Pi", "Cursor"].map(async (engine) => ({
              engine,
              count: await tabs.getByRole("tab", { name: engine, exact: true }).count(),
              title: await tabs
                .getByRole("tab", { name: engine, exact: true })
                .getAttribute("title"),
            })),
          );
          verify(
            "five engine tabs with readiness",
            statuses.every((tab) => tab.count === 1 && tab.title?.includes("Ready")),
            { statuses },
          );
          await tabs.getByRole("tab", { name: "Claude Code", exact: true }).click();
          verify(
            "browsing engine leaves choice unchanged",
            JSON.stringify(await choice(page)) === JSON.stringify(before),
            { before, after: await choice(page) },
          );
          verify(
            "single available account has no accounts group",
            (await dialog
              .getByRole("group", { name: "Claude Code accounts", exact: true })
              .count()) === 0,
          );
          const bounds = await fitsViewport(dialog, page);
          verify("menu fits viewport", bounds.fits, bounds);
        });
        await step("browse-account", async (verify) => {
          const dialog = picker(page);
          await dialog.getByRole("tab", { name: "Codex", exact: true }).click();
          const accounts = dialog.getByRole("group", { name: "Codex accounts", exact: true });
          verify(
            "three Codex accounts",
            JSON.stringify(await names(accounts.getByRole("menuitemradio"))) ===
              JSON.stringify([demo, alex, "OpenRouter"]),
            { accounts: await names(accounts.getByRole("menuitemradio")) },
          );
          verify(
            "checked account and model",
            (await row(accounts, demo).getAttribute("aria-checked")) === "true" &&
              (await row(
                dialog.getByRole("group", { name: "Models", exact: true }),
                sol,
              ).getAttribute("aria-checked")) === "true",
          );
          await row(accounts, alex).click();
          verify(
            "browsing account leaves choice unchanged",
            JSON.stringify(await choice(page)) === JSON.stringify(before) &&
              (await row(accounts, demo).getAttribute("aria-checked")) === "true" &&
              (await row(accounts, alex).getAttribute("aria-checked")) === "false",
            { before, after: await choice(page) },
          );
          verify(
            "browsed model is not checked",
            (await row(dialog, sol).getAttribute("aria-checked")) === "false",
          );
        });
        await step("commit-account", async (verify) => {
          await row(picker(page), terra).click();
          const current = await committedChoice(page, "Codex");
          verify(
            "model commits engine account and model",
            current.engine[0] === `Engine and model: Codex · ${terra}` &&
              current.account[0] === `Account: ${alex}` &&
              !(await picker(page).isVisible()),
            current,
          );
          verify(
            "reasoning carries to the new account",
            current.options[0] === "Options: High",
            current,
          );
        });
        await step("remember-options", async (verify) => {
          await option(page, "Reasoning", "High");
          verify("changed options are shown", (await summary(page)) === "High");
          await choose(page, "Claude Code", "Claude Sonnet 5");
          const current = await choice(page);
          verify(
            "another engine commits only on model selection",
            current.engine[0] === "Engine and model: Claude Code · Claude Sonnet 5" &&
              !(await picker(page).isVisible()),
            current,
          );
          verify("single-account engine hides account pill", current.account.length === 0, current);
          verify(
            "valid reasoning carries across engines",
            current.options[0] === "Options: High",
            current,
          );
          await option(page, "Reasoning", "Low");
        });
        await step("restore-options", async (verify) => {
          await choose(page, "Codex", terra, alex);
          const current = await committedChoice(page, "Codex");
          verify(
            "returning restores account and model",
            current.engine[0] === `Engine and model: Codex · ${terra}` &&
              current.account[0] === `Account: ${alex}`,
            current,
          );
          verify(
            "remembered options win over carried options",
            current.options[0] === "Options: High",
            current,
          );
        });
      },
    );

    await scenario(
      ["account-keep", "account-default", "account-remembered"],
      "/new",
      async (page, step) => {
        await step("account-keep", async (verify) => {
          await choose(page, "Codex", terra, demo);
          const entry = await openAccountMenu(page, "Codex");
          const accounts = await names(entry.group.getByRole("menuitemradio"));
          verify(
            "account menu lists three accounts",
            JSON.stringify(accounts) === JSON.stringify([demo, alex, "OpenRouter"]),
            { accounts, path: entry.path },
          );
          const action = await selectAccount(page, entry, alex, terra);
          const current = await committedChoice(page, "Codex");
          verify(
            "offered model survives account switch",
            current.engine[0] === `Engine and model: Codex · ${terra}` &&
              current.account[0] === `Account: ${alex}`,
            { ...current, action },
          );
        });
        await step("account-default", async (verify) => {
          const action = await selectAccount(
            page,
            await openAccountMenu(page, "Codex"),
            "OpenRouter",
            sol,
          );
          const current = await committedChoice(page, "Codex");
          verify(
            "missing model falls back to account default",
            current.engine[0] === codexName && current.account[0] === "Account: OpenRouter",
            { ...current, action },
          );
          await enginePill(page).click();
          const optionRows = await settingsStrip(page)
            .getByRole("button", { name: /^(Reasoning|Speed):/ })
            .count();
          await page.keyboard.press("Escape");
          verify(
            "models without options have no summary or option rows",
            current.options.length === 0 && optionRows === 0,
            { ...current, optionRows },
          );
          await choose(page, "Codex", "Llama 4 Maverick (free)", "OpenRouter");
        });
        await step("account-remembered", async (verify) => {
          const action = await selectAccount(
            page,
            await openAccountMenu(page, "Codex"),
            alex,
            terra,
          );
          const current = await committedChoice(page, "Codex");
          verify(
            "missing model falls back to remembered account model",
            current.engine[0] === `Engine and model: Codex · ${terra}` &&
              current.account[0] === `Account: ${alex}`,
            { ...current, action },
          );
          await enginePill(page).click();
          verify(
            "remembered model is checked",
            (await row(picker(page), terra).getAttribute("aria-checked")) === "true",
          );
        });
      },
    );

    await scenario(["search-routes", "search-account"], "/new", async (page, step) => {
      await step("search-routes", async (verify) => {
        await enginePill(page).click();
        await picker(page).getByRole("searchbox", { name: "Search models", exact: true }).fill(sol);
        const results = picker(page).getByRole("group", { name: "Results", exact: true });
        await results.waitFor();
        const routes = row(results, sol);
        const descriptions = await routes.evaluateAll((elements) =>
          elements.map((element) =>
            (element.getAttribute("aria-describedby") ?? "")
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent ?? "")
              .join(" "),
          ),
        );
        verify("same model has separate routes", (await routes.count()) === 4, { descriptions });
        verify(
          "each route describes engine and account",
          [
            "Codex · demo@opensteer.test",
            "Codex · alex@opensteer.test",
            "Codex · OpenRouter",
            "OpenCode · OpenCode Zen",
          ].every((description) => descriptions.some((actual) => actual.includes(description))),
          { descriptions },
        );
        const checked = await routes.evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("aria-checked")),
        );
        verify(
          "only current route is checked",
          checked.filter((value) => value === "true").length === 1 &&
            checked[
              descriptions.findIndex((description) => description.includes(`Codex · ${demo}`))
            ] === "true",
          { checked },
        );
        const bounds = await fitsViewport(picker(page), page);
        verify("search menu fits viewport", bounds.fits, bounds);
      });
      await step("search-account", async (verify) => {
        await picker(page)
          .getByRole("searchbox", { name: "Search models", exact: true })
          .fill(`${sol} alex`);
        const results = picker(page).getByRole("group", { name: "Results", exact: true });
        const rows = row(results, sol);
        await waitForCount(rows, 1);
        verify(
          "account word narrows search",
          (await results.getByRole("menuitemradio").count()) === 1 &&
            (await rows.ariaSnapshot()).includes(alex),
          { results: await results.ariaSnapshot() },
        );
        await rows.click();
        const current = await committedChoice(page, "Codex");
        verify(
          "search result commits exact route",
          current.engine[0] === codexName && current.account[0] === `Account: ${alex}`,
          current,
        );
      });
    });

    await scenario(["recent"], "/new", async (page, step) => {
      await step("recent", async (verify) => {
        await choose(page, "Codex", sol, alex);
        await choose(page, "Claude Code", "Claude Sonnet 5");
        await enginePill(page).click();
        const tab = picker(page).getByRole("tab", { name: "Recent", exact: true });
        await tab.waitFor();
        verify("Recent tab exists", (await tab.count()) === 1);
        await tab.click();
        const recent = picker(page).getByRole("group", { name: "Recent", exact: true });
        await recent.waitFor();
        const routes = await recent.ariaSnapshot();
        const models = await names(recent.getByRole("menuitemradio"));
        verify(
          "last complete choices appear newest first",
          models[0] === "Claude Sonnet 5" && models[1] === sol && models[2] === sol,
          { models, routes },
        );
        verify(
          "recent keeps duplicate models on distinct routes",
          routes.includes(`Codex · ${alex}`) && routes.includes(`Codex · ${demo}`),
          { routes },
        );
      });
    });

    await scenario(["options-default", "options-fast"], "/new", async (page, step) => {
      await step("options-default", async (verify) => {
        verify("default speed is hidden", (await summary(page)) === "Low");
        await enginePill(page).click();
        const strip = settingsStrip(page);
        await strip.waitFor();
        verify(
          "Reasoning and Speed rows exist",
          (await strip.getByRole("button", { name: "Reasoning: Low", exact: true }).isVisible()) &&
            (await strip.getByRole("button", { name: "Speed: Standard", exact: true }).isVisible()),
        );
        await page.keyboard.press("Escape");
        const defaults = [];
        for (const [title, value] of [
          ["Reasoning", "Low"],
          ["Speed", "Standard"],
        ]) {
          const { menu } = await openSetting(page, title!);
          defaults.push(
            await menu
              .getByRole("menuitemradio", { name: new RegExp(`^${value}(?:\\s|$)`) })
              .getAttribute("aria-checked"),
          );
          await page.keyboard.press("Escape");
          await page.keyboard.press("Escape");
        }
        verify(
          "default values are checked",
          defaults.every((value) => value === "true"),
          { defaults },
        );
      });
      await step("options-fast", async (verify) => {
        await option(page, "Speed", "Fast");
        verify("Fast appears in summary", (await summary(page)) === "Low · Fast");
        const { menu } = await openSetting(page, "Speed");
        verify(
          "Fast is checked on reopen",
          (await menu
            .getByRole("menuitemradio", { name: /^Fast(?:\s|$)/ })
            .getAttribute("aria-checked")) === "true",
        );
        await menu.getByRole("menuitemradio", { name: /^Standard(?:\s|$)/ }).click();
        verify("returning to default hides speed", (await summary(page)) === "Low");
      });
    });

    await scenario(["draft-conflict", "draft-resolved"], "/new", async (page, step) => {
      const message = "Exercise the picker without sending this draft.";
      await step("draft-conflict", async (verify) => {
        await page.getByRole("textbox", { name: "Message", exact: true }).fill(message);
        const send = page.getByRole("button", { name: "Start task", exact: true });
        verify("nonempty draft initially permits send", await send.isEnabled());
        await access(page, "Auto");
        await choose(page, "OpenCode", sol);
        const current = await choice(page);
        const reason = await accessPill(page, true).getAttribute("title");
        verify(
          "unsupported access remains named unavailable",
          current.access[0] === "Access mode: Auto (unavailable)",
          current,
        );
        const sendReason = await send.getAttribute("title");
        verify(
          "send is disabled with the conflict reason",
          (await send.isDisabled()) &&
            !!reason &&
            !!sendReason &&
            sendReason.includes("OpenCode") &&
            sendReason.includes("Auto") &&
            /can't|cannot/.test(sendReason),
          { reason, sendReason },
        );
        const { menu } = await openSetting(page, "Access");
        await menu.waitFor();
        verify(
          "all four access modes remain listed",
          (await menu.getByRole("menuitemradio").count()) === 4,
        );
        const auto = menu.getByRole("menuitemradio", { name: /^Auto(?:\s|$)/ });
        verify(
          "unsupported mode is aria-disabled with reason",
          (await auto.getAttribute("aria-disabled")) === "true" &&
            !!reason &&
            (await auto.innerText()).includes(reason),
          { row: await auto.innerText(), reason },
        );
      });
      await step("draft-resolved", async (verify) => {
        await page
          .getByRole("menu", { name: "Access", exact: true })
          .getByRole("menuitemradio", { name: /^Supervised(?:\s|$)/ })
          .click();
        verify(
          "supported mode resolves conflict",
          (await names(accessPill(page, true)))[0] === "Access mode: Supervised",
        );
        verify(
          "nonempty send becomes enabled",
          await page.getByRole("button", { name: "Start task", exact: true }).isEnabled(),
        );
        verify(
          "draft text is preserved",
          (await page.getByRole("textbox", { name: "Message", exact: true }).inputValue()) ===
            message,
        );
      });
    });

    await scenario(["unavailable-auth", "unavailable-location"], "/new", async (page, step) => {
      const before = await choice(page);
      await step("unavailable-auth", async (verify) => {
        const fixture = await page.evaluate(() => {
          const client = Reflect.get(window, "opensteerMock") as MockHostClient;
          const before = client.getSnapshot();
          const main = before.environments.find((environment) => environment.kind === "main")!;
          const catalog = main.harnessCatalogs.find((catalog) => catalog.driverKind === "cursor")!;
          const otherCatalogs = JSON.stringify(
            before.environments.flatMap((environment) =>
              environment.harnessCatalogs.filter(
                (item) => item.harnessInstanceId !== catalog.harnessInstanceId,
              ),
            ),
          );
          client.setHarnessCatalog(main.id, {
            driverKind: catalog.driverKind,
            harnessInstanceId: catalog.harnessInstanceId,
            status: "authentication-required",
            detail: "Sign in to Cursor on this computer to use this account.",
            models: [],
            connections: [],
            setupMethods: [],
          });
          const after = client.getSnapshot();
          return {
            unchanged:
              otherCatalogs ===
              JSON.stringify(
                after.environments.flatMap((environment) =>
                  environment.harnessCatalogs.filter(
                    (item) => item.harnessInstanceId !== catalog.harnessInstanceId,
                  ),
                ),
              ),
            environments: after.environments.length,
            target: after.environments
              .find((environment) => environment.id === main.id)!
              .harnessCatalogs.find((item) => item.harnessInstanceId === catalog.harnessInstanceId),
          };
        });
        verify(
          "fixture changes only targeted catalog",
          fixture.unchanged &&
            fixture.environments === 2 &&
            fixture.target?.status === "authentication-required" &&
            fixture.target.models.length === 0,
          fixture,
        );
        await enginePill(page).click();
        await picker(page).getByRole("tab", { name: "Cursor", exact: true }).click();
        const accounts = picker(page).getByRole("group", { name: "Cursor accounts", exact: true });
        await row(accounts, "Cursor").first().click();
        verify(
          "unavailable account retains reason",
          (await picker(page).ariaSnapshot()).includes(
            "Sign in to Cursor on this computer to use this account.",
          ),
        );
        verify(
          "unavailable account offers fix button",
          await picker(page)
            .getByRole("button", { name: "Check again", exact: true })
            .first()
            .isVisible(),
        );
        verify(
          "browsing unavailable account cannot commit",
          JSON.stringify(await choice(page)) === JSON.stringify(before),
          { before, after: await choice(page) },
        );
      });
      await step("unavailable-location", async (verify) => {
        const accounts = picker(page).getByRole("group", { name: "Cursor accounts", exact: true });
        // The duplicate titles are disambiguated by their accessible descriptions (work location/reason).
        const candidates = row(accounts, "Cursor");
        const descriptions = await rowDescriptions(candidates);
        const awayIndex = descriptions.findIndex((description) =>
          description.includes("Cursor's CLI is not installed"),
        );
        if (awayIndex < 0)
          throw new Error(`Missing Cursor unavailable account: ${JSON.stringify(descriptions)}`);
        const away = candidates.nth(awayIndex);
        await away.click();
        const tree = await picker(page).ariaSnapshot();
        verify(
          "missing Cursor account retains install reason",
          tree.includes("Cursor's CLI is not installed on this computer"),
          { tree },
        );
        verify(
          "missing CLI has no selectable models",
          (await picker(page).getByRole("group", { name: "Models", exact: true }).count()) === 0,
        );
        verify(
          "selected choice is preserved",
          JSON.stringify(await choice(page)) === JSON.stringify(before),
          { before, after: await choice(page) },
        );
      });
    });

    await scenario(
      ["review-open", "review-cancel", "review-confirm"],
      "/",
      async (page, step) => {
        const message = "Keep this draft through the review.";
        await page.getByRole("textbox", { name: "Message", exact: true }).fill(message);
        await access(page, "Auto");
        const before = await threadState(page);
        const review = page.getByRole("dialog", { name: "Review this change", exact: true });
        await step("review-open", async (verify) => {
          await choose(page, "OpenCode", sol);
          await review.waitFor();
          verify("existing session opens Review this change", await review.isVisible());
          verify(
            "Keep and Use actions exist",
            (await review.getByRole("button", { name: "Keep Codex", exact: true }).isVisible()) &&
              (await review.getByRole("button", { name: "Use OpenCode", exact: true }).isVisible()),
          );
          const modes = review.getByRole("radiogroup", { name: "Access mode", exact: true });
          verify(
            "supported access radios are offered",
            (await modes.getByRole("radio").count()) === 3 &&
              (await modes.getByRole("radio", { name: /^Supervised(?:\s|$)/ }).isVisible()) &&
              (await modes
                .getByRole("radio", { name: /^Auto-accept edits(?:\s|$)/ })
                .isVisible()) &&
              (await modes.getByRole("radio", { name: /^Full access(?:\s|$)/ }).isVisible()),
          );
          verify(
            "unsupported Auto radio is absent",
            (await modes.getByRole("radio", { name: /^Auto(?:\s|$)/ }).count()) === 0,
          );
          verify(
            "no access mode is chosen for the reader",
            (await modes.getByRole("radio", { checked: true }).count()) === 0 &&
              (await review
                .getByRole("button", { name: "Use OpenCode", exact: true })
                .isDisabled()),
          );
          const after = await threadState(page);
          verify(
            "choice and session stay unchanged before confirmation",
            JSON.stringify(after.thread) === JSON.stringify(before.thread),
            { before: before.thread, after: after.thread },
          );
          const bounds = await fitsViewport(review, page);
          verify("review fits viewport", bounds.fits, bounds);
        });
        await step("review-cancel", async (verify) => {
          await review.getByRole("button", { name: "Keep Codex", exact: true }).click();
          verify("Keep closes review", !(await review.isVisible()));
          const after = await threadState(page);
          verify(
            "cancel preserves choice session and draft",
            JSON.stringify(after.thread) === JSON.stringify(before.thread) &&
              (await page.getByRole("textbox", { name: "Message", exact: true }).inputValue()) ===
                message,
            { before: before.thread, after: after.thread },
          );
        });
        await step("review-confirm", async (verify) => {
          await choose(page, "OpenCode", sol);
          await review.getByRole("radio", { name: /^Full access(?:\s|$)/ }).click();
          await review.getByRole("button", { name: "Use OpenCode", exact: true }).click();
          await page
            .getByRole("button", { name: /^Engine and model: OpenCode · GPT-5.6-Sol(?: ·|$)/ })
            .waitFor();
          const after = await threadState(page);
          verify(
            "Use commits engine and chosen access",
            after.thread.harnessInstanceId !== before.thread.harnessInstanceId &&
              after.thread.accessMode === "full-access" &&
              !(await review.isVisible()),
            { thread: after.thread },
          );
          verify(
            "new engine gets a new session",
            after.thread.providerSessionId !== before.thread.providerSessionId,
            { before: before.thread.providerSessionId, after: after.thread.providerSessionId },
          );
          verify(
            "existing messages and draft survive",
            before.messageIds.every((id) => after.messageIds.includes(id)) &&
              (await page.getByRole("textbox", { name: "Message", exact: true }).inputValue()) ===
                message,
            { before: before.messageIds, after: after.messageIds },
          );
        });
      },
      true,
    );

    for (const [id, route] of [
      ["menu-settings-home", "/"],
      ["menu-settings-draft", "/new"],
    ] as const) {
      await scenario(
        [id],
        route,
        async (page, step) => {
          await step(id, async (verify) => {
            await enginePill(page).click();
            const strip = settingsStrip(page);
            await strip.waitFor();
            const accounts = picker(page).getByRole("group", {
              name: "Codex accounts",
              exact: true,
            });
            verify(
              "menu reads current account reasoning speed and access",
              (await row(accounts, demo).getAttribute("aria-checked")) === "true" &&
                (await strip.getAttribute("aria-label")) === `Current · Codex · ${sol}` &&
                (await strip
                  .getByRole("button", { name: "Reasoning: Low", exact: true })
                  .isVisible()) &&
                (await strip
                  .getByRole("button", { name: "Speed: Standard", exact: true })
                  .isVisible()) &&
                (await strip
                  .getByRole("button", { name: "Access: Full access", exact: true })
                  .isVisible()),
            );
            const before = await choice(page);
            await row(accounts, alex).click();
            verify(
              "account browsing preserves the choice until a model is picked",
              JSON.stringify(before) === JSON.stringify(await choice(page)) &&
                (await row(accounts, demo).getAttribute("aria-checked")) === "true",
            );
            await row(picker(page), sol).click();
            await picker(page).waitFor({ state: "hidden" });
            // A route commit and its optional review both render asynchronously,
            // and the review is attached before it can be read: wait for
            // whichever settles, then confirm the review once it is readable.
            const review = page.getByRole("dialog", { name: "Review this change", exact: true });
            const committed = page.getByRole("button", {
              name: `Account: ${alex}`,
              exact: true,
              includeHidden: true,
            });
            await review.or(committed).first().waitFor({ state: "attached" });
            if ((await review.count()) > 0) {
              await review.getByRole("button", { name: "Use Codex", exact: true }).click();
              await review.waitFor({ state: "hidden" });
            }
            await committed.waitFor({ state: "attached" });
            await enginePill(page).click();
            await settingsStrip(page).waitFor();
            const accountProof = await accounts.ariaSnapshot();
            const modelProof = await picker(page)
              .getByRole("group", { name: "Models", exact: true })
              .ariaSnapshot();
            verify(
              "reopened account and model are checked",
              (await row(
                picker(page).getByRole("group", { name: "Codex accounts", exact: true }),
                alex,
              ).getAttribute("aria-checked")) === "true" &&
                (await row(
                  picker(page).getByRole("group", { name: "Models", exact: true }),
                  sol,
                ).getAttribute("aria-checked")) === "true",
              { accountProof, modelProof },
            );
            await page.keyboard.press("Escape");
            await option(page, "Reasoning", "High");
            await option(page, "Speed", "Fast");
            await access(page, "Supervised");
            const geometry = await composerGeometry(page);
            verify(
              "changed composer stays on one line without adjacent glyph settings",
              geometry.oneLine &&
                geometry.noAdjacentGlyph &&
                geometry.inside &&
                geometry.ordered &&
                geometry.noFragments,
              geometry,
            );
            const reopened = [];
            for (const [title, value] of [
              ["Reasoning", "High"],
              ["Speed", "Fast"],
              ["Access", "Supervised"],
            ] as const) {
              await enginePill(page).click();
              const setting = settingsStrip(page).getByRole("button", {
                name: `${title}: ${value}`,
                exact: true,
              });
              await setting.waitFor();
              const visible = await setting.isVisible();
              await setting.click();
              const menu = picker(page).getByRole("menu", { name: title, exact: true });
              await page.screenshot({
                path: path.join(
                  evidenceDirectory,
                  `${viewport.width}x${viewport.height}-${id}-${title}-detail.png`,
                ),
              });
              reopened.push({
                title,
                value,
                visible,
                checked: await menu
                  .getByRole("menuitemradio", { name: new RegExp(`^${value}(?:\\s|$)`) })
                  .getAttribute("aria-checked"),
              });
              await page.keyboard.press("Escape");
              await page.keyboard.press("Escape");
            }
            verify(
              "changed setting rows and checked values survive reopening",
              reopened.every((item) => item.visible && item.checked === "true"),
              { reopened },
            );
            if (route === "/new") {
              const message = "Verify the one-control execution choice.";
              await page.getByRole("textbox", { name: "Message", exact: true }).fill(message);
              await page.getByRole("button", { name: "Start task", exact: true }).click();
              await page.waitForFunction(() => {
                const snapshot = (
                  Reflect.get(window, "opensteerMock") as MockHostClient
                ).getSnapshot();
                return snapshot.threads.some(
                  (thread) =>
                    thread.modelSelection.options.speed === "priority" &&
                    thread.modelSelection.options.effort === "high",
                );
              });
              const stored = await page.evaluate(() => {
                const snapshot = (
                  Reflect.get(window, "opensteerMock") as MockHostClient
                ).getSnapshot();
                const account = snapshot.environments
                  .flatMap((environment) => environment.harnessCatalogs)
                  .find((catalog) =>
                    catalog.connections.some(
                      (connection) => connection.accountLabel === "alex@opensteer.test",
                    ),
                  );
                const thread = snapshot.threads.find(
                  (thread) =>
                    thread.harnessInstanceId === account?.harnessInstanceId &&
                    thread.modelSelection.options.speed === "priority",
                );
                return {
                  preferences: snapshot.executionPreferences,
                  thread,
                  expectedAccount: account?.harnessInstanceId,
                  messages: thread
                    ? snapshot.transcripts[thread.id]
                        ?.filter((entry) => entry.kind === "message")
                        .map((entry) => entry.body)
                    : [],
                };
              });
              const selected = stored.preferences.history[0];
              verify(
                "mock Host stores the sent account model options and access",
                !!stored.expectedAccount &&
                  selected?.harnessInstanceId === stored.expectedAccount &&
                  selected.modelSelection.modelId === "gpt-5.6-sol" &&
                  selected.modelSelection.options.effort === "high" &&
                  selected.modelSelection.options.speed === "priority" &&
                  stored.preferences.accessMode === "approval-required" &&
                  stored.thread?.harnessInstanceId === stored.expectedAccount &&
                  stored.thread.modelSelection.modelId === "gpt-5.6-sol" &&
                  stored.thread.modelSelection.options.effort === "high" &&
                  stored.thread.modelSelection.options.speed === "priority" &&
                  stored.thread.accessMode === "approval-required" &&
                  stored.messages?.includes(message) === true,
                stored,
              );
            }
          });
        },
        true,
      );
    }

    await scenario(["drill-in-keyboard"], "/new", async (page, step) => {
      await step("drill-in-keyboard", async (verify) => {
        const observations = [];
        for (const title of ["Reasoning", "Speed", "Access"]) {
          const { menu, setting } = await openSetting(page, title);
          const checked = menu.getByRole("menuitemradio", { checked: true });
          const focused = await checked.evaluate((element) => element === document.activeElement);
          await page.keyboard.press("Escape");
          const escaped =
            (await picker(page).isVisible()) &&
            (await setting.evaluate((element) => element === document.activeElement));
          await page.keyboard.press("Escape");
          await picker(page).waitFor({ state: "hidden" });
          const closed = await enginePill(page).evaluate(
            (element) => element === document.activeElement,
          );
          await openSetting(page, title);
          await picker(page)
            .getByRole("button", { name: `Back to models · ${title}`, exact: true })
            .click();
          const backed =
            (await picker(page).isVisible()) &&
            (await setting.evaluate((element) => element === document.activeElement));
          await page.keyboard.press("Escape");
          observations.push({ title, focused, escaped, closed, backed });
        }
        verify(
          "each drill-in focuses its checked choice",
          observations.every((item) => item.focused),
          { observations },
        );
        verify(
          "Escape returns to the setting row without closing",
          observations.every((item) => item.escaped),
          { observations },
        );
        verify(
          "second Escape returns to the primary control",
          observations.every((item) => item.closed),
          { observations },
        );
        verify(
          "Back returns to the setting row without closing",
          observations.every((item) => item.backed),
          { observations },
        );
        await option(page, "Reasoning", "High");
        verify(
          "choosing a value applies it and closes the picker",
          !(await picker(page).isVisible()) && (await summary(page)) === "High",
        );
      });
    });

    await scenario(["toggle-option"], "/new", async (page, step) => {
      await step("toggle-option", async (verify) => {
        await choose(page, "Claude Code", "Claude Opus 5");
        await enginePill(page).click();
        const toggle = settingsStrip(page).getByRole("switch", { name: /^Fast mode/ });
        await toggle.waitFor();
        verify(
          "toggle reads its current value",
          (await toggle.isVisible()) && (await toggle.getAttribute("aria-checked")) === "false",
        );
        await toggle.click();
        verify(
          "toggling applies without closing the picker",
          (await picker(page).isVisible()) &&
            (await toggle.getAttribute("aria-checked")) === "true",
        );
        await page.keyboard.press("Escape");
        await enginePill(page).click();
        verify(
          "toggle value survives reopening",
          (await toggle.getAttribute("aria-checked")) === "true",
        );
      });
    });

    // A draft re-derives its choice from the live catalog; a Thread keeps the
    // options it was given, so only a Thread can hold a level that has gone.
    await scenario(
      ["saved-option"],
      "/",
      async (page, step) => {
        await step("saved-option", async (verify) => {
          await option(page, "Reasoning", "Extra High");
          // The engine stops offering the saved level on every Codex account.
          const dropped = await page.evaluate((model) => {
            const client = Reflect.get(window, "opensteerMock") as MockHostClient;
            let count = 0;
            for (const environment of client.getSnapshot().environments) {
              for (const catalog of environment.harnessCatalogs) {
                if (catalog.driverKind !== "codex") continue;
                client.setHarnessCatalog(environment.id, {
                  ...catalog,
                  models: catalog.models.map((candidate) =>
                    candidate.displayName !== model
                      ? candidate
                      : {
                          ...candidate,
                          options: candidate.options.map((option) =>
                            option.id === "effort" && option.type === "select"
                              ? {
                                  ...option,
                                  values: option.values.filter((value) => value.value !== "xhigh"),
                                }
                              : option,
                          ),
                        },
                  ),
                });
                count += 1;
              }
            }
            return count;
          }, sol);
          await enginePill(page).click();
          const saved = settingsStrip(page).getByRole("button", {
            name: "Reasoning: Saved configuration",
            exact: true,
          });
          verify(
            "a saved level the engine dropped reads as saved, not as the default",
            dropped > 0 && (await saved.isVisible()),
            {
              dropped,
              rows: await names(settingsStrip(page).getByRole("button")),
            },
          );
          await saved.click();
          const menu = picker(page).getByRole("menu", { name: "Reasoning", exact: true });
          await menu.waitFor();
          verify(
            "its choices check none and say why",
            (await menu.getByRole("menuitemradio", { checked: true }).count()) === 0 &&
              (await picker(page)
                .getByText("Choose a value to replace the saved one this engine no longer offers.")
                .isVisible()),
          );
          await menu.getByRole("menuitemradio", { name: /^Medium(?:\s|$)/ }).click();
          await picker(page).waitFor({ state: "hidden" });
          await enginePill(page).click();
          verify(
            "choosing a listed level replaces it",
            await settingsStrip(page)
              .getByRole("button", { name: "Reasoning: Medium", exact: true })
              .isVisible(),
          );
          await page.keyboard.press("Escape");
        });
      },
      true,
    );

    for (const kind of ["engine", "account", "options", "access"] as const) {
      const id = `keyboard-${kind}` as const;
      await scenario([id], "/new", async (page, step) => {
        await step(id, async (verify) => {
          if (kind === "account") {
            // Browsing an account replaces only the models below it, never the
            // row the reader pressed, so the keyboard stays where it was.
            await enginePill(page).click();
            await picker(page).getByRole("tab", { name: "Codex", exact: true }).click();
            const browsed = picker(page).getByRole("group", {
              name: "Codex accounts",
              exact: true,
            });
            await row(browsed, alex).focus();
            await page.keyboard.press("Enter");
            verify(
              "browsing an account keeps focus on its row",
              await row(browsed, alex).evaluate(
                (element) => element.isConnected && element === document.activeElement,
              ),
            );
            await page.keyboard.press("Escape");
            await picker(page).waitFor({ state: "hidden" });
            const entry = await openAccountMenu(page, "Codex", true);
            const items = entry.group.getByRole("menuitemradio");
            await items.first().focus();
            await page.keyboard.press("ArrowDown");
            verify(
              "arrow keys move among menu items",
              await row(entry.group, alex).evaluate(
                (element) => element === document.activeElement,
              ),
              { path: entry.path, accounts: await names(items) },
            );
            await page.keyboard.press("Escape");
            await entry.menu.waitFor({ state: "hidden" });
            verify("Escape closes menu", !(await entry.menu.isVisible()));
            verify(
              "focus returns to primary control",
              await entry.anchor.evaluate((element) => element === document.activeElement),
              { path: entry.path },
            );
            const reopened = await openAccountMenu(page, "Codex", true);
            await row(reopened.group, demo).focus();
            await page.keyboard.press("ArrowDown");
            await page.keyboard.press("Enter");
            if (reopened.path === "engine-menu") {
              await row(reopened.menu, sol).focus();
              await page.keyboard.press("Enter");
            }
            await reopened.menu.waitFor({ state: "hidden" });
            const current = await committedChoice(page, "Codex");
            verify(
              "keyboard account selection commits the intended route",
              current.engine[0] === codexName && current.account[0] === `Account: ${alex}`,
              { ...current, path: reopened.path },
            );
            return;
          }
          const pill = enginePill(page);
          await pill.focus();
          await page.keyboard.press("Enter");
          const menu = picker(page);
          if (kind !== "engine") {
            const title = kind === "options" ? "Reasoning" : "Access";
            await settingsStrip(page)
              .getByRole("button", { name: new RegExp(`^${title}:`) })
              .click();
          }
          const items = kind === "engine" ? menu.getByRole("tab") : menu.getByRole("menuitemradio");
          await items.first().focus();
          await page.keyboard.press("ArrowDown");
          const second = await menu.evaluate((element) => ({
            inside: element.contains(document.activeElement),
            role: document.activeElement?.getAttribute("role"),
          }));
          verify(
            kind === "engine"
              ? "arrow keys move focus inside picker"
              : "arrow keys move among menu items",
            second.inside &&
              !(await items.first().evaluate((element) => element === document.activeElement)) &&
              (kind === "engine" || second.role === "menuitemradio"),
            second,
          );
          if (kind !== "engine") await page.keyboard.press("Escape");
          await page.keyboard.press("Escape");
          await menu.waitFor({ state: "hidden" });
          verify(
            kind === "engine" ? "Escape closes picker" : "Escape closes menu",
            !(await menu.isVisible()),
          );
          verify(
            "focus returns to primary control",
            await pill.evaluate((element) => element === document.activeElement),
          );
        });
      });
    }
  }
} catch (error) {
  checks.push({
    name: "shared setup / journey",
    status: "failed",
    observed: {},
    error: error instanceof Error ? error.message : String(error),
  });
} finally {
  if (web) {
    try {
      await web.close();
      checks.push({ name: "browser/server cleanup", status: "passed", observed: {} });
    } catch (error) {
      checks.push({
        name: "browser/server cleanup",
        status: "failed",
        observed: {},
        error: String(error),
      });
    }
  }
  const expectedStepCount = Object.keys(assertionPlan).length * viewports.length;
  const coverage = viewports.every((viewport) =>
    Object.keys(assertionPlan).every(
      (id) =>
        steps.filter(
          (step) =>
            step.id === id &&
            step.viewport.width === viewport.width &&
            step.viewport.height === viewport.height,
        ).length === 1,
    ),
  );
  checks.push({
    name: "every planned step recorded once per viewport",
    status: coverage ? "passed" : "failed",
    observed: { expected: expectedStepCount, actual: steps.length },
    ...(coverage
      ? {}
      : { error: "Selected steps did not all execute; shared setup may have failed" }),
  });
  await writeEvidence();
  await finishJourney(evidenceDirectory, checks, { sourceSha, journey: "journey.json" });
}
