import type { StealthProfile } from "./stealth-profiles.js";

/**
 * Generate a per-profile init script that handles fingerprint evasion defenses
 * that cannot be expressed via CDP protocol commands.
 *
 * Navigator properties (userAgent, platform, language), screen dimensions, and
 * devicePixelRatio are intentionally NOT overridden here — they are set at the
 * CDP protocol level by {@link applyCdpStealthOverrides} in stealth.ts, which
 * is invisible to page JavaScript.  This script only covers:
 *
 *  - `navigator.webdriver` safety net (defensive backup)
 *  - Canvas fingerprint noise
 *  - WebGL vendor/renderer spoofing
 *  - AudioBuffer fingerprint noise
 *  - Font availability spoofing
 *  - CDP Runtime.enable leak defense
 */
export function generateStealthInitScript(profile: StealthProfile): string {
  const encodedProfile = JSON.stringify(profile);
  return `(() => {
  const profile = ${encodedProfile};

  // --- navigator.webdriver safety net ---
  // --disable-blink-features=AutomationControlled handles this at the flag level
  // and CDP handles it at the protocol level, but some Chrome builds still leak
  // webdriver=true when --remote-debugging-port is active.
  if (navigator.webdriver === true) {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      configurable: true,
      get: function() { return false; },
    });
  }

  // --- CDP Runtime.enable leak defense ---
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

  // --- Canvas fingerprint noise ---
  var seedNoise = function(seed, input) {
    var value = Math.sin(seed + input * 12.9898) * 43758.5453;
    return value - Math.floor(value);
  };
  if (HTMLCanvasElement.prototype.toDataURL) {
    var originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function() {
      var context = this.getContext('2d');
      if (context) {
        var x = Math.min(1, Math.max(0, this.width - 1));
        var y = Math.min(1, Math.max(0, this.height - 1));
        var imageData = context.getImageData(x, y, 1, 1);
        imageData.data[0] = Math.max(0, Math.min(255, imageData.data[0] + Math.floor(seedNoise(profile.canvasNoiseSeed, 1) * 2)));
        context.putImageData(imageData, x, y);
      }
      return originalToDataURL.apply(this, arguments);
    };
  }

  // --- WebGL vendor/renderer spoofing ---
  if (typeof WebGLRenderingContext !== 'undefined') {
    var originalGetParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) return profile.webglVendor;
      if (parameter === 37446) return profile.webglRenderer;
      return originalGetParameter.call(this, parameter);
    };
  }

  // --- AudioBuffer fingerprint noise ---
  if (typeof AudioBuffer !== 'undefined' && typeof AnalyserNode !== 'undefined') {
    var originalGetFloatFrequencyData = AnalyserNode.prototype.getFloatFrequencyData;
    AnalyserNode.prototype.getFloatFrequencyData = function(array) {
      originalGetFloatFrequencyData.call(this, array);
      for (var index = 0; index < array.length; index += 16) {
        array[index] += (seedNoise(profile.audioNoiseSeed, index) - 0.5) * 0.0001;
      }
    };
  }

  // --- Font availability spoofing ---
  if (document.fonts && typeof document.fonts.check === 'function') {
    var originalCheck = document.fonts.check.bind(document.fonts);
    document.fonts.check = function(font, text) {
      var family = String(font).match(/["']([^"']+)["']/)?.[1] || String(font).split(/\\s+/).at(-1);
      if (family && profile.fonts.includes(family)) {
        return true;
      }
      return originalCheck(font, text);
    };
  }
})();`;
}
