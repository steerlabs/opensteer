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
 * When a {@link StealthProfile} is provided AND a page reference is available,
 * this function first applies CDP protocol-level overrides (UA, viewport,
 * screen metrics, locale, timezone) which are invisible to page JavaScript.
 * A lightweight init script is still injected for defenses that cannot be
 * expressed via CDP (canvas/WebGL/audio fingerprint noise, font spoofing,
 * and the CDP Runtime.enable leak neutralization).
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
  // Apply CDP-level overrides first — these are undetectable by page JS
  // because they modify Chrome's internal state rather than wrapping JS APIs.
  if (input.profile !== undefined && input.page !== undefined) {
    await applyCdpStealthOverrides(context, input.page, input.profile);
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

  const platformMap: Record<string, { platform: string; platformVersion: string; architecture: string }> = {
    macos: { platform: "macOS", platformVersion: "14.4.0", architecture: "arm" },
    windows: { platform: "Windows", platformVersion: "15.0.0", architecture: "x86" },
    linux: { platform: "Linux", platformVersion: "6.5.0", architecture: "x86" },
  };

  const platformInfo = platformMap[profile.platform] ?? platformMap.linux!;

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
async function applyCdpStealthOverrides(
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
    const platformString =
      profile.platform === "macos"
        ? "MacIntel"
        : profile.platform === "windows"
          ? "Win32"
          : "Linux x86_64";

    // User-Agent + Client Hints at the network layer.  This sets both the HTTP
    // header and all navigator.userAgentData properties natively.
    await cdp.send("Network.setUserAgentOverride", {
      userAgent: profile.userAgent,
      acceptLanguage: `${profile.locale},en;q=0.9`,
      platform: platformString,
      userAgentMetadata: buildUserAgentMetadata(profile),
    });

    // Device metrics: viewport, screen resolution, and device scale factor.
    // Unlike JS property overrides, this feeds into Chrome's layout engine so
    // CSS media queries and window.matchMedia also reflect the spoofed values.
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: profile.viewport.width,
      height: profile.viewport.height,
      deviceScaleFactor: profile.devicePixelRatio,
      mobile: false,
      screenWidth: profile.screenResolution.width,
      screenHeight: profile.screenResolution.height,
    });

    // Locale — sets navigator.language and navigator.languages natively.
    await cdp.send("Emulation.setLocaleOverride", {
      locale: profile.locale,
    }).catch(() => undefined);

    // Timezone
    await cdp.send("Emulation.setTimezoneOverride", {
      timezoneId: profile.timezoneId,
    }).catch(() => undefined);

    await cdp.detach();
  } catch {
    // CDP-level overrides are best-effort.  The init script provides fallback
    // coverage for engines or browser versions that don't support these commands.
  }
}

interface CdpSessionLike {
  readonly send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  readonly detach: () => Promise<unknown>;
}
