// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { ConnectChrome, type ConnectChromeClient } from "./connect-chrome.js";
import {
  useChromeConnectEnvironment,
  type ChromeConnectEnvironment,
} from "./chrome-environment.js";

/*
 * Connecting Chrome works only inside Chrome. In the Mac app, "Open in Chrome" opens Chrome
 * itself whatever the default browser is, and where Chrome isn't installed it says so instead
 * of opening the page somewhere it can't work.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

const client = {
  dispatch: async () => ({
    pairing: {
      destinations: [{ origin: "http://127.0.0.1:4000", remote: false }],
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      invitation: "osc1.abc",
    },
    type: "browser.source.pair",
  }),
  rpc: {
    "browser.sources.get": async () => ({ data: { sources: [] }, ok: true }),
  },
} as unknown as ConnectChromeClient;

function desktop(openInChrome: ChromeConnectEnvironment["openInChrome"]): ChromeConnectEnvironment {
  return {
    copy: async () => true,
    hostHere: true,
    openExtensionConnect: () => true,
    openInChrome,
    place: "desktop",
    probeExtension: async () => false,
  };
}

async function draw(environment: ChromeConnectEnvironment) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<ConnectChrome client={client} environment={environment} />));
  return container;
}

function button(container: Element, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === name,
  );
  if (!found) throw new Error(`No "${name}" in: ${container.textContent}`);
  return found;
}

describe("Connect your Chrome in the Mac app", () => {
  it("opens the page in Chrome itself, and never sends a person to the default browser", async () => {
    const openInChrome = vi.fn(async (_url: string) => "opened" as const);
    const container = await draw(desktop(openInChrome));
    expect(container.textContent).not.toContain("default browser");
    await act(async () => button(container, "Open in Chrome").click());
    await vi.waitFor(() => expect(openInChrome).toHaveBeenCalledTimes(1));
    expect(openInChrome.mock.calls[0]![0]).toMatch(/^http:\/\/127\.0\.0\.1:4000\/connect\/chrome/u);
    await vi.waitFor(() => expect(container.textContent).toContain("Finish in Chrome."));
    expect(container.textContent).not.toContain("default browser");
  });

  it("says plainly that Chrome is needed when it isn't installed", async () => {
    const container = await draw(desktop(async () => "no-chrome"));
    await act(async () => button(container, "Open in Chrome").click());
    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "Connecting needs Google Chrome on this Mac. Install Chrome, then try again.",
      ),
    );
    // Back where it started, ready to try again once Chrome is there.
    expect(button(container, "Open in Chrome").disabled).toBe(false);
  });
});

describe("the Mac app's way to Chrome", () => {
  function environmentFor(
    bridge: Pick<OpensteerDesktopBridge, "openExternalUrl" | "openInChrome">,
  ) {
    let environment: ChromeConnectEnvironment | null = null;
    function Probe() {
      environment = useChromeConnectEnvironment({ desktopBridge: bridge, hostHere: true });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    roots.push(root);
    act(() => root.render(<Probe />));
    return environment!;
  }

  it("asks the app for Chrome, not for the default browser", async () => {
    const openExternalUrl = vi.fn(async () => ({ opened: true }) as const);
    const openInChrome = vi.fn(async () => ({ opened: true }) as const);
    const environment = environmentFor({ openExternalUrl, openInChrome });
    await expect(environment.openInChrome("http://127.0.0.1:4000/connect/chrome")).resolves.toBe(
      "opened",
    );
    expect(openInChrome).toHaveBeenCalledExactlyOnceWith({
      url: "http://127.0.0.1:4000/connect/chrome",
    });
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("hears that Chrome isn't installed", async () => {
    const environment = environmentFor({
      openExternalUrl: vi.fn(async () => ({ opened: true }) as const),
      openInChrome: async () => ({ opened: false, reason: "chrome-not-installed" }),
    });
    await expect(environment.openInChrome("http://127.0.0.1:4000/connect/chrome")).resolves.toBe(
      "no-chrome",
    );
  });
});
