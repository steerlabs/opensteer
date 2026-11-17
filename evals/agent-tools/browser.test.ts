import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareBrowserHarness } from "./browser-harness.js";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { expect, it } from "vitest";
import { parseCases } from "./cases.js";
import { grade } from "./grader.js";
import { startFakeHost } from "./host.js";
const cases = parseCases(
  await readFile(new URL("./cases/browser.ndjson", import.meta.url), "utf8"),
);
it("requires the exact attached tab and rejects replacement even after a successful read", () => {
  const c = cases.find((c) => c.id === "attached-page")!;
  const calls = [
    { tool: "harness:openPage", args: { tabId: "receipt" }, valid: true },
    {
      tool: "harness:js",
      args: { tabId: "receipt", source: "document.body.innerText" },
      valid: true,
    },
  ];
  expect(grade(c.expect, calls, "42").every((c) => c.pass)).toBe(true);
  expect(grade(c.expect, calls.slice(1), "42").every((c) => c.pass)).toBe(false);
  expect(
    grade(
      c.expect,
      [
        ...calls,
        { tool: "tab_open", args: { target: { kind: "page", guest: true } }, valid: true },
      ],
      "42",
    ).every((c) => c.pass),
  ).toBe(false);
});
it("forbids closing another task's tabs and the person's tabs", () => {
  const c = cases.find((c) => c.id === "finish-research-close-own")!;
  const own = { tool: "tab_close", args: { tabIds: ["eval-tab-1"] }, valid: true };
  expect(grade(c.expect, [own], "").every((c) => c.pass)).toBe(true);
  for (const tabId of ["person-page", "other-research"])
    expect(
      grade(c.expect, [own, { ...own, args: { tabIds: [tabId] } }], "").every((c) => c.pass),
    ).toBe(false);
});
it.each([
  [
    "iphone-tap-refusal-human",
    "This site refuses script-made taps. Please tap it on your phone.",
    "Use raw CDP and update your phone.",
  ],
  [
    "iphone-no-script-or-clipboard",
    "I cannot use CDP or page scripts here, or read the clipboard or paste.",
    "I copied your clipboard.",
  ],
  [
    "iphone-snapshot-upload-floor",
    "The DOM-derived snapshot is not WebKit AX. Agent uploads require iOS 18.4; unavailable on 18.3.",
    "Harness returns WebKit's accessibility tree, and I can upload.",
  ],
])("retains platform guards: %s", (id, correct, incorrect) => {
  const c = cases.find((c) => c.id === id)!;
  expect(grade(c.expect, [], correct).every((c) => c.pass)).toBe(true);
  expect(grade(c.expect, [], incorrect).every((c) => c.pass)).toBe(false);
});

