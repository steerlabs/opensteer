import { promisify } from "node:util";
import { gzip as gzipCallback } from "node:zlib";

import type { PortableBrowserProfileSnapshot } from "@opensteer/cloud-contracts";
import { connectPlaywrightChromiumBrowser } from "@opensteer/engine-playwright";

import {
  inspectCdpEndpoint,
  selectAttachBrowserCandidate,
} from "../local-browser/cdp-discovery.js";
import type { BrowserBrandId } from "../local-browser/browser-brands.js";
import type { CookieCaptureStrategy } from "../local-browser/cookie-capture.js";
import { prepareBrowserProfileSyncCookies } from "./cookie-sync.js";

const gzip = promisify(gzipCallback);

export interface CapturePortableBrowserProfileSnapshotInput {
  readonly attachEndpoint?: string;
  readonly browserBrand?: BrowserBrandId;
  readonly captureMethod?: CookieCaptureStrategy;
  readonly domains?: readonly string[];
  readonly timeoutMs?: number;
}

export async function capturePortableBrowserProfileSnapshot(
  input: CapturePortableBrowserProfileSnapshotInput = {},
): Promise<PortableBrowserProfileSnapshot> {
  const attached = input.attachEndpoint
    ? await inspectCdpEndpoint({
        endpoint: input.attachEndpoint,
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      })
    : await selectAttachBrowserCandidate({
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      });

  const browser = await connectPlaywrightChromiumBrowser({
    url: attached.endpoint,
  });

  try {
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error("Attached browser did not expose a default browser context.");
    }

    const prepared = prepareBrowserProfileSyncCookies({
      cookies: await context.cookies(),
      ...(input.domains === undefined ? {} : { domains: input.domains }),
    });
    if (prepared.cookies.length === 0) {
      throw new Error("No syncable cookies found for the selected browser and scope.");
    }

    const browserVersion = browser.version();
    const source = parseSnapshotSource(attached.browser ?? browserVersion);
    return {
      version: "portable-cookies-v1",
      source: {
        browserFamily: "chromium",
        ...(source.browserName === undefined ? {} : { browserName: source.browserName }),
        ...(source.browserMajor === undefined ? {} : { browserMajor: source.browserMajor }),
        ...(input.browserBrand === undefined ? {} : { browserBrand: input.browserBrand }),
        ...(input.captureMethod === undefined ? {} : { captureMethod: input.captureMethod }),
        platform: normalizePlatform(process.platform),
        capturedAt: Date.now(),
      },
      cookies: prepared.cookies,
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export async function encodePortableBrowserProfileSnapshot(
  snapshot: PortableBrowserProfileSnapshot,
): Promise<Buffer> {
  return gzip(Buffer.from(JSON.stringify(snapshot), "utf8"));
}

function parseSnapshotSource(value: string | undefined): {
  readonly browserName?: string;
  readonly browserMajor?: string;
} {
  if (!value) {
    return {};
  }

  const trimmed = value.trim();
  const browserName = trimmed.split("/")[0]?.trim() || undefined;
  const majorMatch = trimmed.match(/(\d+)/);
  return {
    ...(browserName === undefined ? {} : { browserName }),
    ...(majorMatch?.[1] === undefined ? {} : { browserMajor: majorMatch[1] }),
  };
}

function normalizePlatform(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return platform;
}
