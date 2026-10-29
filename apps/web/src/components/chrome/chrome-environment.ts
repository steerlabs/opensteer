import { createContext, useContext, useMemo } from "react";
import { chromeExtensionConnectUrl, chromeExtensionProbeUrl } from "@opensteer/client/host";
import { isLoopbackHostname } from "@opensteer/core";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";

/**
 * Where this page runs, as far as connecting Chrome goes:
 * - `chromium`: a Chromium browser on a computer. The page can see the
 *   extension and open its connect tab itself.
 * - `desktop`: the Opensteer app. Its window cannot reach Chrome's extensions,
 *   so it hands the step to the default browser.
 * - `other-browser`: Safari, Firefox and friends. The link has to be opened in Chrome.
 * - `phone`: no extensions at all.
 */
export type ChromeConnectPlace = "chromium" | "desktop" | "other-browser" | "phone";

export interface ChromeConnectEnvironment {
  /** Whether Chrome on this computer reaches the Deployment on loopback. */
  readonly hostHere: boolean;
  readonly place: ChromeConnectPlace;
  copy(text: string): Promise<boolean>;
  /** Opens the extension's connect tab; false when Chrome blocked the tab. */
  openExtensionConnect(invitation: string): boolean;
  openInDefaultBrowser(url: string): Promise<void>;
  probeExtension(): Promise<boolean>;
}

/** A page that renders the flow without a real browser around it supplies its own. */
export const ChromeConnectEnvironmentContext = createContext<ChromeConnectEnvironment | null>(null);

export function useChromeConnectEnvironment(input: {
  readonly desktopBridge: Pick<OpensteerDesktopBridge, "openExternalUrl"> | null;
  /** Null when this page cannot tell; loopback pages are always on the Deployment's computer. */
  readonly hostHere: boolean | null;
}): ChromeConnectEnvironment {
  const override = useContext(ChromeConnectEnvironmentContext);
  const { desktopBridge, hostHere } = input;
  const detected = useMemo(
    () => browserChromeConnectEnvironment(desktopBridge, hostHere),
    [desktopBridge, hostHere],
  );
  return override ?? detected;
}

function browserChromeConnectEnvironment(
  desktopBridge: Pick<OpensteerDesktopBridge, "openExternalUrl"> | null,
  hostHere: boolean | null,
): ChromeConnectEnvironment {
  return {
    copy: copyText,
    hostHere: hostHere ?? isLoopbackHostname(window.location.hostname),
    openExtensionConnect: (invitation) =>
      window.open(chromeExtensionConnectUrl(invitation), "_blank") !== null,
    openInDefaultBrowser: async (url) => {
      if (desktopBridge) {
        await desktopBridge.openExternalUrl({ url });
        return;
      }
      if (window.open(url, "_blank", "noopener") === null) {
        throw new Error("Your browser blocked the new tab. Copy the link instead.");
      }
    },
    place: desktopBridge ? "desktop" : browserPlace(),
    probeExtension: probeOpensteerExtension,
  };
}

interface NavigatorUserAgentData {
  readonly brands?: readonly { readonly brand: string }[];
  readonly mobile?: boolean;
}

function browserPlace(): ChromeConnectPlace {
  const data = (navigator as Navigator & { userAgentData?: NavigatorUserAgentData }).userAgentData;
  const agent = navigator.userAgent;
  const phone = data?.mobile ?? /Android|iPhone|iPad|iPod|Mobile/u.test(agent);
  if (phone) return "phone";
  const chromium = data?.brands
    ? data.brands.some(({ brand }) => brand === "Chromium" || brand === "Google Chrome")
    : /Chrome\//u.test(agent) && !/Edg\/|OPR\//u.test(agent);
  return chromium ? "chromium" : "other-browser";
}

/** The extension exposes one image to web pages; it loads only when the extension is there. */
function probeOpensteerExtension(): Promise<boolean> {
  return new Promise((resolve) => {
    const image = new Image();
    const timer = window.setTimeout(() => finish(false), 3_000);
    function finish(found: boolean) {
      window.clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      resolve(found);
    }
    image.onload = () => finish(true);
    image.onerror = () => finish(false);
    image.src = `${chromeExtensionProbeUrl}?${Date.now()}`;
  });
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
