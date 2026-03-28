import { generateStealthInitScript } from "./stealth-init-script.js";
import type { StealthProfile } from "./stealth-profiles.js";
import type { ConnectedCdpBrowserContext, ConnectedCdpPage } from "./types.js";

/**
 * JavaScript source injected before any page scripts via
 * Page.addScriptToEvaluateOnNewDocument to mask automation signals
 * that bot-detection systems (Cloudflare Turnstile, DataDome, etc.) check.
 *
 * Runs in the main world of every new document before page-originating scripts.
 *
 * This script only handles defenses that cannot be achieved via CDP protocol
 * commands: the CDP Runtime.enable leak detection neutralization.
 * Navigator / screen / viewport overrides are handled at the CDP protocol
 * level by {@link applyCdpStealthOverrides}, which is undetectable by page JS.
 */
const STEALTH_INIT_SCRIPT = `(() => {
  // Override navigator.webdriver only if Chrome reports automation.
  // --disable-blink-features=AutomationControlled should prevent this, but some
  // Chrome builds still set webdriver=true when --remote-debugging-port is active.
  if (navigator.webdriver === true) {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get: function() { return false; },
      configurable: true,
    });
  }

  // Neutralize CDP Runtime.enable leak detection.
  //
  // Playwright enables the CDP Runtime domain for page.evaluate(). Bot detectors
  // exploit this: they create an Error with a user-defined getter on its 'stack'
  // property, then pass that Error to a console method. When Runtime.enable is
  // active, Chrome serializes the Error for the Runtime.consoleAPICalled event,
  // which triggers the getter — proving CDP is present.
  //
  // Defense: wrap console methods in a Proxy that detects this specific pattern
  // (an Error whose 'stack' is an accessor, not a data property) and suppresses
  // the call. Normal Errors have a plain data-property 'stack', so legitimate
  // console usage is unaffected.
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
})();`;

/**
 * Inject stealth init scripts into a browser context so that every page
 * opened in that context masks common automation-detection signals.
 *
 * When a {@link StealthProfile} is provided, this function installs context-wide
 * request headers for future navigations and popups, applies CDP protocol-level
 * overrides to all current pages in the context, and registers the same CDP
 * overrides for pages opened later in that context. The init script also mirrors
 * the spoofed navigator/screen values onto every new document so popup pages stay
 * consistent before their per-page CDP session attaches.
 *
 * When the context does not support init scripts (e.g. the ABP engine),
 * this is a silent no-op for the init-script portion.
 */
export async function injectBrowserStealthScripts(
  context: ConnectedCdpBrowserContext,
  input: {
    readonly profile?: StealthProfile;
    readonly page?: ConnectedCdpPage;
  } = {},
): Promise<void> {
  if (input.profile !== undefined) {
    await installContextNetworkHeaders(context, input.profile);
    await installCdpStealthOverrides(context, input.profile, input.page);
  }

  if (typeof context.addInitScript === "function") {
    await context.addInitScript({
      content:
        input.profile === undefined
          ? STEALTH_INIT_SCRIPT
          : generateStealthInitScript(input.profile),
    });
  }
}

/**
 * Build the User-Agent Client Hints metadata object from a stealth profile.
 *
 * Modern bot detectors compare `navigator.userAgentData.getHighEntropyValues()`
 * against the User-Agent header to detect automation.  Setting these values at
 * the CDP level ensures both the JS API and HTTP headers are internally
 * consistent — something JS injection alone cannot achieve.
 */
function buildUserAgentMetadata(profile: StealthProfile): Record<string, unknown> {
  const majorVersion = profile.browserVersion.split(".")[0] ?? "136";

  const brands = [
    { brand: "Chromium", version: majorVersion },
    ...(profile.browserBrand === "edge"
      ? [{ brand: "Microsoft Edge", version: majorVersion }]
      : [{ brand: "Google Chrome", version: majorVersion }]),
    { brand: "Not-A.Brand", version: "99" },
  ];

  const fullVersionList = [
    { brand: "Chromium", version: profile.browserVersion },
    ...(profile.browserBrand === "edge"
      ? [{ brand: "Microsoft Edge", version: profile.browserVersion }]
      : [{ brand: "Google Chrome", version: profile.browserVersion }]),
    { brand: "Not-A.Brand", version: "99.0.0.0" },
  ];

  const platformMap: Record<
    StealthProfile["platform"],
    { platform: string; platformVersion: string; architecture: string }
  > = {
    // Chromium keeps the reduced macOS UA token frozen to Intel even on Apple Silicon.
    macos: { platform: "macOS", platformVersion: "14.4.0", architecture: "arm" },
    windows: { platform: "Windows", platformVersion: "15.0.0", architecture: "x86" },
    linux: { platform: "Linux", platformVersion: "6.5.0", architecture: "x86" },
  };

  const platformInfo = platformMap[profile.platform];

  return {
    brands,
    fullVersionList,
    platform: platformInfo.platform,
    platformVersion: platformInfo.platformVersion,
    architecture: platformInfo.architecture,
    model: "",
    mobile: false,
    bitness: "64",
    wow64: false,
  };
}

