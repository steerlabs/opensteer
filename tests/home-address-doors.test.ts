import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

/**
 * Every place the router, the runtime's controller, the Home and the Mac's browser ask whether an
 * address is an extension's also asks whether it is this Home's (the same doors, `isExtensionUrl`
 * and `ThisHomeAddressSet`), unless the site is listed here with why it is not a door for the Home.
 */
const files = [
  "packages/browser-core/src/portable-session-cdp-router.ts",
  "packages/browser-runtime-core/src/browser/controller.ts",
  "apps/host/src/browser/browser-service.ts",
  "apps/host/src/browser/chrome-shared-tabs.ts",
  "apps/host/src/tabs/tab-authority.ts",
  "packages/database/src/resource-access.ts",
  "apps/desktop/src/browser/electron-browser-launcher.ts",
  "apps/desktop/src/browser/browser-session-policy.ts",
];

const extensionTest = /\b(?:isExtensionUrl|mentionsExtensionUrl|mentionsChromeExtensionUrl)\(/u;
/** What asking the Home rule looks like at a site. */
const homeTest =
  /#home\b|homeAddresses|isHomeAddress|includesReported|\.includes\(details\.url\)|#hiddenFromAgent|agentRequestToHome|#agentOnHome|mentionsHiddenUrl|authorizePageAddress|onHome/u;
/** Lines around a site that belong to the same statement or the branch just before it. */
const reach = 6;

const exempt: readonly { file: string; line: string; reason: string }[] = [
  {
    file: "packages/browser-core/src/portable-session-cdp-router.ts",
    line: "if (!state.connection && connection && hiddenId && isExtensionUrl(rawInfo.url))",
    reason:
      "Bookkeeping of a connection's channel on a state that is not a connection's; the Home's hiding is the projection's, for every state.",
  },
  {
    file: "apps/desktop/src/browser/electron-browser-launcher.ts",
    line: 'const opener = isExtensionUrl(details.url) ? windowOpenerVerdict(contents, details) : "allow";',
    reason:
      "Who may open an extension's window; a window to this Home from an agent's page is denied in the same handler just before.",
  },
  {
    file: "apps/desktop/src/browser/electron-browser-launcher.ts",
    line: "if (!isExtensionUrl(url)) return true;",
    reason: "mayPageReachExtension: Chrome's web-accessible-resource rule, about extensions only.",
  },
  {
    file: "apps/desktop/src/browser/electron-browser-launcher.ts",
    line: "if (!allowExtensions && isExtensionUrl(value)) return false;",
    reason:
      "isAllowedBrowserNavigation: which schemes a page may load; this Home's addresses are http(s), refused by agent control (#agentOnHome, the session policy).",
  },
  {
    file: "apps/desktop/src/browser/browser-session-policy.ts",
    line: "if (details.webContentsId === undefined || !isExtensionUrl(details.redirectURL)) return;",
    reason:
      "Records a redirect into an extension for its own rule; a redirect to this Home is refused at onBeforeRequest and will-redirect.",
  },
  {
    file: "apps/desktop/src/browser/browser-session-policy.ts",
    line: "isExtensionUrl(parsed.pathname)",
    reason: "classifyBrowserRequest unwraps blob:/filesystem: to name an extension's resource.",
  },
];

function sites() {
  return files.flatMap((file) => {
    const lines = readFileSync(path.join(repositoryRoot, file), "utf8").split("\n");
    return lines.flatMap((text, index) => {
      const trimmed = text.trim();
      if (!extensionTest.test(text)) return [];
      if (
        trimmed.startsWith("*") ||
        trimmed.startsWith("//") ||
        /^\s*(?:export )?function /u.test(text)
      )
        return [];
      const around = lines.slice(Math.max(0, index - reach), index + reach + 1).join("\n");
      return [{ file, line: index + 1, text: trimmed, asksHome: homeTest.test(around) }];
    });
  });
}

describe("every site that asks the extension rule asks the Home's beside it", () => {
  it("finds the sites it walks", () => {
    expect(sites().length).toBeGreaterThan(10);
  });

  it("asks the Home rule at each, or says why a site is exempt", () => {
    const missed = sites()
      .filter((site) => !site.asksHome)
      .filter(
        (site) =>
          !exempt.some((entry) => entry.file === site.file && site.text.includes(entry.line)),
      )
      .map((site) => `${site.file}:${site.line}: ${site.text}`);
    expect(missed).toEqual([]);
  });

  it("keeps no exemption that names no site", () => {
    const all = sites();
    const stale = exempt.filter(
      (entry) => !all.some((site) => site.file === entry.file && site.text.includes(entry.line)),
    );
    expect(stale).toEqual([]);
  });
});
