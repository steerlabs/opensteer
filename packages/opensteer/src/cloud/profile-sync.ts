import { promisify } from "node:util";
import { gzip as gzipCallback } from "node:zlib";

import type { PortableBrowserProfileSnapshot } from "@opensteer/protocol";

import type { BrowserBrandId } from "../local-browser/browser-brands.js";
import { readBrowserCookies } from "../local-browser/cookie-reader.js";
import { prepareBrowserProfileSyncCookies } from "./cookie-sync.js";
import type { OpensteerCloudClient } from "./client.js";

const gzip = promisify(gzipCallback);

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_POLL_TIMEOUT_MS = 5 * 60_000;

export interface SyncBrowserProfileCookiesInput {
  readonly profileId: string;
  readonly brandId?: BrowserBrandId;
  readonly userDataDir?: string;
  readonly profileDirectory?: string;
  readonly domains?: readonly string[];
}

export async function syncBrowserProfileCookies(
  client: OpensteerCloudClient,
  input: SyncBrowserProfileCookiesInput,
): Promise<Awaited<ReturnType<OpensteerCloudClient["getBrowserProfileImport"]>>> {
  const result = await readBrowserCookies({
    ...(input.brandId === undefined ? {} : { brandId: input.brandId }),
    ...(input.userDataDir === undefined ? {} : { userDataDir: input.userDataDir }),
    ...(input.profileDirectory === undefined ? {} : { profileDirectory: input.profileDirectory }),
  });

  const prepared = prepareBrowserProfileSyncCookies({
    cookies: result.cookies,
    ...(input.domains === undefined ? {} : { domains: input.domains }),
  });

  if (prepared.cookies.length === 0) {
    throw new Error("No syncable cookies found for the selected browser and scope.");
  }

  const snapshot: PortableBrowserProfileSnapshot = {
    version: "portable-cookies-v1",
    source: {
      browserFamily: "chromium",
      browserBrand: result.brandId,
      captureMethod: "sqlite",
      platform: normalizePlatform(process.platform),
      capturedAt: Date.now(),
    },
    cookies: prepared.cookies,
  };

  const payload = await gzip(Buffer.from(JSON.stringify(snapshot), "utf8"));

  const created = await client.createBrowserProfileImport({
    profileId: input.profileId,
  });

  if (payload.length > created.maxUploadBytes) {
    throw new Error(
      `Compressed cookie snapshot is ${String(payload.length)} bytes, exceeding the ${String(created.maxUploadBytes)} byte upload limit.`,
    );
  }

  const uploaded = await client.uploadBrowserProfileImportPayload({
    uploadUrl: created.uploadUrl,
    payload,
  });

  return uploaded.status === "ready"
    ? uploaded
    : waitForBrowserProfileImport(client, created.importId);
}

async function waitForBrowserProfileImport(
  client: OpensteerCloudClient,
  importId: string,
): Promise<Awaited<ReturnType<OpensteerCloudClient["getBrowserProfileImport"]>>> {
  const deadline = Date.now() + DEFAULT_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = await client.getBrowserProfileImport(importId);
    if (current.status === "ready") {
      return current;
    }
    if (current.status === "failed") {
      throw new Error(current.error ?? "Browser profile sync failed.");
    }
    await sleep(DEFAULT_POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for browser profile sync "${importId}" to finish.`);
}

function normalizePlatform(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return platform;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
