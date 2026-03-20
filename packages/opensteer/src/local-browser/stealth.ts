import type { ConnectedCdpBrowserContext } from "./types.js";

/**
 * JavaScript source injected before any page scripts via
 * Page.addScriptToEvaluateOnNewDocument to mask automation signals
 * that bot-detection systems (Cloudflare Turnstile, DataDome, etc.) check.
 *
 * Runs in the main world of every new document before page-originating scripts.
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
 * When the context does not support init scripts (e.g. the ABP engine),
 * this is a silent no-op.
 */
export async function injectBrowserStealthScripts(
  context: ConnectedCdpBrowserContext,
): Promise<void> {
  if (typeof context.addInitScript === "function") {
    await context.addInitScript({ content: STEALTH_INIT_SCRIPT });
  }
}
