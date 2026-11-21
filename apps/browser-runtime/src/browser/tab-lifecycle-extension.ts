import { withTimeout } from "@opensteer/shared/withTimeout";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  BrowserContext as PlaywrightBrowserContext,
  CDPSession as PlaywrightCdpSession,
  Page,
  Worker,
} from "playwright-core";
import { z } from "zod";

export const tabLifecycleExtensionDirName = ".opensteer-tab-lifecycle-extension";

/**
 * Minimal MV3 extension bundled with the Linux runtime for native profiles only.
 * Permissions are strictly `tabs` and `debugger`: no host permissions, no content
 * scripts, no `externally_connectable`, no network access.
 */
const extensionManifestJson = JSON.stringify(
  {
    manifest_version: 3,
    name: "Opensteer Tab Lifecycle Helper",
    version: "0.1.0",
    permissions: ["tabs", "debugger"],
    background: {
      service_worker: "sw.js",
    },
  },
  null,
  2,
);

const extensionServiceWorkerJs = `// Opensteer internal tab lifecycle helper (native profiles only).
chrome.tabs.onCreated.addListener(() => {});
chrome.tabs.onUpdated.addListener(() => {});

globalThis.__opensteer = {
  async inventory() {
    const [tabs, targets] = await Promise.all([
      chrome.tabs.query({}),
      chrome.debugger.getTargets(),
    ]);
    const targetByTabId = new Map();
    for (const target of targets) {
      if (target.type === "page" && typeof target.tabId === "number") {
        targetByTabId.set(target.tabId, target.id);
      }
    }
    return tabs
      .sort((a, b) => a.windowId - b.windowId || a.index - b.index)
      .map((tab) => ({
        tabId: tab.id,
        windowId: tab.windowId,
        index: tab.index,
        url: tab.url || tab.pendingUrl || "",
        title: tab.title || "",
        active: Boolean(tab.active),
        discarded: Boolean(tab.discarded),
        status: tab.status || "",
        targetId: targetByTabId.get(tab.id) ?? null,
      }));
  },
  async discardByTabId(tabId) {
    const updated = await chrome.tabs.discard(tabId);
    return {
      ok: Boolean(updated?.discarded),
      newTabId: typeof updated?.id === "number" ? updated.id : null,
    };
  },
  async activateByTabId(tabId) {
    const updated = await chrome.tabs.update(tabId, { active: true });
    return {
      ok: typeof updated?.id === "number",
      tabId: typeof updated?.id === "number" ? updated.id : null,
      discarded: Boolean(updated?.discarded),
    };
  },
  async removeByTabId(tabId) {
    try {
      await chrome.tabs.remove(tabId);
      return true;
    } catch {
      return false;
    }
  },
};
`;

const tabEntrySchema = z.object({
  tabId: z.number().int(),
  windowId: z.number().int(),
  index: z.number().int().nonnegative(),
  url: z.string(),
  title: z.string(),
  active: z.boolean(),
  discarded: z.boolean(),
  status: z.string(),
  targetId: z.string().nullable(),
});

export type ChromiumTabEntry = z.infer<typeof tabEntrySchema>;

const inventorySchema = z.array(tabEntrySchema);
const discardResultSchema = z.object({
  ok: z.boolean(),
  newTabId: z.number().int().nullable(),
});
const activateResultSchema = z.object({
  ok: z.boolean(),
  tabId: z.number().int().nullable(),
  discarded: z.boolean(),
});

export function isInternalExtensionUrl(url: string | undefined): boolean {
  return typeof url === "string" && url.startsWith("chrome-extension://");
}

/** Materializes the bundled MV3 lifecycle helper inside a native profile directory. */
export async function ensureTabLifecycleExtension(profileDirectory: string): Promise<string> {
  if (!path.isAbsolute(profileDirectory)) {
    throw new Error("Native profile directory must be absolute.");
  }
  const extensionDir = path.join(profileDirectory, tabLifecycleExtensionDirName);
  await mkdir(extensionDir, { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(path.join(extensionDir, "manifest.json"), extensionManifestJson, { mode: 0o600 }),
    writeFile(path.join(extensionDir, "sw.js"), extensionServiceWorkerJs, { mode: 0o600 }),
  ]);
  return extensionDir;
}

const workerWaitMs = 5_000;
const workerCallMs = 5_000;

/**
 * Private runtime bridge to the bundled MV3 lifecycle extension.
 * Detects stopped service workers via `Target.getTargets` and wakes them via
 * the private blank page before evaluating.
 */
export class ChromiumTabLifecycleBridge {
  private readonly context: PlaywrightBrowserContext;
  private readonly browserCdp: PlaywrightCdpSession;
  private readonly privatePage: Page | undefined;
  private serviceWorkerUrl: string | undefined;

