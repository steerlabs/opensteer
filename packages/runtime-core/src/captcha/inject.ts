import type { BrowserCoreEngine, PageRef } from "@opensteer/browser-core";
import type { CaptchaType } from "@opensteer/protocol";

export async function injectCaptchaToken(input: {
  readonly engine: BrowserCoreEngine;
  readonly pageRef: PageRef;
  readonly type: CaptchaType;
  readonly token: string;
}): Promise<boolean> {
  const result = await input.engine.evaluatePage({
    pageRef: input.pageRef,
    script: CAPTCHA_INJECTION_SCRIPT,
    args: [
      {
        type: input.type,
        token: input.token,
      },
    ],
  });
  return result.data === true;
}

const CAPTCHA_INJECTION_SCRIPT = `(({ type, token }) => {
  const writeValue = (selectors) => {
    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector);
      for (const element of elements) {
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) continue;
        element.value = token;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  };
  const invokeCallbacks = () => {
    const callbacks = [];
    if (window.___grecaptcha_cfg?.clients) {
      callbacks.push(...Object.values(window.___grecaptcha_cfg.clients));
    }
    callbacks.push(window.onCaptchaSolved, window.cfCallback, window.turnstileCallback);
    for (const candidate of callbacks) {
      if (typeof candidate === 'function') {
        try {
          candidate(token);
        } catch {}
      }
    }
  };

  switch (type) {
    case 'recaptcha-v2':
      writeValue(['textarea[name="g-recaptcha-response"]', '#g-recaptcha-response']);
      break;
    case 'hcaptcha':
      writeValue(['textarea[name="h-captcha-response"]', '[name="h-captcha-response"]']);
      break;
    case 'turnstile':
      writeValue(['input[name="cf-turnstile-response"]', 'textarea[name="cf-turnstile-response"]']);
      break;
  }
  invokeCallbacks();
  return true;
})`;