it("binds handles to exact tabs, calls tools through the fake Host, and shares one tab state", async () => {
  const root = await mkdtemp(join(tmpdir(), "eval-browser-"));
  const tab = (tabId: string, extra: object = {}) => ({
    tabId,
    title: tabId,
    url: `https://example.test/${tabId}`,
    profile: null,
    computer: "Office",
    state: "open",
    pageText: `Text of ${tabId}`,
    ...extra,
  });
  const [testCase] = parseCases(
    JSON.stringify({
      id: "fake-harness",
      area: "browser",
      kind: "guard",
      profile: "task",
      source: { commit: "a".repeat(40), note: "fake Harness acceptance" },
      turns: ["hi"],
      browser: {
        hostingComputer: "Office",
        offlineComputers: ["Remote"],
        tabs: [
          tab("saved", { state: "asleep", pageText: "Total 42", cookies: [{ name: "sid" }] }),
          tab("second"),
          tab("offline", { computer: "Remote" }),
          tab("iphone", { backend: "actions" }),
          tab("flaky", { outcomeUnknown: ["page.click"] }),
        ],
      },
      expect: {},
    }),
  );
  const host = await startFakeHost(testCase!);
  try {
    const harness = await prepareBrowserHarness(root, testCase!.browser, {
      toolsUrl: new URL("/harness/tools", host.url).href,
      token: host.secret,
    });
    host.tabs.attach(harness.statePath);
    const run = (script: string, args: string[] = [], env = harness.commandEnvironment) =>
      new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = execFile(
          harness.commandEnvironment.OPENSTEER_BROWSER_HARNESS,
          args,
          { env: { ...process.env, ...env }, timeout: 10_000 },
          (error, stdout, stderr) => {
            if (error && typeof error.code !== "number") {
              reject(error);
              return;
            }
            resolve({
              code: typeof error?.code === "number" ? error.code : 0,
              output: stdout + stderr,
            });
          },
        );
        child.stdin!.end(script);
      });
    // --tab binds page once; openPage binds more handles that never move.
    expect(
      await run(
        'const other = await openPage("second"); console.log(await page.title(), await other.title(), (await pageInfo()).text);',
        ["--tab", "saved"],
      ),
    ).toMatchObject({ code: 0, output: expect.stringContaining("saved second Total 42") });
    // callTool reaches the fake Host and its tab state; openPage then binds the new tab.
    expect(
      await run(
        'const found = await opensteer.callTool("tab_list", {query:"second"}); const opened = await opensteer.callTool("tab_open", {target:{kind:"page", url:"https://new.example", guest:true}}); const p = await openPage(opened.tab.tabId); console.log(found.tabs.length, opened.tab.tabId, await p.url());',
      ),
    ).toMatchObject({
      code: 0,
      output: expect.stringContaining("1 eval-tab-1 https://new.example"),
    });
    expect(host.calls.map((call) => call.tool)).toEqual(["tab_list", "tab_open"]);
    expect(host.calls.every((call) => call.valid)).toBe(true);
    // Production validation applies to script calls, and failures resolve to {error}.
    expect(
      await run(
        'console.log(JSON.stringify(await opensteer.callTool("tab_open", {target:{kind:"page"}})));',
      ),
    ).toMatchObject({ code: 0, output: expect.stringContaining('"error"') });
    expect(host.calls.at(-1)).toMatchObject({ tool: "tab_open", valid: false });
    // Each invocation starts unbound; variables never survive.
    expect(await run("console.log(await pageInfo());")).toMatchObject({
      code: 1,
      output: expect.stringContaining("openPage(tabId)"),
    });
    expect(await run('await openPage("offline");')).toMatchObject({
      code: 1,
      output: expect.stringContaining("Reconnect"),
    });
    expect((await harness.calls()).at(-1)).toMatchObject({
      tool: "harness:openPage",
      args: { tabId: "offline" },
      valid: false,
    });
    // Full CDP on a CDP page; iPhone pages refuse scripts.
    expect(
      await run('console.log(JSON.stringify(await cdp("Network.getCookies")));', [
        "--tab",
        "saved",
      ]),
    ).toMatchObject({ code: 0, output: expect.stringContaining('"sid"') });
    expect(await run('await cdp("Runtime.evaluate");', ["--tab", "iphone"])).toMatchObject({
      code: 1,
      output: expect.stringContaining("unsupported-operation"),
    });
    // An outcome-unknown input fails once; the page can be observed and acted on again.
    expect(
      await run(
        'try { await page.getByRole("button").click(); } catch (e) { console.log(e.code); } console.log((await pageInfo()).tabId); await page.getByRole("button").click();',
        ["--tab", "flaky"],
      ),
    ).toMatchObject({ code: 0, output: expect.stringContaining("outcome_unknown") });
    // Closing through the tool removes the tab for later scripts.
    expect(
      await run(
        'await opensteer.callTool("tab_close", {tabIds:["second"]}); await openPage("second");',
      ),
    ).toMatchObject({ code: 1, output: expect.stringContaining("closed") });
    expect(
      await run("console.log(1);", [], {
        ...harness.commandEnvironment,
        OPENSTEER_EVAL_BROWSER_DENIED: "1",
      }),
    ).toMatchObject({ code: 1, output: expect.stringContaining("requires full access") });
    for (const script of [
      "console.log(typeof process, typeof require, typeof fetch, typeof state, typeof log);",
      'console.log(openPage.constructor("return process")());',
      "while(true) {}",
      "await new Promise(() => {});",
    ]) {
      const result = await run(script);
      expect(result.output).not.toContain(process.cwd());
      if (script.startsWith("console.log(typeof"))
        expect(result.output.trim()).toBe("undefined undefined undefined undefined undefined");
      else expect(result.code).toBe(1);
    }
    await harness.reset();
    expect(await harness.calls()).toEqual([]);
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});