/**
 * Apply stealth overrides at the Chrome DevTools Protocol level.
 *
 * Unlike JavaScript init-script injection, CDP commands modify Chrome's
 * internal state directly.  This means:
 *
 *  - `navigator.userAgent` returns the spoofed value as a native string, not
 *    via a getter override that bot detectors can fingerprint.
 *  - `navigator.userAgentData.getHighEntropyValues()` returns correct Client
 *    Hints metadata — impossible to achieve via JS injection alone.
 *  - `screen.width`, `screen.height`, `devicePixelRatio`, and viewport
 *    dimensions are set at the rendering-engine level.
 *  - `navigator.language` / `navigator.languages` reflect the spoofed locale.
 *
 * This function is best-effort: if the context does not expose a CDP session
 * factory (e.g. non-Playwright engines), it silently returns without error.
 */
async function installCdpStealthOverrides(
  context: ConnectedCdpBrowserContext,
  profile: StealthProfile,
  initialPage?: ConnectedCdpPage,
): Promise<void> {
  const pages =
    initialPage === undefined
      ? context.pages()
      : Array.from(new Set([initialPage, ...context.pages()]));

  await Promise.all(pages.map((page) => applyPageOverrides(context, page, profile)));

  const appliedPages = new WeakSet<ConnectedCdpPage>();
  const applyFuturePageOverrides = async (page: ConnectedCdpPage): Promise<void> => {
    if (appliedPages.has(page)) {
      return;
    }
    appliedPages.add(page);
    await applyPageOverrides(context, page, profile);
  };

  if (typeof context.on === "function") {
    context.on("page", applyFuturePageOverrides);
  }
}

async function installContextNetworkHeaders(
  context: ConnectedCdpBrowserContext,
  profile: StealthProfile,
): Promise<void> {
  if (typeof context.setExtraHTTPHeaders !== "function") {
    return;
  }

  await context.setExtraHTTPHeaders(buildStealthRequestHeaders(profile)).catch(() => undefined);
}

async function applyPageOverrides(
  context: ConnectedCdpBrowserContext,
  page: ConnectedCdpPage,
  profile: StealthProfile,
): Promise<void> {
  // Access the Playwright-specific newCDPSession method via runtime check.
  // The ConnectedCdpBrowserContext interface is engine-neutral and does not
  // expose it, but the actual Playwright BrowserContext object does.
  const contextWithCdp = context as { newCDPSession?: (page: unknown) => Promise<CdpSessionLike> };
  if (typeof contextWithCdp.newCDPSession !== "function") {
    return;
  }

  let cdp: CdpSessionLike;
  try {
    cdp = await contextWithCdp.newCDPSession(page);
  } catch {
    return;
  }

  try {
    await applyCdpStealthCommands((method, params) => cdp.send(method, params), profile);
  } catch {
    // CDP-level overrides are best-effort. Unsupported commands are ignored so
    // stealth setup does not fail when a Chromium build lacks one of them.
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

async function applyCdpStealthCommands(
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  profile: StealthProfile,
): Promise<void> {
  await send("Network.setUserAgentOverride", {
    userAgent: profile.userAgent,
    acceptLanguage: `${profile.locale},en;q=0.9`,
    platform: getPlatformString(profile.platform),
    userAgentMetadata: buildUserAgentMetadata(profile),
  });

  await send("Emulation.setDeviceMetricsOverride", {
    width: profile.viewport.width,
    height: profile.viewport.height,
    deviceScaleFactor: profile.devicePixelRatio,
    mobile: false,
    screenWidth: profile.screenResolution.width,
    screenHeight: profile.screenResolution.height,
  });

  await send("Emulation.setLocaleOverride", {
    locale: profile.locale,
  }).catch(() => undefined);

  await send("Emulation.setTimezoneOverride", {
    timezoneId: profile.timezoneId,
  }).catch(() => undefined);
}

function buildStealthRequestHeaders(profile: StealthProfile): Record<string, string> {
  const metadata = buildUserAgentMetadata(profile) as {
    readonly brands: ReadonlyArray<{ readonly brand: string; readonly version: string }>;
    readonly platform: string;
  };

  return {
    "Accept-Language": `${profile.locale},en;q=0.9`,
    "Sec-CH-UA": metadata.brands.map(formatClientHintBrand).join(", "),
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": `"${metadata.platform}"`,
    "User-Agent": profile.userAgent,
  };
}

function formatClientHintBrand(brand: {
  readonly brand: string;
  readonly version: string;
}): string {
  return `"${brand.brand}";v="${brand.version}"`;
}

function getPlatformString(platform: StealthProfile["platform"]): string {
  return platform === "macos" ? "MacIntel" : platform === "windows" ? "Win32" : "Linux x86_64";
}

interface CdpSessionLike {
  readonly send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  readonly detach: () => Promise<unknown>;
}
