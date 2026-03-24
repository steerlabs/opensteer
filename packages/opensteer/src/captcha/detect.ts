import type { BrowserCoreEngine, PageRef } from "@opensteer/browser-core";
import type { CaptchaDetectionResult } from "@opensteer/protocol";

const CAPTCHA_DETECTION_SCRIPT = `(() => {
  const pageUrl = location.href;
  const findSiteKey = (selectors) => {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (!element) continue;
      const siteKey = element.getAttribute('data-sitekey') ||
        element.getAttribute('sitekey') ||
        element.getAttribute('data-key');
      if (siteKey) return siteKey;
    }
    return undefined;
  };
  const iframeSrc = Array.from(document.querySelectorAll('iframe'))
    .map((iframe) => iframe.getAttribute('src') || '')
    .find((src) => /recaptcha|hcaptcha|turnstile/i.test(src));
  const fromIframe = iframeSrc ? (() => {
    try {
      const url = new URL(iframeSrc, pageUrl);
      return url.searchParams.get('k') || url.searchParams.get('sitekey') || undefined;
    } catch {
      return undefined;
    }
  })() : undefined;

  const recaptchaSiteKey =
    findSiteKey(['.g-recaptcha', '[data-sitekey][data-callback]', 'div[data-sitekey]']) ||
    fromIframe ||
    window.___grecaptcha_cfg?.sitekey;
  if (window.grecaptcha || recaptchaSiteKey) {
    return { type: 'recaptcha-v2', siteKey: recaptchaSiteKey, pageUrl };
  }

  const hcaptchaSiteKey =
    findSiteKey(['.h-captcha', '[data-hcaptcha-response]', '[data-sitekey][data-theme]']) ||
    fromIframe;
  if (window.hcaptcha || hcaptchaSiteKey) {
    return { type: 'hcaptcha', siteKey: hcaptchaSiteKey, pageUrl };
  }

  const turnstileSiteKey =
    findSiteKey(['.cf-turnstile', '[data-sitekey][data-action]', '[name="cf-turnstile-response"]']) ||
    fromIframe;
  if (window.turnstile || turnstileSiteKey) {
    return { type: 'turnstile', siteKey: turnstileSiteKey, pageUrl };
  }

  return null;
})();`;

export async function detectCaptchaOnPage(
  engine: BrowserCoreEngine,
  pageRef: PageRef,
): Promise<CaptchaDetectionResult | undefined> {
  const evaluated = await engine.evaluatePage({
    pageRef,
    script: CAPTCHA_DETECTION_SCRIPT,
  });
  const candidate = evaluated.data as CaptchaDetectionResult | null;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    typeof candidate.type !== "string" ||
    typeof candidate.siteKey !== "string" ||
    typeof candidate.pageUrl !== "string"
  ) {
    return undefined;
  }
  return candidate;
}
