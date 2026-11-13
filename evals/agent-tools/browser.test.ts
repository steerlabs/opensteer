import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserFixtureSchema } from "./cases.js";
import { prepareBrowserHarness } from "./browser-harness.js";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { expect, it } from "vitest";
import { parseCases } from "./cases.js";
import { grade } from "./grader.js";
const cases = parseCases(
  await readFile(new URL("./cases/browser.ndjson", import.meta.url), "utf8"),
);
it("requires the exact attached tab and rejects replacement even after a successful read", () => {
  const c = cases.find((c) => c.id === "attached-page")!;
  const calls = [
    { tool: "harness:switchTab", args: { tabId: "receipt" }, valid: true },
    { tool: "harness:js", args: { source: "document.body.innerText" }, valid: true },
  ];
  expect(grade(c.expect, calls, "42").every((c) => c.pass)).toBe(true);
  expect(grade(c.expect, calls.slice(1), "42").every((c) => c.pass)).toBe(false);
  expect(
    grade(
      c.expect,
      [...calls, { tool: "harness:newTab", args: { guest: true }, valid: false }],
      "42",
    ).every((c) => c.pass),
  ).toBe(false);
});
it("forbids closing another task's tabs and the person's tabs", () => {
  const c = cases.find((c) => c.id === "finish-research-close-own")!;
  const own = { tool: "harness:closeTab", args: { tabId: "eval-tab-1" }, valid: true };
  expect(grade(c.expect, [own], "").every((c) => c.pass)).toBe(true);
  for (const tabId of ["person-page", "other-research"])
    expect(grade(c.expect, [own, { ...own, args: { tabId } }], "").every((c) => c.pass)).toBe(
      false,
    );
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

it("executes real stdin scripts, persists identity, wakes asleep tabs, and logs failed attempts", async () => {
  const root = await mkdtemp(join(tmpdir(), "eval-browser-"));
  try {
    const harness = await prepareBrowserHarness(
      root,
      BrowserFixtureSchema.parse({
        profiles: [{ id: "work", name: "Work", computer: "Office" }],
        offlineComputers: ["Remote"],
        tabs: [
          {
            tabId: "saved",
            title: "Receipt",
            url: "https://example.test",
            profile: { id: "work", name: "Work" },
            computer: "Office",
            state: "asleep",
            usedByThisTask: false,
            usedByOtherTask: false,
            groupId: null,
            pageText: "Total 42",
          },
          {
            tabId: "offline",
            title: "Remote",
            url: "https://example.test",
            profile: null,
            computer: "Remote",
            state: "open",
            usedByThisTask: false,
            usedByOtherTask: false,
            groupId: null,
          },
        ],
      }),
    );
    const run = (script: string, args: string[] = []) =>
      new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = execFile(
          harness.commandEnvironment.OPENSTEER_BROWSER_HARNESS,
          args,
          { env: { ...process.env, ...harness.commandEnvironment }, timeout: 5000 },
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
    expect(
      await run(
        'console.log(await listTabs({query:"Receipt"})); await switchTab("saved"); console.log(await js("document.body.innerText"));',
      ),
    ).toMatchObject({ code: 0, output: expect.stringContaining("Total 42") });
    expect(
      await run(
        'console.log(await currentTab()); const id=await newTab("https://example.test/new"); console.log(id);',
      ),
    ).toMatchObject({ code: 0, output: expect.stringContaining("eval-tab-1") });
    expect(await run("console.log(await currentTab());")).toMatchObject({
      code: 0,
      output: expect.stringContaining("eval-tab-1"),
    });
    expect(await run("console.log(await pageInfo());", ["--tab", "saved"])).toMatchObject({
      code: 0,
      output: expect.stringContaining("Total 42"),
    });
    expect(await run('await switchTab("offline");')).toMatchObject({
      code: 1,
      output: expect.stringContaining("Reconnect"),
    });
    expect((await harness.calls()).at(-1)).toMatchObject({
      tool: "harness:switchTab",
      args: { tabId: "offline" },
      valid: false,
    });
    expect(await run('await closeTab("saved"); await switchTab("saved");')).toMatchObject({
      code: 1,
      output: expect.stringContaining("closed"),
    });
    for (const script of [
      "console.log(typeof process, typeof require, typeof fetch, typeof state, typeof log);",
      'console.log(listTabs.constructor("return process")());',
      "while(true) {}",
      "await new Promise(() => {});",
    ]) {
      const result = await run(script);
      expect(result.output).not.toContain(process.cwd());
      if (script.startsWith("console.log(typeof"))
        expect(result.output.trim()).toBe("undefined undefined undefined undefined undefined");
      else expect(result.code).toBe(1);
    }
    expect(
      JSON.parse(
        await readFile(harness.commandEnvironment.OPENSTEER_EVAL_BROWSER_STATE, "utf8"),
      ).tabs.some((t: { tabId: string }) => t.tabId === "saved"),
    ).toBe(false);
    await harness.reset();
    expect(await harness.calls()).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
