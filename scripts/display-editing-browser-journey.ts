import { existsSync as guestMarkerExists } from "node:fs";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "vite";
import { chromium, type Browser } from "playwright-core";
import { decodeDisplayViewerFrame } from "../packages/protocol/src/display-stream.js";
import { MockPhoneDisplaySocket } from "../packages/client/src/mock/mock-phone-display.js";
import { displayEditingHost } from "../apps/host/src/computer-use/display-editing-host.test-support.js";
import type { DisplayEditingSmokeApi } from "../apps/web/scripts/fixtures/display-editing-viewer.js";

if (
  !guestMarkerExists(path.join(process.env.HOME!, ".opensteer-test-guest")) &&
  !import.meta.dirname.includes("/opensteer-job/src/")
)
  throw new Error("Run this clipboard journey through pnpm test:vm.");
const directory =
  process.env.OPENSTEER_DISPLAY_BROWSER_EVIDENCE_DIR ??
  path.join(
    process.env.OPENSTEER_JOURNEY_OUT ?? path.join(process.env.HOME!, "opensteer-job/artifacts"),
    "display-editing-browser",
  );
await mkdir(directory, { recursive: true });
const output = await mkdtemp(path.join(tmpdir(), "display-browser-"));
const sampleSocket = new MockPhoneDisplaySocket("live");
const mediaPayload = await new Promise<Uint8Array>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("No fixture keyframe")), 3000);
  sampleSocket.addEventListener("message", (event: never) => {
    const message = event as { data: unknown };
    if (message.data instanceof ArrayBuffer) {
      clearTimeout(timer);
      resolve(decodeDisplayViewerFrame(new Uint8Array(message.data)).payload);
    }
  });
}).finally(() => sampleSocket.close());
const server = createServer((request, response) => {
  void (async () => {
    const name = request.url?.split("?")[0];
    if (name === "/viewer.js" || name === "/viewer.css") {
      response.setHeader("Content-Type", name.endsWith("js") ? "text/javascript" : "text/css");
      response.end(await readFile(path.join(output, name)));
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(
      '<div id="root"></div><link rel="stylesheet" href="/viewer.css"><style>body{margin:20px;font:16px sans-serif}.computer-watch__picture{height:600px;position:relative}.phone-display__canvas{width:720px;height:600px;object-fit:contain}</style><script type="module" src="/viewer.js"></script>',
    );
  })().catch((error) => {
    response.statusCode = 500;
    response.end(String(error));
  });
});
let browser: Browser | undefined;
const cases: { name: string; passed: boolean; error?: string }[] = [];
try {
  await build({
    configFile: false,
    root: path.resolve(import.meta.dirname, "../apps/web"),
    logLevel: "warn",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      target: "es2024",
      outDir: output,
      emptyOutDir: true,
      lib: {
        entry: path.resolve(
          import.meta.dirname,
          "../apps/web/scripts/fixtures/display-editing-viewer.tsx",
        ),
        formats: ["es"],
        fileName: () => "viewer.js",
        cssFileName: "viewer",
      },
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No renderer server");
  browser = await chromium.launch({ headless: true });
  for (const mac of [false, true]) {
    const name = mac ? "mac" : "phone";
    const host = await displayEditingHost({ mac, editing: true, mediaPayload });
    const context = await browser.newContext({
      viewport: { width: 1000, height: 850 },
      permissions: ["clipboard-read", "clipboard-write"],
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    try {
      const source = host.source;
      const route =
        source.kind === "owner-view" ? `views/${source.viewId}/1` : `sessions/${source.sessionId}`;
      const url = new URL(`http://127.0.0.1:${address.port}`);
      url.searchParams.set(
        "displaySocketUrl",
        `${host.base}/v1/computer-use/${route}/display?editing=1`,
      );
      url.searchParams.set("mac", mac ? "1" : "0");
      await page.goto(url.toString());
      await page.getByRole("button", { name: "Take over", exact: true }).click();
      const field = page.locator("textarea.remote-keyboard-input:not(:disabled)");
      await field.focus();
      await page.keyboard.type("e");
      await page.waitForFunction(() =>
        (Reflect.get(window, "displayEditingSmoke") as DisplayEditingSmokeApi)
          .events()
          .some((event) => event.kind === "key" && event.text === "e"),
      );
      await page.evaluate(() => {
        const field = document.querySelector<HTMLTextAreaElement>(
          "textarea.remote-keyboard-input",
        )!;
        field.value = "é";
        field.setSelectionRange(1, 1);
        field.dispatchEvent(
          new InputEvent("input", { bubbles: true, inputType: "insertReplacementText" }),
        );
        field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        field.value = "é한";
        field.setSelectionRange(2, 2);
        field.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            inputType: "insertCompositionText",
            isComposing: true,
          }),
        );
      });
      assert.equal(await page.locator("[data-remote-preedit]").textContent(), "한");
      await page.evaluate(() =>
        document
          .querySelector("textarea.remote-keyboard-input")!
          .dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "한" })),
      );
      await page.keyboard.press("Meta+A");
      await page.evaluate(() => navigator.clipboard.writeText("browser plain paste\n🦊"));
      await page.keyboard.press("Meta+V");
      await page.waitForFunction(() =>
        (Reflect.get(window, "displayEditingSmoke") as DisplayEditingSmokeApi)
          .events()
          .some((event) => event.kind === "paste" && "text" in event),
      );
      await page.keyboard.press("Meta+C");
      await page.waitForFunction(
        async () => (await navigator.clipboard.readText()) === "fixture selection",
      );
      await page.evaluate(() =>
        navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob(["rich"], { type: "text/plain" }),
            "text/html": new Blob(["<b>rich</b>"], { type: "text/html" }),
          }),
        ]),
      );
      await page.keyboard.press("Meta+V");
      await page.waitForFunction(() =>
        document
          .querySelector(".phone-display__control")
          ?.textContent?.includes("support this edit"),
      );
      if (mac) {
        const box = await page.locator("canvas").boundingBox();
        assert.ok(box);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, {
          button: "right",
          clickCount: 2,
        });
      }
      const wire = await page.evaluate(() =>
        (Reflect.get(window, "displayEditingSmoke") as DisplayEditingSmokeApi).events(),
      );
      assert.equal(wire.filter((event) => event.kind === "key" && event.text === "e").length, 1);
      assert.ok(
        wire.some(
          (event) => event.kind === "edit" && event.edit.before === "e" && event.edit.text === "é",
        ),
      );
      assert.equal(
        wire.filter((event) => event.kind === "edit" && event.edit.text === "한").length,
        1,
      );
      assert.ok(wire.some((event) => event.kind === "command" && event.command === "selectAll"));
      assert.ok(
        wire.some(
          (event) =>
            event.kind === "paste" && "text" in event && event.text === "browser plain paste\n🦊",
        ),
      );
      assert.ok(wire.some((event) => event.kind === "copy"));
      assert.ok(
        wire.some(
          (event) =>
            event.kind === "paste" &&
            "items" in event &&
            event.items.some((item) => item.type === "text/html"),
        ),
      );
      if (mac)
        assert.ok(
          wire.some(
            (event) =>
              event.kind === "mouse" &&
              event.phase === "down" &&
              event.button === "right" &&
              event.clickCount === 2,
          ),
        );
      await page.screenshot({ path: path.join(directory, `${name}.png`) });
      await page.getByRole("button", { name: "Give back", exact: true }).click();
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLTextAreaElement>("textarea.remote-keyboard-input")?.disabled,
      );
      assert.deepEqual(errors, []);
      assert.deepEqual(host.failures, []);
      await writeFile(
        path.join(directory, `${name}-wire.json`),
        JSON.stringify(
          {
            wire,
            producer: host.sent,
            qualification:
              "Real Chromium DOM/clipboard and real Host display routes; scripted replacement/IME, fake producer/native application.",
          },
          null,
          2,
        ),
      );
      cases.push({ name, passed: true });
    } catch (error) {
      cases.push({ name, passed: false, error: String(error) });
      await page
        .screenshot({ path: path.join(directory, `${name}-failed.png`) })
        .catch(() => undefined);
    } finally {
      await page
        .evaluate(() =>
          (
            Reflect.get(window, "displayEditingSmoke") as DisplayEditingSmokeApi | undefined
          )?.close(),
        )
        .catch(() => undefined);
      await context.tracing.stop({ path: path.join(directory, `${name}-trace.zip`) });
      await context.close();
      await host.close();
    }
  }
} finally {
  await browser?.close();
  if (server.listening)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  await rm(output, { recursive: true, force: true });
  await writeFile(
    path.join(directory, "result.json"),
    JSON.stringify(
      { passed: cases.length === 2 && cases.every((item) => item.passed), cases },
      null,
      2,
    ),
  );
}
console.log(`Display browser journey: ${directory}/result.json`);
if (cases.length !== 2 || cases.some((item) => !item.passed)) process.exitCode = 1;
