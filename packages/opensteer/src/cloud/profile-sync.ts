import type { BrowserBrandId } from "../local-browser/browser-brands.js";
import {
  acquireCdpEndpoint,
  relaunchBrowserNormally,
  resolveCookieCaptureStrategy,
  type CookieCaptureStrategy,
} from "../local-browser/cookie-capture.js";
import type { OpensteerCloudClient } from "./client.js";
import {
  capturePortableBrowserProfileSnapshot,
  encodePortableBrowserProfileSnapshot,
} from "./portable-cookie-snapshot.js";

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_POLL_TIMEOUT_MS = 5 * 60_000;

export interface SyncBrowserProfileCookiesInput {
  readonly profileId: string;
  readonly attachEndpoint?: string;
  readonly brandId?: BrowserBrandId;
  readonly userDataDir?: string;
  readonly profileDirectory?: string;
  readonly executablePath?: string;
  readonly strategy?: CookieCaptureStrategy;
  readonly restoreBrowser?: boolean;
  readonly domains?: readonly string[];
  readonly timeoutMs?: number;
}

export async function syncBrowserProfileCookies(
  client: OpensteerCloudClient,
  input: SyncBrowserProfileCookiesInput,
): Promise<Awaited<ReturnType<OpensteerCloudClient["getBrowserProfileImport"]>>> {
  const resolved = await resolveCookieCaptureStrategy({
    ...(input.attachEndpoint === undefined ? {} : { attachEndpoint: input.attachEndpoint }),
    ...(input.brandId === undefined ? {} : { brandId: input.brandId }),
    ...(input.userDataDir === undefined ? {} : { userDataDir: input.userDataDir }),
    ...(input.profileDirectory === undefined ? {} : { profileDirectory: input.profileDirectory }),
    ...(input.executablePath === undefined ? {} : { executablePath: input.executablePath }),
    ...(input.strategy === undefined ? {} : { strategy: input.strategy }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });
  const shouldRestoreBrowser =
    (input.restoreBrowser ?? true) && resolved.strategy === "managed-relaunch";

  let captureSource: Awaited<ReturnType<typeof acquireCdpEndpoint>> | undefined;

  try {
    captureSource = await acquireCdpEndpoint(resolved);

    const snapshot = await capturePortableBrowserProfileSnapshot({
      attachEndpoint: captureSource.cdpEndpoint,
      ...(captureSource.brandId === undefined ? {} : { browserBrand: captureSource.brandId }),
      captureMethod: captureSource.strategy,
      ...(input.domains === undefined ? {} : { domains: input.domains }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });
    const payload = await encodePortableBrowserProfileSnapshot(snapshot);

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
  } finally {
    await captureSource?.cleanup().catch(() => undefined);
    if (shouldRestoreBrowser && resolved.executablePath !== undefined) {
      relaunchBrowserNormally(resolved.executablePath);
    }
  }
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