  constructor(
    context: PlaywrightBrowserContext,
    browserCdp: PlaywrightCdpSession,
    privatePage?: Page,
  ) {
    this.context = context;
    this.browserCdp = browserCdp;
    this.privatePage = privatePage;
  }

  private async runningServiceWorkerTarget(): Promise<string | null> {
    const response = (await this.browserCdp.send("Target.getTargets")) as {
      targetInfos?: readonly { type?: string; url?: string }[];
    };
    const match = (response.targetInfos ?? []).find(
      (target) =>
        target.type === "service_worker" &&
        typeof target.url === "string" &&
        (this.serviceWorkerUrl
          ? target.url === this.serviceWorkerUrl
          : target.url.startsWith("chrome-extension://") && target.url.endsWith("/sw.js")),
    );
    if (match?.url) {
      this.serviceWorkerUrl = match.url;
      return match.url;
    }
    return null;
  }

  private async wakeServiceWorker(): Promise<void> {
    if (this.privatePage && !this.privatePage.isClosed()) {
      await this.privatePage.goto("about:blank").catch(() => undefined);
      return;
    }
    // Fallback when no private page is alive: create and immediately close a blank target.
    const created = (await this.browserCdp
      .send("Target.createTarget", { url: "about:blank" })
      .catch(() => null)) as { targetId?: string } | null;
    if (created?.targetId) {
      await this.browserCdp
        .send("Target.closeTarget", { targetId: created.targetId })
        .catch(() => undefined);
    }
  }

  private async ensureWorker(): Promise<Worker> {
    const deadline = Date.now() + workerWaitMs;
    let woke = false;
    while (Date.now() < deadline) {
      const runningUrl = await this.runningServiceWorkerTarget().catch(() => null);
      if (!runningUrl && !woke) {
        woke = true;
        await this.wakeServiceWorker();
      }
      const worker = this.context
        .serviceWorkers()
        .find((candidate) =>
          runningUrl
            ? candidate.url() === runningUrl
            : this.serviceWorkerUrl
              ? candidate.url() === this.serviceWorkerUrl
              : candidate.url().startsWith("chrome-extension://") &&
                candidate.url().endsWith("/sw.js"),
        );
      if (worker && runningUrl) {
        const ready = await withTimeout(
          worker.evaluate(
            () =>
              typeof (globalThis as { __opensteer?: unknown }).__opensteer === "object" &&
              (globalThis as { __opensteer?: unknown }).__opensteer !== null,
          ),
          1_000,
          { timeoutError: () => new Error("Helper worker readiness timed out.") },
        ).catch(() => false);
        if (ready) {
          this.serviceWorkerUrl = worker.url();
          return worker;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error("Opensteer tab lifecycle helper worker did not become ready.");
  }

  private async callWorker<T>(fn: (worker: Worker) => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const worker = await this.ensureWorker();
        return await withTimeout(fn(worker), workerCallMs, {
          timeoutError: () => new Error("Opensteer tab lifecycle helper call timed out."),
        });
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  async inventory(): Promise<readonly ChromiumTabEntry[]> {
    const raw = await this.callWorker((worker) =>
      worker.evaluate(() =>
        (
          globalThis as unknown as { __opensteer: { inventory(): Promise<unknown> } }
        ).__opensteer.inventory(),
      ),
    );
    return inventorySchema.parse(raw);
  }

  async tabIdForTargetId(targetId: string): Promise<number | null> {
    const tabs = await this.inventory();
    return tabs.find((tab) => tab.targetId === targetId)?.tabId ?? null;
  }

  async discardByTabId(tabId: number): Promise<number | null> {
    const raw = await this.callWorker((worker) =>
      worker.evaluate(
        (id) =>
          (
            globalThis as unknown as {
              __opensteer: { discardByTabId(tabId: number): Promise<unknown> };
            }
          ).__opensteer.discardByTabId(id),
        tabId,
      ),
    );
    const parsed = discardResultSchema.parse(raw);
    return parsed.ok ? parsed.newTabId : null;
  }

  async activateByTabId(tabId: number): Promise<boolean> {
    const raw = await this.callWorker((worker) =>
      worker.evaluate(
        (id) =>
          (
            globalThis as unknown as {
              __opensteer: { activateByTabId(tabId: number): Promise<unknown> };
            }
          ).__opensteer.activateByTabId(id),
        tabId,
      ),
    );
    return activateResultSchema.parse(raw).ok;
  }

  async removeByTabId(tabId: number): Promise<boolean> {
    const raw = await this.callWorker((worker) =>
      worker.evaluate(
        (id) =>
          (
            globalThis as unknown as {
              __opensteer: { removeByTabId(tabId: number): Promise<unknown> };
            }
          ).__opensteer.removeByTabId(id),
        tabId,
      ),
    );
    return raw === true;
  }
}
