/** Manual bot-detection probe. Run with `node --import tsx scripts/detection/detect-test.mts`. */

import { chromium } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TIMEOUT = 20_000;

const CHROME_ARGS = [
  "--remote-debugging-port=0",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-blink-features=AutomationControlled",
];

interface TestResult {
  site: string;
  passed: boolean;
  details: string;
}

async function launchChrome(
  userDataDir: string,
): Promise<{ endpoint: string; pid: number; kill: () => void }> {
  const args = [
    ...CHROME_ARGS,
    `--user-data-dir=${userDataDir}`,
    "--window-size=1440,1050",
    "about:blank",
  ];

  const child = spawn(CHROME_PATH, args, {
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  child.unref();

  const stderrLines: string[] = [];
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => stderrLines.push(chunk));

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const portFile = join(userDataDir, "DevToolsActivePort");
    if (existsSync(portFile)) {
      const lines = readFileSync(portFile, "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const port = parseInt(lines[0] ?? "", 10);
      if (port > 0) {
        try {
          const resp = await fetch(`http://127.0.0.1:${port}/json/version`, {
            signal: AbortSignal.timeout(2000),
          });
          if (resp.ok) {
            const wsPath = lines[1] ?? "/devtools/browser";
            return {
              endpoint: `http://127.0.0.1:${port}`,
              pid: child.pid ?? 0,
              kill: () => {
                try {
                  process.kill(child.pid!, "SIGKILL");
                } catch {}
              },
            };
          }
        } catch {}
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  child.kill("SIGKILL");
  throw new Error(`Chrome failed to start. stderr: ${stderrLines.join("")}`);
}

async function testSannysoft(page: any): Promise<TestResult> {
  await page.goto("https://bot.sannysoft.com/", { waitUntil: "networkidle", timeout: TIMEOUT });
  await new Promise((r) => setTimeout(r, 3000));

  const results = await page.evaluate(() => {
    const rows = document.querySelectorAll("table#fp-table tr, table#advanced-table tr");
    const failures: string[] = [];
    const passes: string[] = [];
    rows.forEach((row: Element) => {
      const cells = row.querySelectorAll("td");
      if (cells.length >= 2) {
        const name = cells[0]?.textContent?.trim() ?? "";
        const cell = cells[cells.length - 1] as HTMLElement;
        const bg = cell?.style?.backgroundColor ?? "";
        if (bg.includes("red") || bg.includes("rgb(255") || cell?.classList?.contains("failed")) {
          failures.push(name);
        } else if (name) {
          passes.push(name);
        }
      }
    });
    return { failures, passes, total: passes.length + failures.length };
  });

  const passed = results.failures.length === 0;
  return {
    site: "bot.sannysoft.com",
    passed,
    details: passed
      ? `All ${results.total} tests passed`
      : `Failed: ${results.failures.join(", ")} (${results.failures.length}/${results.total})`,
  };
}

async function testBrowserleaks(page: any): Promise<TestResult> {
  await page.goto("https://browserleaks.com/javascript", {
    waitUntil: "networkidle",
    timeout: TIMEOUT,
  });
  await new Promise((r) => setTimeout(r, 3000));

  const results = await page.evaluate(() => {
    const text = document.body?.innerText ?? "";
    const issues: string[] = [];
    if (/webdriver.*true/i.test(text)) issues.push("webdriver=true");
    if (/HeadlessChrome/i.test(navigator.userAgent)) issues.push("HeadlessChrome in UA");
    return { issues, userAgent: navigator.userAgent };
  });

  return {
    site: "browserleaks.com/javascript",
    passed: results.issues.length === 0,
    details:
      results.issues.length === 0
        ? `No automation signals detected. UA: ${results.userAgent.slice(0, 80)}`
        : `Issues: ${results.issues.join(", ")}`,
  };
}

async function testCoreSignals(page: any): Promise<TestResult> {
  await page.goto("https://example.com", { waitUntil: "networkidle", timeout: TIMEOUT });

  const results = await page.evaluate(() => {
    const issues: string[] = [];

    // 1. navigator.webdriver
    if ((navigator as any).webdriver === true) issues.push("webdriver=true");

    // 2. Plugins
    if (navigator.plugins.length === 0) issues.push("plugins.length=0");

    // 3. Languages
    if (!navigator.languages || navigator.languages.length === 0) issues.push("no languages");

    // 4. Chrome object
    if (!(window as any).chrome) issues.push("no window.chrome");

    // 5. Notification permission
    if (typeof Notification !== "undefined" && Notification.permission === "denied") {
      issues.push("Notification.permission=denied");
    }

    // 6. outerHeight vs innerHeight
    if (window.outerHeight === window.innerHeight && window.outerHeight > 0) {
      issues.push("outerHeight===innerHeight (no browser chrome)");
    }
    if (window.outerWidth === 0 || window.outerHeight === 0) {
      issues.push("outerWidth/Height=0");
    }

    // 7. User agent
    if (/HeadlessChrome/i.test(navigator.userAgent)) issues.push("HeadlessChrome in UA");

    // 8. Connection API
    if ((navigator as any).connection) {
      const conn = (navigator as any).connection;
      if (conn.rtt === 0) issues.push("connection.rtt=0");
    }

    // 9. Media devices
    // Can't test async here but check API exists
    if (!navigator.mediaDevices) issues.push("no mediaDevices API");

    // 10. Hardware concurrency
    if (navigator.hardwareConcurrency === 0) issues.push("hardwareConcurrency=0");

    // 11. DeviceMemory
    if ((navigator as any).deviceMemory === 0) issues.push("deviceMemory=0");

    // 12. WebGL
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl");
    if (gl) {
      const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
      if (debugInfo) {
        const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
        if (/SwiftShader/i.test(renderer)) issues.push("WebGL=SwiftShader (headless)");
      }
    }

    // 13. CDP Runtime.enable leak test
    let cdpLeaked = false;
    try {
      const err = new Error("test");
      let getterCalled = false;
      Object.defineProperty(err, "stack", {
        get() {
          getterCalled = true;
          return "";
        },
        configurable: true,
      });
      console.debug(err);
      if (getterCalled) cdpLeaked = true;
    } catch {}
    if (cdpLeaked) issues.push("CDP Runtime.enable leak detected");

    return { issues };
  });

  return {
    site: "core-signals (example.com)",
    passed: results.issues.length === 0,
    details:
      results.issues.length === 0
        ? "All core signals clean"
        : `Issues: ${results.issues.join(", ")}`,
  };
}

// ---------------------------------------------------------------------------
// Test: intoli.com/blog/not-possible (Intoli detection test)
// ---------------------------------------------------------------------------

async function testIntoli(page: any): Promise<TestResult> {
  try {
    await page.goto("https://intoli.com/blog/not-possible/", {
      waitUntil: "networkidle",
      timeout: TIMEOUT,
    });
    await new Promise((r) => setTimeout(r, 2000));
    return { site: "intoli.com", passed: true, details: "Page loaded without block" };
  } catch {
    return { site: "intoli.com", passed: false, details: "Failed to load or blocked" };
  }
}

// ---------------------------------------------------------------------------
// Test: nowsecure.nl (Cloudflare challenge page)
// ---------------------------------------------------------------------------

async function testNowSecure(page: any): Promise<TestResult> {
  try {
    await page.goto("https://nowsecure.nl/", { waitUntil: "domcontentloaded", timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 8000));
    const url = page.url();
    const title = await page.title();
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) ?? "");
    const blocked =
      title.toLowerCase().includes("just a moment") ||
      bodyText.includes("Checking if the site connection is secure");
    return {
      site: "nowsecure.nl (Cloudflare)",
      passed: !blocked,
      details: !blocked ? `Passed: ${title}` : `Blocked: ${title} (${url})`,
    };
  } catch (err: any) {
    return {
      site: "nowsecure.nl (Cloudflare)",
      passed: false,
      details: `Error: ${err.message?.slice(0, 100)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Test: Various Cloudflare-protected sites
// ---------------------------------------------------------------------------

async function testCloudflare(page: any, url: string, label: string): Promise<TestResult> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
    await new Promise((r) => setTimeout(r, 6000));
    const title = await page.title();
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) ?? "");
    const blocked =
      title.toLowerCase().includes("just a moment") ||
      title.toLowerCase().includes("attention required") ||
      bodyText.includes("Checking if the site connection is secure") ||
      bodyText.includes("Enable JavaScript and cookies");
    return {
      site: label,
      passed: !blocked,
      details: blocked ? `Blocked by Cloudflare: "${title}"` : `Passed: "${title}"`,
    };
  } catch (err: any) {
    return { site: label, passed: false, details: `Error: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Test: fingerprint.com (formerly FingerprintJS)
// ---------------------------------------------------------------------------

async function testFingerprint(page: any): Promise<TestResult> {
  try {
    await page.goto("https://fingerprint.com/products/bot-detection/", {
      waitUntil: "networkidle",
      timeout: TIMEOUT,
    });
    await new Promise((r) => setTimeout(r, 3000));
    const title = await page.title();
    return { site: "fingerprint.com", passed: true, details: `Loaded: ${title}` };
  } catch (err: any) {
    return { site: "fingerprint.com", passed: false, details: `Error: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Test: creepjs (advanced fingerprint analysis)
// ---------------------------------------------------------------------------

async function testCreepJS(page: any): Promise<TestResult> {
  try {
    await page.goto("https://abrahamjuliot.github.io/creepjs/", {
      waitUntil: "networkidle",
      timeout: TIMEOUT,
    });
    await new Promise((r) => setTimeout(r, 8000));

    const results = await page.evaluate(() => {
      const trustEl = document.querySelector(".visitor-info .grade") as HTMLElement;
      const trust = trustEl?.textContent?.trim() ?? "unknown";
      const botEl = document.querySelector('[class*="bot"]') as HTMLElement;
      const botText = botEl?.textContent?.trim() ?? "";
      return { trust, botText, title: document.title };
    });

    const hasBotFlag =
      results.botText.toLowerCase().includes("bot") || results.trust.toLowerCase().includes("f");
    return {
      site: "creepjs",
      passed: !hasBotFlag,
      details: `Trust: ${results.trust}, Bot: ${results.botText || "none"}`,
    };
  } catch (err: any) {
    return { site: "creepjs", passed: false, details: `Error: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const userDataDir = await mkdtemp(join(tmpdir(), "detect-test-"));
  console.log(`\n=== Bot Detection Test Suite ===`);
  console.log(`Chrome: ${CHROME_PATH}`);
  console.log(`User data dir: ${userDataDir}`);
  console.log(`Flags: ${CHROME_ARGS.join(" ")}\n`);

  let chrome: { endpoint: string; pid: number; kill: () => void } | undefined;
  let browser: any;

  try {
    chrome = await launchChrome(userDataDir);
    console.log(`Chrome launched (pid ${chrome.pid}), endpoint: ${chrome.endpoint}`);

    browser = await chromium.connectOverCDP({ endpointURL: chrome.endpoint });
    const context = browser.contexts()[0]!;
    const page = context.pages()[0] ?? (await context.newPage());

    // Inject the CDP Runtime.enable leak defense (same as Opensteer does natively).
    await context.addInitScript({
      content: `(() => {
  if (navigator.webdriver === true) {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      configurable: true,
      get: function() { return false; },
    });
  }
  var _wrap = function(name) {
    var orig = console[name];
    if (typeof orig !== 'function') return;
    console[name] = new Proxy(orig, {
      apply: function(target, thisArg, args) {
        for (var i = 0; i < args.length; i++) {
          if (args[i] instanceof Error) {
            var d = Object.getOwnPropertyDescriptor(args[i], 'stack');
            if (d && typeof d.get === 'function') return undefined;
          }
        }
        return Reflect.apply(target, thisArg, args);
      },
    });
  };
  ['debug', 'log', 'info', 'error', 'warn', 'trace', 'dir'].forEach(_wrap);
})();`,
    });

    const results: TestResult[] = [];

    // Core signals test
    console.log("Testing: core-signals...");
    results.push(await testCoreSignals(page));

    // Sannysoft
    console.log("Testing: bot.sannysoft.com...");
    results.push(await testSannysoft(page));

    // Browserleaks
    console.log("Testing: browserleaks.com...");
    results.push(await testBrowserleaks(page));

    // CreepJS
    console.log("Testing: creepjs...");
    results.push(await testCreepJS(page));

    // Intoli
    console.log("Testing: intoli.com...");
    results.push(await testIntoli(page));

    // Fingerprint.com
    console.log("Testing: fingerprint.com...");
    results.push(await testFingerprint(page));

    // NowSecure (Cloudflare)
    console.log("Testing: nowsecure.nl (Cloudflare)...");
    results.push(await testNowSecure(page));

    // Various Cloudflare sites
    const cfSites = [
      ["https://www.g2.com/", "g2.com (CF)"],
      ["https://www.zillow.com/", "zillow.com (CF)"],
      ["https://discord.com/", "discord.com (CF)"],
      ["https://www.crunchbase.com/", "crunchbase.com (CF)"],
      ["https://www.glassdoor.com/", "glassdoor.com (CF)"],
    ] as const;

    for (const [url, label] of cfSites) {
      console.log(`Testing: ${label}...`);
      results.push(await testCloudflare(page, url, label));
    }

    // Indeed — uses Turnstile interactive checkbox. Try clicking it.
    console.log("Testing: indeed.com (Turnstile checkbox)...");
    results.push(
      await (async (): Promise<TestResult> => {
        try {
          await page.goto("https://www.indeed.com/", {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
          });
          await new Promise((r) => setTimeout(r, 3000));
          const title0 = await page.title();
          if (!title0.toLowerCase().includes("just a moment")) {
            return {
              site: "indeed.com (Turnstile)",
              passed: true,
              details: `No challenge: "${title0}"`,
            };
          }
          // Try to find and click the Turnstile checkbox
          const clicked = await page.evaluate(() => {
            const inputs = document.querySelectorAll("input[type='checkbox']");
            for (const inp of inputs) {
              (inp as HTMLElement).click();
              return true;
            }
            // Try clicking the label area
            const labels = document.querySelectorAll("label");
            for (const label of labels) {
              if (label.textContent?.includes("Verify") || label.textContent?.includes("human")) {
                label.click();
                return true;
              }
            }
            return false;
          });
          await new Promise((r) => setTimeout(r, 8000));
          const title = await page.title();
          const blocked = title.toLowerCase().includes("just a moment");
          return {
            site: "indeed.com (Turnstile)",
            passed: !blocked,
            details: blocked
              ? `Interactive Turnstile challenge (checkbox) - requires click, not a detection issue`
              : `Passed after checkbox click: "${title}"`,
          };
        } catch (err: any) {
          return {
            site: "indeed.com (Turnstile)",
            passed: false,
            details: `Error: ${err.message?.slice(0, 100)}`,
          };
        }
      })(),
    );

    // More sites — mix of protection levels
    const moreSites = [
      "https://www.nike.com/",
      "https://www.ticketmaster.com/",
      "https://www.linkedin.com/",
      "https://store.steampowered.com/",
      "https://www.walmart.com/",
      "https://www.target.com/",
      "https://www.bestbuy.com/",
      "https://www.booking.com/",
      "https://www.etsy.com/",
      "https://www.airbnb.com/",
      "https://www.amazon.com/",
      "https://www.ebay.com/",
      "https://www.reddit.com/",
      "https://www.twitch.tv/",
      "https://www.spotify.com/",
      "https://www.paypal.com/",
      "https://www.stripe.com/",
    ];

    for (const url of moreSites) {
      const label = new URL(url).hostname;
      console.log(`Testing: ${label}...`);
      results.push(await testCloudflare(page, url, label));
    }

    // Print report
    console.log("\n" + "=".repeat(70));
    console.log("RESULTS");
    console.log("=".repeat(70));

    let passed = 0;
    let failed = 0;
    for (const r of results) {
      const icon = r.passed ? "PASS" : "FAIL";
      console.log(`  [${icon}] ${r.site}`);
      console.log(`         ${r.details}`);
      if (r.passed) passed++;
      else failed++;
    }

    console.log("\n" + "-".repeat(70));
    console.log(
      `Total: ${results.length} | Passed: ${passed} | Failed: ${failed} | Rate: ${Math.round((passed / results.length) * 100)}%`,
    );
    console.log("-".repeat(70) + "\n");
  } finally {
    try {
      await browser?.close();
    } catch {}
    chrome?.kill();
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
