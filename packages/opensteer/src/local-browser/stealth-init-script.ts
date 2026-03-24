import type { StealthProfile } from "./stealth-profiles.js";

export function generateStealthInitScript(profile: StealthProfile): string {
  const encodedProfile = JSON.stringify(profile);
  return `(() => {
  const profile = ${encodedProfile};
  const define = (target, key, value) => {
    Object.defineProperty(target, key, {
      configurable: true,
      get: typeof value === "function" ? value : () => value,
    });
  };
  define(Navigator.prototype, 'webdriver', false);
  define(Navigator.prototype, 'platform', profile.platform === 'macos' ? 'MacIntel' : profile.platform === 'windows' ? 'Win32' : 'Linux x86_64');
  define(Navigator.prototype, 'userAgent', profile.userAgent);
  define(Navigator.prototype, 'language', profile.locale);
  define(Navigator.prototype, 'languages', [profile.locale, 'en']);
  define(Navigator.prototype, 'maxTouchPoints', profile.maxTouchPoints);
  define(window, 'devicePixelRatio', profile.devicePixelRatio);
  define(window.screen, 'width', profile.screenResolution.width);
  define(window.screen, 'height', profile.screenResolution.height);
  define(window.screen, 'availWidth', profile.screenResolution.width);
  define(window.screen, 'availHeight', profile.screenResolution.height - 40);
  if (document.fonts && typeof document.fonts.check === 'function') {
    const originalCheck = document.fonts.check.bind(document.fonts);
    document.fonts.check = function(font, text) {
      const family = String(font).match(/["']([^"']+)["']/)?.[1] || String(font).split(/\s+/).at(-1);
      if (family && profile.fonts.includes(family)) {
        return true;
      }
      return originalCheck(font, text);
    };
  }
  const seedNoise = (seed, input) => {
    const value = Math.sin(seed + input * 12.9898) * 43758.5453;
    return value - Math.floor(value);
  };
  if (HTMLCanvasElement.prototype.toDataURL) {
    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(...args) {
      const context = this.getContext('2d');
      if (context) {
        const x = Math.min(1, Math.max(0, this.width - 1));
        const y = Math.min(1, Math.max(0, this.height - 1));
        const imageData = context.getImageData(x, y, 1, 1);
        imageData.data[0] = Math.max(0, Math.min(255, imageData.data[0] + Math.floor(seedNoise(profile.canvasNoiseSeed, 1) * 2)));
        context.putImageData(imageData, x, y);
      }
      return originalToDataURL.apply(this, args);
    };
  }
  if (typeof WebGLRenderingContext !== 'undefined') {
    const originalGetParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) return profile.webglVendor;
      if (parameter === 37446) return profile.webglRenderer;
      return originalGetParameter.call(this, parameter);
    };
  }
  if (typeof AudioBuffer !== 'undefined' && typeof AnalyserNode !== 'undefined') {
    const originalGetFloatFrequencyData = AnalyserNode.prototype.getFloatFrequencyData;
    AnalyserNode.prototype.getFloatFrequencyData = function(array) {
      originalGetFloatFrequencyData.call(this, array);
      for (let index = 0; index < array.length; index += 16) {
        array[index] += (seedNoise(profile.audioNoiseSeed, index) - 0.5) * 0.0001;
      }
    };
  }
})();`;
}
