/** Manual probe for headless interaction behavior. Run with `tsx scripts/detection/headless-functional.mts`. */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function main() {
  const userDataDir = await mkdtemp(join(tmpdir(), "headless-func-"));

  const args = [
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    "--disable-background-networking",
    "--disable-backgrounding-occluded-windows",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-hang-monitor",
    "--disable-popup-blocking",
    "--disable-prompt-on-repost",
    "--disable-sync",
    "--disable-infobars",
    "--disable-features=Translate",
    "--enable-features=NetworkService,NetworkServiceInProcess",
    "--password-store=basic",
    "--use-mock-keychain",
    `--user-data-dir=${userDataDir}`,
    "--headless=new",
    "--window-size=1440,900",
    "about:blank",
  ];

  const child = spawn(CHROME_PATH, args, {
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  child.unref();

  const deadline = Date.now() + 15_000;
  let port = 0;
  while (Date.now() < deadline) {
    const portFile = join(userDataDir, "DevToolsActivePort");
    if (existsSync(portFile)) {
      const lines = readFileSync(portFile, "utf8").split(/\r?\n/).filter(Boolean);
      port = parseInt(lines[0] ?? "", 10);
      if (port > 0) break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  if (!port) {
    console.error("Chrome headless failed to start");
    child.kill("SIGKILL");
    process.exit(1);
  }

  console.log(`Chrome headless launched on port ${port}`);
  const browser = await chromium.connectOverCDP({ endpointURL: `http://127.0.0.1:${port}` });
  const context = browser.contexts()[0]!;
  const page = context.pages()[0] ?? (await context.newPage());

  const results: { test: string; ok: boolean; detail: string }[] = [];

  try {
    await page.goto("https://example.com", { waitUntil: "networkidle", timeout: 15_000 });
    const title = await page.title();
    results.push({ test: "Navigate", ok: title.includes("Example"), detail: title });
  } catch (e: any) {
    results.push({ test: "Navigate", ok: false, detail: e.message });
  }

  try {
    await page.goto("https://example.com", { waitUntil: "networkidle", timeout: 15_000 });
    await page.mouse.move(300, 200);
    await new Promise((r) => setTimeout(r, 50));
    await page.mouse.down();
    await new Promise((r) => setTimeout(r, 60));
    await page.mouse.up();
    results.push({
      test: "Click (humanized pattern)",
      ok: true,
      detail: "mouse.move + down + delay + up works",
    });
  } catch (e: any) {
    results.push({ test: "Click (humanized pattern)", ok: false, detail: e.message });
  }

  try {
    await page.goto("https://www.google.com", { waitUntil: "networkidle", timeout: 15_000 });
    const searchBox = page.locator('textarea[name="q"], input[name="q"]');
    await searchBox.focus();
    for (const char of "hello") {
      await page.keyboard.down(char);
      await new Promise((r) => setTimeout(r, 50));
      await page.keyboard.up(char);
      await new Promise((r) => setTimeout(r, 40));
    }
    const value = await searchBox.inputValue();
    results.push({
      test: "Type (humanized pattern)",
      ok: value === "hello",
      detail: `Typed: "${value}"`,
    });
  } catch (e: any) {
    results.push({ test: "Type (humanized pattern)", ok: false, detail: e.message });
  }

  try {
    await page.goto("https://en.wikipedia.org/wiki/Main_Page", {
      waitUntil: "networkidle",
      timeout: 15_000,
    });
    const scrollBefore = await page.evaluate(() => window.scrollY);
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, 100);
      await new Promise((r) => setTimeout(r, 40));
    }
    await new Promise((r) => setTimeout(r, 200));
    const scrollAfter = await page.evaluate(() => window.scrollY);
    results.push({
      test: "Scroll (humanized pattern)",
      ok: scrollAfter > scrollBefore,
      detail: `Scrolled from ${scrollBefore} to ${scrollAfter}`,
    });
  } catch (e: any) {
    results.push({ test: "Scroll (humanized pattern)", ok: false, detail: e.message });
  }

  try {
    const buf = await page.screenshot();
    results.push({ test: "Screenshot", ok: buf.length > 0, detail: `${buf.length} bytes` });
  } catch (e: any) {
    results.push({ test: "Screenshot", ok: false, detail: e.message });
  }

  try {
    for (let i = 0; i < 10; i++) {
      await page.mouse.move(100 + i * 20, 100 + i * 10);
      await new Promise((r) => setTimeout(r, 16));
    }
    results.push({
      test: "Mouse path (10 intermediate moves)",
      ok: true,
      detail: "All moves dispatched",
    });
  } catch (e: any) {
    results.push({ test: "Mouse path (10 intermediate moves)", ok: false, detail: e.message });
  }

  console.log("\n=== Headless Functional Test Results ===");
  let allOk = true;
  for (const r of results) {
    const icon = r.ok ? "PASS" : "FAIL";
    console.log(`  [${icon}] ${r.test}: ${r.detail}`);
    if (!r.ok) allOk = false;
  }
  console.log(`\nAll passed: ${allOk}`);

  await browser.close();
  child.kill("SIGKILL");
  await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
}

main().catch(console.error);
