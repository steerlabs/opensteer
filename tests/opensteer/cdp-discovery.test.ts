import { afterEach, describe, expect, test, vi } from "vitest";

const chromeDiscoveryState = vi.hoisted(() => ({
  detectLocalBrowserInstallations: vi.fn(() => []),
  readDevToolsActivePort: vi.fn(() => null),
}));

vi.mock("../../packages/opensteer/src/local-browser/chrome-discovery.js", () => ({
  detectLocalBrowserInstallations: chromeDiscoveryState.detectLocalBrowserInstallations,
  readDevToolsActivePort: chromeDiscoveryState.readDevToolsActivePort,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unstubAllGlobals();
  chromeDiscoveryState.detectLocalBrowserInstallations.mockReset();
  chromeDiscoveryState.detectLocalBrowserInstallations.mockReturnValue([]);
  chromeDiscoveryState.readDevToolsActivePort.mockReset();
  chromeDiscoveryState.readDevToolsActivePort.mockReturnValue(null);
});

describe("local CDP discovery", () => {
  test("inspects a numeric CDP port through /json/version", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        if (String(input) === "http://127.0.0.1:9222/json/version") {
          return jsonResponse({
            Browser: "Chrome/136.0.0.0",
            "Protocol-Version": "1.3",
            webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/root",
          });
        }
        return new Response(null, { status: 404 });
      }),
    );

    const { inspectCdpEndpoint } =
      await import("../../packages/opensteer/src/local-browser/cdp-discovery.js");

    await expect(inspectCdpEndpoint({ endpoint: "9222" })).resolves.toEqual({
      endpoint: "ws://127.0.0.1:9222/devtools/browser/root",
      browser: "Chrome/136.0.0.0",
      protocolVersion: "1.3",
      httpUrl: "http://127.0.0.1:9222/",
      port: 9222,
    });
  });

  test("inspects a websocket endpoint through /json/list fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        if (String(input) === "http://localhost:9222/json/version") {
          return new Response(null, { status: 404 });
        }
        if (String(input) === "http://localhost:9222/json/list") {
          return jsonResponse([
            {
              type: "browser",
              webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/fallback",
            },
          ]);
        }
        return new Response(null, { status: 404 });
      }),
    );

    const { inspectCdpEndpoint } =
      await import("../../packages/opensteer/src/local-browser/cdp-discovery.js");

    await expect(
      inspectCdpEndpoint({ endpoint: "ws://localhost:9222/devtools/browser/root" }),
    ).resolves.toEqual({
      endpoint: "ws://localhost:9222/devtools/browser/fallback",
      httpUrl: "http://localhost:9222/",
      port: 9222,
    });
  });

  test("deduplicates the same browser discovered via DevToolsActivePort and the fallback probe", async () => {
    chromeDiscoveryState.detectLocalBrowserInstallations.mockReturnValue([
      {
        brand: "chrome",
        executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        userDataDir: "/tmp/chrome",
      },
    ]);
    chromeDiscoveryState.readDevToolsActivePort.mockImplementation((userDataDir: string) =>
      userDataDir === "/tmp/chrome"
        ? { port: 9222, webSocketPath: "/devtools/browser/root" }
        : null,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        if (String(input) === "http://127.0.0.1:9222/json/version") {
          return jsonResponse({
            Browser: "Chrome/136.0.0.0",
            webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/root",
          });
        }
        return new Response(null, { status: 404 });
      }),
    );

    const { discoverLocalCdpBrowsers } =
      await import("../../packages/opensteer/src/local-browser/cdp-discovery.js");

    await expect(discoverLocalCdpBrowsers()).resolves.toEqual([
      {
        endpoint: "ws://127.0.0.1:9222/devtools/browser/root",
        browser: "Chrome/136.0.0.0",
        httpUrl: "http://127.0.0.1:9222/",
        installationBrand: "chrome",
        port: 9222,
        source: "devtools-active-port",
        userDataDir: "/tmp/chrome",
      },
    ]);
  });

  test("selects the unique highest-priority DevToolsActivePort candidate over the fallback port", async () => {
    chromeDiscoveryState.detectLocalBrowserInstallations.mockReturnValue([
      {
        brand: "chrome",
        executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        userDataDir: "/tmp/chrome",
      },
    ]);
    chromeDiscoveryState.readDevToolsActivePort.mockImplementation((userDataDir: string) =>
      userDataDir === "/tmp/chrome"
        ? { port: 9223, webSocketPath: "/devtools/browser/devtools" }
        : null,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        if (String(input) === "http://127.0.0.1:9223/json/version") {
          return jsonResponse({
            webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/browser/devtools",
          });
        }
        if (String(input) === "http://127.0.0.1:9222/json/version") {
          return jsonResponse({
            webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/fallback",
          });
        }
        return new Response(null, { status: 404 });
      }),
    );

    const { selectAttachBrowserCandidate } =
      await import("../../packages/opensteer/src/local-browser/cdp-discovery.js");

    await expect(selectAttachBrowserCandidate()).resolves.toMatchObject({
      endpoint: "ws://127.0.0.1:9223/devtools/browser/devtools",
      source: "devtools-active-port",
    });
  });

  test("throws a structured ambiguity error when multiple top-ranked browsers are discoverable", async () => {
    chromeDiscoveryState.detectLocalBrowserInstallations.mockReturnValue([
      {
        brand: "chrome",
        executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        userDataDir: "/tmp/chrome-a",
      },
      {
        brand: "chromium",
        executablePath: "/Applications/Chromium.app/Contents/MacOS/Chromium",
        userDataDir: "/tmp/chrome-b",
      },
    ]);
    chromeDiscoveryState.readDevToolsActivePort.mockImplementation((userDataDir: string) => {
      if (userDataDir === "/tmp/chrome-a") {
        return { port: 9222, webSocketPath: "/devtools/browser/a" };
      }
      if (userDataDir === "/tmp/chrome-b") {
        return { port: 9223, webSocketPath: "/devtools/browser/b" };
      }
      return null;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        if (String(input) === "http://127.0.0.1:9222/json/version") {
          return jsonResponse({
            webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/a",
          });
        }
        if (String(input) === "http://127.0.0.1:9223/json/version") {
          return jsonResponse({
            webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/browser/b",
          });
        }
        return new Response(null, { status: 404 });
      }),
    );

    const { OpensteerAttachAmbiguousError, selectAttachBrowserCandidate } =
      await import("../../packages/opensteer/src/local-browser/cdp-discovery.js");

    await expect(selectAttachBrowserCandidate()).rejects.toBeInstanceOf(
      OpensteerAttachAmbiguousError,
    );
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}
