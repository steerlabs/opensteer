import type { SessionDeviceForm } from "@opensteer/core";

export interface SessionDevice {
  readonly form: SessionDeviceForm | null;
  readonly label: string;
}

const unknownDevice: SessionDevice = { form: null, label: "Unknown device" };

/**
 * What a person calls the device behind a session: "Chrome on Mac", "Opensteer
 * app on iOS". The label is assembled only from the fixed names below, never
 * copied from the header, so a user agent can neither inject text into the list
 * nor make it unreadable.
 *
 * Order matters in both tables. Every browser claims to be Safari, Chromium
 * browsers also claim to be Chrome, iPhones claim to be "like Mac OS X", and
 * Android claims to be Linux, so the more specific token is always read first.
 * iPadOS Safari asks for desktop pages as a Mac, and no header tells it apart.
 */
export function describeSessionDevice(userAgent: string | null): SessionDevice {
  const agent = userAgent?.trim() ?? "";
  if (!agent) return unknownDevice;
  const platform = platforms.find(({ token }) => token.test(agent)) ?? null;
  if (/\bElectron\//u.test(agent)) {
    return { form: "computer", label: `Opensteer app on ${platform?.name ?? "a computer"}` };
  }
  // The phone app's own requests go through the platform networking stack,
  // whose user agent names that stack rather than a browser.
  if (/\bCFNetwork\//u.test(agent) && /\bDarwin\//u.test(agent)) {
    return { form: "mobile", label: "Opensteer app on iOS" };
  }
  if (agent.startsWith("okhttp/")) return { form: "mobile", label: "Opensteer app on Android" };
  const browser = browsers.find(({ token }) => token.test(agent))?.name ?? null;
  if (browser && platform) return { form: platform.form, label: `${browser} on ${platform.name}` };
  if (platform) return { form: platform.form, label: `Browser on ${platform.name}` };
  if (browser) return { form: null, label: browser };
  return unknownDevice;
}

const platforms: readonly {
  readonly form: SessionDeviceForm;
  readonly name: string;
  readonly token: RegExp;
}[] = [
  { form: "mobile", name: "iPhone", token: /\biPhone\b/u },
  { form: "mobile", name: "iPad", token: /\biPad\b/u },
  { form: "mobile", name: "Android", token: /\bAndroid\b/u },
  { form: "computer", name: "ChromeOS", token: /\bCrOS\b/u },
  { form: "computer", name: "Mac", token: /\bMacintosh\b|\bMac OS X\b/u },
  { form: "computer", name: "Windows", token: /\bWindows\b/u },
  { form: "computer", name: "Linux", token: /\bLinux\b|\bX11\b/u },
];

const browsers: readonly { readonly name: string; readonly token: RegExp }[] = [
  { name: "Edge", token: /\bEdg(?:e|A|iOS)?\// },
  { name: "Opera", token: /\bOPR\/|\bOPiOS\// },
  { name: "Samsung Internet", token: /\bSamsungBrowser\// },
  { name: "Firefox", token: /\bFirefox\/|\bFxiOS\// },
  { name: "Chrome", token: /\bChrome\/|\bCriOS\// },
  { name: "Safari", token: /\bVersion\/[\d.]+.*\bSafari\// },
];
