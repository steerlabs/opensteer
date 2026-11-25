import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * G1 holds only if every browser the Home owns knows the Home's addresses: every attach ticket
 * carries them and every browser context of the Home's own browsers is given them and refuses
 * them. This walks the production sources for every place one is created, so a new one cannot be
 * added without them (M1: Electron's saved profiles; M2: the pool's tickets).
 */
const root = path.resolve(import.meta.dirname, "..");

function sources(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!["node_modules", "dist", "scripts"].includes(entry.name))
        found.push(...sources(relative));
    } else if (
      /\.tsx?$/u.test(entry.name) &&
      !/\.(?:test|test-support|integration\.test)\.tsx?$/u.test(entry.name)
    )
      found.push(relative);
  }
  return found;
}

const files = ["apps/host/src", "apps/desktop/src", "apps/browser-runtime/src", "packages"]
  .flatMap(sources)
  .map((file) => ({ file, text: readFileSync(path.join(root, file), "utf8") }));

/** The argument text of each `new Name(` call, to its matching parenthesis. */
function constructions(text: string, name: string): string[] {
  const found: string[] = [];
  let at = text.indexOf(`new ${name}(`);
  while (at >= 0) {
    let depth = 0;
    let end = at + `new ${name}`.length;
    for (; end < text.length; end += 1) {
      if (text[end] === "(") depth += 1;
      else if (text[end] === ")" && --depth === 0) break;
    }
    found.push(text.slice(at, end + 1));
    at = text.indexOf(`new ${name}(`, end);
  }
  return found;
}

describe("every browser the Home owns is given the Home's addresses (G1)", () => {
  it("signs no attach ticket without them", () => {
    const signers = files.flatMap(({ file, text }) =>
      constructions(text, "BrowserAttachTicketSigner").map((call) => ({ file, call })),
    );
    expect(signers.length).toBeGreaterThanOrEqual(2);
    expect(signers.filter(({ call }) => !call.includes("homeAddresses"))).toEqual([]);
  });

  it("creates no Electron browser context without them", () => {
    const contexts = files.flatMap(({ file, text }) =>
      constructions(text, "ElectronBrowserContext").map((call) => ({ file, call })),
    );
    expect(contexts.length).toBeGreaterThanOrEqual(2);
    expect(contexts.filter(({ call }) => !call.includes("setHomeAddresses"))).toEqual([]);
  });

  it("launches no Chromium browser without its rule, and creates no other context unsorted", () => {
    const launcher = files.find(
      ({ file }) => file === "apps/browser-runtime/src/browser/playwright-launcher.ts",
    )!.text;
    expect(constructions(launcher, "PlaywrightLaunchedBrowser").length).toBe(
      launcher.split(".refuseHomeAddresses(").length - 1,
    );
    // Every Playwright context: the two a launched browser wraps (its rule above), and those that
    // load no page of the web, each with why.
    const sorted: Record<string, string> = {
      "apps/browser-runtime/src/browser/playwright-launcher.ts:const context = await browser.newContext();":
        "the passkey security probe: one blank page, closed at once",
      "apps/browser-runtime/src/browser/playwright-launcher.ts:const probe = await browser.newContext();":
        "the user-agent probe: one blank page, closed at once",
      "apps/browser-runtime/src/browser/playwright-launcher.ts:const context = await browser.newContext({":
        "a Guest browser: wrapped by PlaywrightLaunchedBrowser, which refuses the Home",
      "apps/browser-runtime/src/browser/playwright-launcher.ts:const context = await chromium.launchPersistentContext(":
        "a native profile: wrapped by PlaywrightLaunchedBrowser, which refuses the Home",
      "apps/browser-runtime/src/browser/chromium-clipboard.ts:const context = await browser.newContext({":
        "the private clipboard: every request is answered by its own route, none leaves it",
    };
    // The computer-use REPL's `runtime.newContext()` is a script VM, not a browser.
    const sites = files
      .filter(({ file }) => !file.startsWith("apps/host/src/computer-use/"))
      .flatMap(({ file, text }) =>
        text
          .split("\n")
          .filter((line) => /\.newContext\(|launchPersistentContext\(/u.test(line))
          .map((line) => `${file}:${line.trim()}`),
      );
    expect(sites.filter((site) => !(site in sorted))).toEqual([]);
    expect(Object.keys(sorted).filter((site) => !sites.includes(site))).toEqual([]);
  });
});
