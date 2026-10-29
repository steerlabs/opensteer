import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "vite";
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright-core";
import type { RemoteEditingJourneyApi } from "./fixtures/remote-editing-viewer.js";
import { expectThat, finishJourney, journeyChecks } from "./mock-web-journey.js";

const artifacts =
  process.env.OPENSTEER_EDITING_WEB_EVIDENCE_DIR ?? path.join(tmpdir(), "opensteer-editing-web");
await mkdir(artifacts, { recursive: true });
const output = await mkdtemp(path.join(tmpdir(), "opensteer-editing-build-"));
const { checks, check, abort } = journeyChecks();
const host = process.env.OPENSTEER_EDITING_HOST_URL;
const fixture = path.resolve(import.meta.dirname, "fixtures/remote-editing-viewer.tsx");
const server = createServer((request, response) => {
  void (async () => {
    const name = request.url?.split("?")[0];
    if (name === "/viewer.js" || name === "/viewer.css") {
      response.setHeader("Content-Type", name.endsWith("js") ? "text/javascript" : "text/css");
      response.end(await readFile(path.join(output, name)));
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(html);
  })().catch((error) => {
    response.statusCode = 500;
    response.end(String(error));
  });
});
const html =
  '<!doctype html><html><head><link rel="stylesheet" href="/viewer.css"><style>body{margin:20px;font-family:sans-serif}.browser-canvas{position:relative;width:900px;height:600px;overflow:hidden;background:#eee}.browser-canvas canvas{width:100%;height:100%;object-fit:contain;object-position:top}#clipboard-probe{display:block;margin-top:15px;width:500px;height:70px}</style></head><body><div id="root"></div><textarea id="clipboard-probe" aria-label="Local clipboard probe"></textarea><script type="module" src="/viewer.js"></script></body></html>';
let browser: Browser | null = null;
try {
  await build({
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    root: path.resolve(import.meta.dirname, ".."),
    logLevel: "warn",
    build: {
      outDir: output,
      emptyOutDir: true,
      lib: { entry: fixture, formats: ["es"], fileName: () => "viewer.js", cssFileName: "viewer" },
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No journey server port.");
  const origin = `http://127.0.0.1:${address.port}`;
  const selected = Object.entries({ chromium, firefox, webkit }).filter(
    ([name]) =>
      !process.env.OPENSTEER_EDITING_BROWSERS ||
      process.env.OPENSTEER_EDITING_BROWSERS.split(",").includes(name),
  );
  if (!selected.length) throw new Error("No supported viewer browsers selected.");
  for (const [name, engine] of selected) {
    const dir = path.join(artifacts, name);
    await mkdir(dir, { recursive: true });
    let page: Page | null = null;
    let context: BrowserContext | null = null;
    try {
      browser = await engine.launch({ headless: true });
      context = await browser.newContext({
        viewport: { width: 1100, height: 900 },
        ...(process.env.OPENSTEER_EDITING_STORAGE_STATE
          ? { storageState: process.env.OPENSTEER_EDITING_STORAGE_STATE }
          : {}),
      });
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      await context.addInitScript(() => {
        Reflect.set(globalThis, "__name", (value: unknown) => value);
        const observations = { success: 0, failure: 0 };
        Reflect.set(window, "clipboardWrites", observations);
        if (!navigator.clipboard?.write) return;
        const write = navigator.clipboard.write.bind(navigator.clipboard);
        navigator.clipboard.write = (items) => {
          const result = write(items);
          void result.then(
            () => observations.success++,
            () => observations.failure++,
          );
          return result;
        };
      });
      if (host) {
        await context.route(`${host.replace(/\/$/u, "")}/__viewer-journey**`, (route) =>
          route.fulfill({ body: html, contentType: "text/html" }),
        );
        for (const asset of ["viewer.js", "viewer.css"])
          await context.route(`${host.replace(/\/$/u, "")}/${asset}`, async (route) =>
            route.fulfill({
              body: await readFile(path.join(output, asset)),
              contentType: asset.endsWith("js") ? "text/javascript" : "text/css",
            }),
          );
      }
      page = await context.newPage();
      const view = page;
      const url = new URL(host ? "/__viewer-journey" : origin, host ?? origin);
      if (host) {
        url.searchParams.set("mode", "host");
        for (const [key, value] of [
          ["session", process.env.OPENSTEER_EDITING_SESSION_ID],
          ["surface", process.env.OPENSTEER_EDITING_SURFACE_ID],
        ])
          if (value) url.searchParams.set(key!, value);
      }
      await view.goto(url.toString());
      await view.waitForFunction(
        () =>
          !!(
            Reflect.get(window, "remoteEditingJourney") as RemoteEditingJourneyApi | undefined
          )?.ready(),
      );
      const label = view.getByRole("textbox", { name: "Browser keyboard input" });
      await view.waitForFunction(
        () =>
          !document.querySelector<HTMLTextAreaElement>(
            'textarea[aria-label="Browser keyboard input"]',
          )?.disabled,
      );
      const platform = await view.evaluate(
        () => (Reflect.get(window, "remoteEditingJourney") as RemoteEditingJourneyApi).platform,
      );
      const primary = platform === "mac" || platform === "ios" ? "Meta" : "Control";
      await check(`${name}: 500 characters and key repeat have one producer`, async () => {
        await view.evaluate(() =>
          (Reflect.get(window, "remoteEditingJourney") as RemoteEditingJourneyApi).reset(),
        );
        await label.focus();
        const text = "abcXYZ123 ".repeat(50);
        await view.keyboard.type(text);
        await view.keyboard.down("x");
        await view.keyboard.down("x");
        await view.keyboard.up("x");
        const commands = await view.evaluate(() =>
          (Reflect.get(window, "remoteEditingJourney") as RemoteEditingJourneyApi).commands(),
        );
        const typed = commands
          .filter((command) => command.type === "input.key" && command.action === "down")
          .map((command) => (command.type === "input.key" ? (command.text ?? "") : ""))
          .join("");
        expectThat(
          { characters: typed.length },
          typed === text + "xx",
          "Printable text was duplicated, dropped or split into paste operations.",
        );
        expectThat(
          {},
          !commands.some(
            (command) => command.type === "clipboard.paste" || command.type === "input.text",
          ),
          "A key's echo became another text operation.",
        );
        if (host)
          await view.waitForFunction(
            async (expected) =>
              (await (
                Reflect.get(window, "remoteEditingJourney") as RemoteEditingJourneyApi
              ).value()) === expected,
            text + "xx",
          );
        await view.screenshot({ path: path.join(dir, "01-fast-typing.png") });
        return { characters: typed.length, mode: host ? "host" : "mock" };
      });
      await check(`${name}: replacements and repeated composition transactions`, async () => {
        await view.evaluate(() =>
          (Reflect.get(window, "remoteEditingJourney") as RemoteEditingJourneyApi).reset(),
        );
        await label.focus();
        await view.keyboard.type("e");
        await label.evaluate((element) => {
          const field = element as HTMLTextAreaElement;
          field.value = "é";
          field.setSelectionRange(1, 1);
          field.dispatchEvent(
            new InputEvent("input", {
              bubbles: true,
              inputType: "insertReplacementText",
              data: "é",
            }),
          );
        });
        await label.evaluate((element) => {
          const field = element as HTMLTextAreaElement;
          for (const value of ["é한", "é한한"]) {
            field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
            field.value = value;
            field.setSelectionRange(value.length, value.length);
            field.dispatchEvent(
              new InputEvent("input", {
                bubbles: true,
                inputType: "insertCompositionText",
                isComposing: true,
                data: "한",
              }),
            );
            field.dispatchEvent(
              new CompositionEvent("compositionend", { bubbles: true, data: "한" }),
            );
          }
        });
        const commands = await view.evaluate(() =>
          (Reflect.get(window, "remoteEditingJourney") as RemoteEditingJourneyApi).commands(),
        );
        const edits = commands.filter((command) => command.type === "input.text");
        expectThat(
          { edits: edits.length },
          edits.length === 3,
          "A replacement or composition transaction did not commit exactly once.",
        );
        const replacement = edits[0];
        expectThat(
          {},
          replacement?.type === "input.text" &&
            replacement.edit.before === "e" &&
            replacement.edit.after === "" &&
            replacement.edit.text === "é",
          "The replacement lost its exact verification strings.",
        );
        if (host)
          await view.waitForFunction(
            async () =>
              (await (
                Reflect.get(window, "remoteEditingJourney") as RemoteEditingJourneyApi
              ).value()) === "é한한",
          );
        await view.screenshot({ path: path.join(dir, "02-compositions.png") });
        return { commits: edits.length, nativeTrace: false };
      });
      await check(
        `${name}: a replacement preserves the native caret before further typing`,
        async () => {
          await view.evaluate(() =>
            (Reflect.get(window, "remoteEditingJourney") as RemoteEditingJourneyApi).reset(),
          );
          await label.focus();
          await view.keyboard.type("abc");
          await label.evaluate((element) => {
            const field = element as HTMLTextAreaElement;
            field.value = "aXc";
            field.setSelectionRange(2, 2);
            field.dispatchEvent(
              new InputEvent("input", {
                bubbles: true,
                inputType: "insertReplacementText",
                data: "X",
              }),
            );
          });
          await view.keyboard.type("y");
          const commands = await view.evaluate(() =>
            (Reflect.get(window, "remoteEditingJourney") as RemoteEditingJourneyApi).commands(),
          );
          const edit = commands.findIndex((command) => command.type === "input.text");
          const next = commands[edit + 1];
          expectThat(
            {},
            edit >= 0 && next?.type === "input.command" && next.command === "moveBackward",
            "The local caret moved inside the mirror without moving the remote caret.",
          );
          if (host)
            await view.waitForFunction(
              async () =>
                (await (
                  Reflect.get(window, "remoteEditingJourney") as RemoteEditingJourneyApi
                ).value()) === "aXyc",
            );
          return { caretMoves: 1 };
        },
      );
      await check(`${name}: platform command and 10 MiB clipboard parts`, async () => {
        await view.evaluate(() =>
          (Reflect.get(window, "remoteEditingJourney") as RemoteEditingJourneyApi).reset(),
        );
        await label.focus();
        await view.keyboard.press(`${primary}+a`);
        const result = await view.evaluate(() =>
          (Reflect.get(window, "remoteEditingJourney") as RemoteEditingJourneyApi).binaryPaste(
            10 * 1024 * 1024,
          ),
        );
        const commands = await view.evaluate(() =>
          (Reflect.get(window, "remoteEditingJourney") as RemoteEditingJourneyApi).commands(),
        );
        const parts = commands.filter((command) => command.type === "clipboard.part");
        expectThat(
          { parts: parts.length, result },
          parts.length === 20,
          "Binary clipboard data did not use the bounded part wire.",
        );
        expectThat(
          {},
          commands.some(
            (command) => command.type === "input.command" && command.command === "selectAll",
          ),
          "Primary+A did not become selectAll.",
        );
        return { parts: parts.length, result };
      });

      await check(`${name}: gesture copy, native local paste, cut and viewer paste`, async () => {
        await view.evaluate(() =>
          (Reflect.get(window, "remoteEditingJourney") as RemoteEditingJourneyApi).reset(),
        );
        await label.focus();
        await view.keyboard.type("clipboard fixture");
        await view.keyboard.press(`${primary}+a`);
        const writes = await view.evaluate(
          () => Reflect.get(window, "clipboardWrites") as { success: number; failure: number },
        );
        await view.keyboard.press(`${primary}+c`);
        await view.waitForFunction(
          (previous) =>
            (Reflect.get(window, "clipboardWrites") as { success: number }).success > previous,
          writes.success,
        );
        const probe = view.getByRole("textbox", { name: "Local clipboard probe" });
        await probe.fill("");
        await probe.focus();
        await view.keyboard.press(`${primary}+v`);
        const expected = host ? "clipboard fixture" : "remote clipboard fixture";
        await view.waitForFunction(
          (expected) =>
            document.querySelector<HTMLTextAreaElement>("#clipboard-probe")?.value === expected,
          expected,
        );
        await label.focus();
        await view.keyboard.press(`${primary}+a`);
        await view.keyboard.press(`${primary}+x`);
        await view.waitForFunction(
          (previous) =>
            (Reflect.get(window, "clipboardWrites") as { success: number }).success > previous,
          writes.success + 1,
        );
        if (host)
          await view.waitForFunction(
            async () =>
              (await (
                Reflect.get(window, "remoteEditingJourney") as RemoteEditingJourneyApi
              ).value()) === "",
          );
        await view.keyboard.press(`${primary}+v`);
        await view.waitForFunction(() =>
          (Reflect.get(window, "remoteEditingJourney") as RemoteEditingJourneyApi)
            .commands()
            .some((command) => command.type === "clipboard.paste-data"),
        );
        if (host)
          await view.waitForFunction(
            async (expected) =>
              (await (
                Reflect.get(window, "remoteEditingJourney") as RemoteEditingJourneyApi
              ).value()) === expected,
            expected,
          );
        await view.screenshot({ path: path.join(dir, "03-clipboard.png") });
        return { trustedPaste: true, copy: true, cut: true };
      });
      if (name === "chromium")
        await context.grantPermissions(["clipboard-read", "clipboard-write"], {
          origin: host ?? origin,
        });
      if (!host)
        await check(
          `${name}: empty copy preserves the local clipboard; page writes use activation`,
          async () => {
            await view.evaluate(() =>
              (Reflect.get(window, "remoteEditingJourney") as RemoteEditingJourneyApi).emptyCopy(),
            );
            await label.focus();
            await view.keyboard.press(`${primary}+c`);
            await view.waitForFunction(
              () =>
                ((
                  Reflect.get(window, "remoteEditingJourney") as RemoteEditingJourneyApi
                ).clipboardOutcomes().empty ?? 0) > 0,
            );
            const probe = view.getByRole("textbox", { name: "Local clipboard probe" });
            await probe.fill("");
            await probe.focus();
            await view.keyboard.press(`${primary}+v`);
            await view.waitForFunction(
              () =>
                document.querySelector<HTMLTextAreaElement>("#clipboard-probe")?.value ===
                "remote clipboard fixture",
            );
            const before = await view.evaluate(
              () => (Reflect.get(window, "clipboardWrites") as { success: number }).success,
            );
            await view.evaluate(() =>
              (
                Reflect.get(window, "remoteEditingJourney") as RemoteEditingJourneyApi
              ).pageWriteOnClick(),
            );
            await view.locator(".browser-canvas").click({ position: { x: 80, y: 320 } });
            await view.waitForFunction(
              (previous) =>
                (Reflect.get(window, "clipboardWrites") as { success: number }).success > previous,
              before,
            );
            await probe.fill("");
            await probe.focus();
            await view.keyboard.press(`${primary}+v`);
            await view.waitForFunction(
              () =>
                document.querySelector<HTMLTextAreaElement>("#clipboard-probe")?.value ===
                "page fixture",
            );
            return { emptyPreserved: true, attributedPageWrite: true };
          },
        );
      if (!host)
        await check(`${name}: runtime context menus and page-owned suppression`, async () => {
          await view
            .locator(".browser-canvas")
            .click({ button: "right", position: { x: 150, y: 150 } });
          await view.getByRole("menu", { name: "Page actions" }).waitFor();
          await view.getByRole("menuitem", { name: "Open Link in New Tab" }).click();
          const commands = await view.evaluate(() =>
            (Reflect.get(window, "remoteEditingJourney") as RemoteEditingJourneyApi).commands(),
          );
          expectThat(
            {},
            !commands.some((command) => command.type === "surface.open"),
            "Opening a link bypassed the tab domain mutation path.",
          );
          await view.waitForFunction(() =>
            (Reflect.get(window, "remoteEditingJourney") as RemoteEditingJourneyApi)
              .openedLinks()
              .includes("https://example.test/from-menu"),
          );
          await view.evaluate(() =>
            (Reflect.get(window, "remoteEditingJourney") as RemoteEditingJourneyApi).customMenu(
              true,
            ),
          );
          await view
            .locator(".browser-canvas")
            .click({ button: "right", position: { x: 150, y: 150 } });
          expectThat(
            {},
            (await view.getByRole("menu").count()) === 0,
            "A page-owned menu was replaced by the viewer menu.",
          );
          await view.screenshot({ path: path.join(dir, "03-context-menu.png") });
          return { pageOwnedMenu: true };
        });
      await check(`${name}: sensitive proxy follows field context`, async () => {
        await view.evaluate(() =>
          (Reflect.get(window, "remoteEditingJourney") as RemoteEditingJourneyApi).sensitive(true),
        );
        await view.locator('input[type="password"][aria-label="Browser keyboard input"]').waitFor();
        await view.screenshot({ path: path.join(dir, "04-sensitive.png") });
        return { proxy: "password" };
      });
      await view.evaluate(() =>
        (Reflect.get(window, "remoteEditingJourney") as RemoteEditingJourneyApi).close(),
      );
      await context.tracing.stop({ path: path.join(dir, "trace.zip") });
      await context.close();
    } catch (error) {
      abort(new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`));
      if (page && !page.isClosed()) await page.screenshot({ path: path.join(dir, "failure.png") });
      if (context) await context.tracing.stop({ path: path.join(dir, "trace.zip") });
    } finally {
      if (browser) await browser.close();
      browser = null;
    }
  }
} catch (error) {
  abort(error);
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(output, { recursive: true, force: true });
  await writeFile(
    path.join(artifacts, "certification.json"),
    JSON.stringify(
      {
        mode: host ? "host" : "mock",
        nativeTraceCertification: "outstanding",
        browsers: ["chromium", "firefox", "webkit"],
      },
      null,
      2,
    ),
  );
  await finishJourney(artifacts, checks);
}
