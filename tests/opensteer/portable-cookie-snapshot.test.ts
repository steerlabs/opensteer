import { afterEach, describe, expect, test, vi } from "vitest";

const inspectCdpEndpointMock = vi.hoisted(() => vi.fn());
const selectAttachBrowserCandidateMock = vi.hoisted(() => vi.fn());
const connectPlaywrightChromiumBrowserMock = vi.hoisted(() => vi.fn());

vi.mock("../../packages/opensteer/src/local-browser/cdp-discovery.js", () => ({
  inspectCdpEndpoint: inspectCdpEndpointMock,
  selectAttachBrowserCandidate: selectAttachBrowserCandidateMock,
}));

vi.mock("@opensteer/engine-playwright", () => ({
  connectPlaywrightChromiumBrowser: connectPlaywrightChromiumBrowserMock,
}));

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  inspectCdpEndpointMock.mockReset();
  selectAttachBrowserCandidateMock.mockReset();
  connectPlaywrightChromiumBrowserMock.mockReset();
});

describe("portable cookie snapshot capture", () => {
  test("captures cookies from an explicitly attached browser", async () => {
    inspectCdpEndpointMock.mockResolvedValueOnce({
      endpoint: "ws://127.0.0.1:9222/devtools/browser/root",
      browser: "Chromium/136.0.0.0",
    });
    connectPlaywrightChromiumBrowserMock.mockResolvedValueOnce(
      createBrowser([
        {
          name: "session",
          value: "abc",
          domain: ".example.com",
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
          expires: -1,
        },
      ]),
    );

    const { capturePortableBrowserProfileSnapshot } = await import(
      "../../packages/opensteer/src/cloud/portable-cookie-snapshot.js"
    );

    await expect(
      capturePortableBrowserProfileSnapshot({
        attachEndpoint: "9222",
        domains: ["example.com"],
      }),
    ).resolves.toEqual({
      version: "portable-cookies-v1",
      source: {
        browserFamily: "chromium",
        browserName: "Chromium",
        browserMajor: "136",
        platform: "macos",
        capturedAt: expect.any(Number),
      },
      cookies: [
        {
          name: "session",
          value: "abc",
          domain: ".example.com",
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "lax",
          session: true,
          expiresAt: null,
        },
      ],
    });

    expect(inspectCdpEndpointMock).toHaveBeenCalledWith({ endpoint: "9222" });
    expect(selectAttachBrowserCandidateMock).not.toHaveBeenCalled();
    expect(connectPlaywrightChromiumBrowserMock).toHaveBeenCalledWith({
      url: "ws://127.0.0.1:9222/devtools/browser/root",
    });
  });

  test("auto-discovers a local attached browser when no endpoint is provided", async () => {
    selectAttachBrowserCandidateMock.mockResolvedValueOnce({
      endpoint: "ws://127.0.0.1:9223/devtools/browser/root",
      browser: "Helium/146.0.0.0",
    });
    connectPlaywrightChromiumBrowserMock.mockResolvedValueOnce(
      createBrowser([
        {
          name: "auth",
          value: "xyz",
          domain: ".helium.dev",
          path: "/",
          secure: true,
          httpOnly: false,
          expires: 1_900_000_000,
        },
      ]),
    );

    const { capturePortableBrowserProfileSnapshot } = await import(
      "../../packages/opensteer/src/cloud/portable-cookie-snapshot.js"
    );

    const snapshot = await capturePortableBrowserProfileSnapshot({
      domains: ["helium.dev"],
    });

    expect(snapshot.source.browserName).toBe("Helium");
    expect(snapshot.source.browserMajor).toBe("146");
    expect(snapshot.cookies).toHaveLength(1);
    expect(inspectCdpEndpointMock).not.toHaveBeenCalled();
    expect(selectAttachBrowserCandidateMock).toHaveBeenCalledWith({});
  });

  test("fails fast when the selected browser has no syncable cookies", async () => {
    selectAttachBrowserCandidateMock.mockResolvedValueOnce({
      endpoint: "ws://127.0.0.1:9224/devtools/browser/root",
      browser: "Chromium/136.0.0.0",
    });
    connectPlaywrightChromiumBrowserMock.mockResolvedValueOnce(createBrowser([]));

    const { capturePortableBrowserProfileSnapshot } = await import(
      "../../packages/opensteer/src/cloud/portable-cookie-snapshot.js"
    );

    await expect(
      capturePortableBrowserProfileSnapshot({
        domains: ["example.com"],
      }),
    ).rejects.toThrow("No syncable cookies found for the selected browser and scope.");
  });
});

function createBrowser(cookies: readonly Record<string, unknown>[]) {
  return {
    contexts: () => [
      {
        cookies: vi.fn(async () => cookies),
      },
    ],
    version: () => "Chromium/136.0.0.0",
    close: vi.fn(async () => undefined),
  };
}
