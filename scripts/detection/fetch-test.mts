/** Manual probe for browser-routed fetch behavior. */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

interface TestResult {
  test: string;
  ok: boolean;
  detail: string;
}

async function launchChrome(userDataDir: string) {
  const child = spawn(
    CHROME_PATH,
    [
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
      `--user-data-dir=${userDataDir}`,
      "--window-size=1440,900",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"], detached: true },
  );
  child.unref();

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const portFile = join(userDataDir, "DevToolsActivePort");
    if (existsSync(portFile)) {
      const lines = readFileSync(portFile, "utf8").split(/\r?\n/).filter(Boolean);
      const port = parseInt(lines[0] ?? "", 10);
      if (port > 0) {
        try {
          await fetch(`http://127.0.0.1:${port}/json/version`, {
            signal: AbortSignal.timeout(2000),
          });
        } catch {
          await new Promise((r) => setTimeout(r, 100));
          continue;
        }
        return {
          port,
          kill: () => {
            try {
              process.kill(child.pid!, "SIGKILL");
            } catch {}
          },
        };
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill("SIGKILL");
  throw new Error("Chrome failed to start");
}

async function browserFetch(
  page: any,
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<{
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
  url: string;
  redirected: boolean;
}> {
  return page.evaluate(
    async (opts: {
      url: string;
      method: string;
      headers: [string, string][];
      body: string | undefined;
    }) => {
      const headers = new Headers();
      for (const [name, value] of opts.headers) {
        headers.append(name, value);
      }
      const response = await fetch(opts.url, {
        method: opts.method,
        headers,
        credentials: "include",
        ...(opts.body === undefined ? {} : { body: opts.body }),
      });
      const body = await response.text();
      const responseHeaders: [string, string][] = [];
      response.headers.forEach((value: string, name: string) => {
        responseHeaders.push([name, value]);
      });
      return {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        body: body.slice(0, 5000),
        url: response.url,
        redirected: response.redirected,
      };
    },
    {
      url,
      method: options.method ?? "GET",
      headers: Object.entries(options.headers ?? {}),
      body: options.body,
    },
  );
}

async function main() {
  const userDataDir = await mkdtemp(join(tmpdir(), "fetch-test-"));
  const chrome = await launchChrome(userDataDir);
  const browser = await chromium.connectOverCDP({ endpointURL: `http://127.0.0.1:${chrome.port}` });
  const context = browser.contexts()[0]!;
  const page = context.pages()[0] ?? (await context.newPage());

  const results: TestResult[] = [];

  try {
    await page.goto("https://httpbin.org/", { waitUntil: "networkidle", timeout: 15_000 });
    const res = await browserFetch(page, "https://httpbin.org/get");
    const json = JSON.parse(res.body);
    const hasUA = json.headers?.["User-Agent"]?.includes("Chrome");
    results.push({
      test: "Same-origin GET (httpbin.org/get)",
      ok: res.status === 200 && hasUA,
      detail: `status=${res.status}, UA contains Chrome: ${hasUA}`,
    });
  } catch (e: any) {
    results.push({ test: "Same-origin GET", ok: false, detail: e.message });
  }

  try {
    const res = await browserFetch(page, "https://httpbin.org/post", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    const json = JSON.parse(res.body);
    const bodyMatch = json.json?.hello === "world";
    results.push({
      test: "POST with JSON body",
      ok: res.status === 200 && bodyMatch,
      detail: `status=${res.status}, body echoed: ${bodyMatch}`,
    });
  } catch (e: any) {
    results.push({ test: "POST with JSON body", ok: false, detail: e.message });
  }

  try {
    const res = await browserFetch(page, "https://httpbin.org/headers", {
      headers: { "X-Custom-Test": "opensteer-test-123" },
    });
    const json = JSON.parse(res.body);
    const customHeader = json.headers?.["X-Custom-Test"];
    results.push({
      test: "Custom headers",
      ok: customHeader === "opensteer-test-123",
      detail: `X-Custom-Test: ${customHeader}`,
    });
  } catch (e: any) {
    results.push({ test: "Custom headers", ok: false, detail: e.message });
  }

  try {
    await page.goto("https://httpbin.org/cookies/set?testcookie=abc123", {
      waitUntil: "networkidle",
      timeout: 15_000,
    });
    const res = await browserFetch(page, "https://httpbin.org/cookies");
    const json = JSON.parse(res.body);
    const cookieValue = json.cookies?.testcookie;
    results.push({
      test: "Cookies included in fetch",
      ok: cookieValue === "abc123",
      detail: `testcookie: ${cookieValue}`,
    });
  } catch (e: any) {
    results.push({ test: "Cookies included in fetch", ok: false, detail: e.message });
  }

  try {
    const res = await browserFetch(
      page,
      "https://httpbin.org/response-headers?X-Test-Header=hello",
    );
    const testHeader = res.headers.find(([n]) => n.toLowerCase() === "x-test-header");
    results.push({
      test: "Response headers parsed",
      ok: testHeader?.[1] === "hello",
      detail: `X-Test-Header: ${testHeader?.[1]}`,
    });
  } catch (e: any) {
    results.push({ test: "Response headers parsed", ok: false, detail: e.message });
  }

  // Test 6: Redirect following
  try {
    const res = await browserFetch(page, "https://httpbin.org/redirect/1");
    results.push({
      test: "Redirect following",
      ok: res.redirected && res.url.includes("/get"),
      detail: `redirected=${res.redirected}, finalUrl=${res.url}`,
    });
  } catch (e: any) {
    results.push({ test: "Redirect following", ok: false, detail: e.message });
  }

  // Test 7: 404 status
  try {
    const res = await browserFetch(page, "https://httpbin.org/status/404");
    results.push({
      test: "404 status handled",
      ok: res.status === 404,
      detail: `status=${res.status}`,
    });
  } catch (e: any) {
    results.push({ test: "404 status handled", ok: false, detail: e.message });
  }

  // Test 8: Real website API — fetch GitHub API (cross-origin, tests CORS)
  try {
    await page.goto("https://github.com/", { waitUntil: "networkidle", timeout: 15_000 });
    // Same-origin fetch to GitHub's API
    const res = await browserFetch(page, "https://github.com/manifest.json");
    results.push({
      test: "Real website same-origin fetch (github.com)",
      ok: res.status === 200,
      detail: `status=${res.status}, body length=${res.body.length}`,
    });
  } catch (e: any) {
    results.push({ test: "Real website same-origin fetch", ok: false, detail: e.message });
  }

  // Test 9: Verify browser User-Agent is sent (not Node.js)
  try {
    await page.goto("https://httpbin.org/", { waitUntil: "networkidle", timeout: 15_000 });
    const res = await browserFetch(page, "https://httpbin.org/user-agent");
    const json = JSON.parse(res.body);
    const ua = json["user-agent"] ?? "";
    const isChrome = ua.includes("Chrome/") && !ua.includes("Node") && !ua.includes("node");
    results.push({
      test: "User-Agent is Chrome (not Node.js)",
      ok: isChrome,
      detail: `UA: ${ua.slice(0, 100)}`,
    });
  } catch (e: any) {
    results.push({ test: "User-Agent is Chrome", ok: false, detail: e.message });
  }

  // Print results
  console.log("\n=== Browser-Routed Fetch Test Results ===\n");
  let allOk = true;
  for (const r of results) {
    const icon = r.ok ? "PASS" : "FAIL";
    console.log(`  [${icon}] ${r.test}`);
    console.log(`         ${r.detail}`);
    if (!r.ok) allOk = false;
  }
  console.log(`\n  All passed: ${allOk}\n`);

  await browser.close();
  chrome.kill();
  await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
}

main().catch(console.error);
