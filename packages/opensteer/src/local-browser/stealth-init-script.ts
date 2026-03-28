import type { StealthProfile } from "./stealth-profiles.js";

/**
 * Generate a per-profile init script that handles fingerprint evasion defenses
 * for every new document in the context.
 *
 * CDP remains the preferred path for the current page because it updates
 * Chromium's internal state natively. This init script mirrors the same
 * navigator/screen values onto every new document so popups and later pages
 * stay consistent before their page-scoped CDP session attaches. It also covers:
 *
 *  - Canvas fingerprint noise
 *  - WebGL vendor/renderer spoofing
 *  - AudioBuffer fingerprint noise
 *  - Font availability spoofing
 *  - CDP Runtime.enable leak defense
 */
export function generateStealthInitScript(profile: StealthProfile): string {
  const encodedProfile = JSON.stringify({
    ...profile,
    platformString: getPlatformString(profile.platform),
    userAgentData: buildUserAgentData(profile),
  });
  return `(() => {
  const profile = ${encodedProfile};
  var define = function(target, key, value) {
    Object.defineProperty(target, key, {
      configurable: true,
      get: typeof value === 'function' ? value : function() { return value; },
    });
  };

  // --- navigator / screen mirrors for future pages ---
  if (navigator.webdriver === true) {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      configurable: true,
      get: function() { return false; },
    });
  }
  define(Navigator.prototype, 'platform', profile.platformString);
  define(Navigator.prototype, 'userAgent', profile.userAgent);
  define(Navigator.prototype, 'language', profile.locale);
  define(Navigator.prototype, 'languages', [profile.locale, 'en']);
  define(Navigator.prototype, 'maxTouchPoints', profile.maxTouchPoints);
  define(window, 'devicePixelRatio', profile.devicePixelRatio);
  define(window.screen, 'width', profile.screenResolution.width);
  define(window.screen, 'height', profile.screenResolution.height);
  define(window.screen, 'availWidth', profile.screenResolution.width);
  define(window.screen, 'availHeight', profile.screenResolution.height - 40);
  define(window.screen, 'colorDepth', 24);
  define(window.screen, 'pixelDepth', 24);
  define(Navigator.prototype, 'userAgentData', {
    brands: profile.userAgentData.brands,
    mobile: false,
    platform: profile.userAgentData.platform,
    toJSON: function() {
      return {
        brands: this.brands,
        mobile: this.mobile,
        platform: this.platform,
      };
    },
    getHighEntropyValues: async function(hints) {
      var source = {
        architecture: profile.userAgentData.architecture,
        bitness: profile.userAgentData.bitness,
        brands: profile.userAgentData.brands,
        fullVersionList: profile.userAgentData.fullVersionList,
        mobile: false,
        model: '',
        platform: profile.userAgentData.platform,
        platformVersion: profile.userAgentData.platformVersion,
        uaFullVersion: profile.browserVersion,
        wow64: false,
      };
      var values = {};
      for (var i = 0; i < hints.length; i++) {
        var hint = hints[i];
        if (Object.prototype.hasOwnProperty.call(source, hint)) {
          values[hint] = source[hint];
        }
      }
      return values;
    },
  });

  if (typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
    var originalResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
    Intl.DateTimeFormat.prototype.resolvedOptions = function() {
      var options = originalResolvedOptions.call(this);
      options.timeZone = profile.timezoneId;
      return options;
    };
  }

  if (Date.prototype.getTimezoneOffset) {
    var originalGetTimezoneOffset = Date.prototype.getTimezoneOffset;
    var calculateTimezoneOffset = function(date) {
      try {
        var formatter = new Intl.DateTimeFormat('en-US', {
          timeZone: profile.timezoneId,
          hour12: false,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });
        var parts = formatter.formatToParts(date);
        var values = {};
        for (var i = 0; i < parts.length; i++) {
          if (parts[i].type !== 'literal') {
            values[parts[i].type] = Number(parts[i].value);
          }
        }
        var utcTime = Date.UTC(
          values.year,
          values.month - 1,
          values.day,
          values.hour,
          values.minute,
          values.second,
        );
        return Math.round((date.getTime() - utcTime) / 60000);
      } catch {
        return originalGetTimezoneOffset.call(date);
      }
    };
    Date.prototype.getTimezoneOffset = function() {
      return calculateTimezoneOffset(this);
    };
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

function buildUserAgentData(profile: StealthProfile) {
  const majorVersion = profile.browserVersion.split(".")[0] ?? "136";
  const platformData = {
    macos: { platform: "macOS", platformVersion: "14.4.0", architecture: "arm" },
    windows: { platform: "Windows", platformVersion: "15.0.0", architecture: "x86" },
    linux: { platform: "Linux", platformVersion: "6.5.0", architecture: "x86" },
  } as const;
  const platformInfo = platformData[profile.platform];

  return {
    architecture: platformInfo.architecture,
    bitness: "64",
    brands: [
      { brand: "Chromium", version: majorVersion },
      ...(profile.browserBrand === "edge"
        ? [{ brand: "Microsoft Edge", version: majorVersion }]
        : [{ brand: "Google Chrome", version: majorVersion }]),
      { brand: "Not-A.Brand", version: "99" },
    ],
    fullVersionList: [
      { brand: "Chromium", version: profile.browserVersion },
      ...(profile.browserBrand === "edge"
        ? [{ brand: "Microsoft Edge", version: profile.browserVersion }]
        : [{ brand: "Google Chrome", version: profile.browserVersion }]),
      { brand: "Not-A.Brand", version: "99.0.0.0" },
    ],
    platform: platformInfo.platform,
    platformVersion: platformInfo.platformVersion,
  };
}

function getPlatformString(platform: StealthProfile["platform"]): string {
  return platform === "macos" ? "MacIntel" : platform === "windows" ? "Win32" : "Linux x86_64";
}
