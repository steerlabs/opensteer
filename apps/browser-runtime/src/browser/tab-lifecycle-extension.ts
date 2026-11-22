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
 * Permissions are strictly `tabs`, `tabGroups`, `storage` (session storage only, for which tab
 * each named group was made for) and `debugger`: no host permissions, no content
 * scripts, no `externally_connectable`, no network access.
 */
const extensionManifestJson = JSON.stringify(
  {
    manifest_version: 3,
    name: "Opensteer Tab Lifecycle Helper",
    version: "0.1.0",
    permissions: ["tabs", "debugger", "tabGroups", "storage"],
    background: {
      service_worker: "sw.js",
    },
  },
  null,
  2,
);

/** The helper's service worker source; exported so its rules can be tested alone. */
export const extensionServiceWorkerJs = `// Opensteer internal tab lifecycle helper (native profiles only).
// A saved tab's identity is the title of its own tab group: Chromium keeps it through discard and
// session restore, and no page can read or change it.
// The worker records which tab each group it made was made for (chrome.storage.session: it survives
// a worker restart and ends with the browser). Any other member of such a group is taken out
// whenever it is seen, whatever the count, and the named tab leaves its group only in nameTab.
// After a browser restart the record is empty and nothing in it is read: the runtime decides.
const OWNERS = "opensteer.groupOwners";
let ownersWrite = Promise.resolve();
async function readOwners() {
  return (await chrome.storage.session.get(OWNERS))[OWNERS] ?? {};
}
function updateOwners(change) {
  ownersWrite = ownersWrite.then(async () => {
    const owners = await readOwners();
    change(owners);
    await chrome.storage.session.set({ [OWNERS]: owners });
  }).catch(() => {});
  return ownersWrite;
}
async function guardGroup(tabId, groupId) {
  if (typeof tabId !== "number" || typeof groupId !== "number" || groupId < 0) return;
  await ownersWrite;
  const owner = (await readOwners())[groupId];
  if (owner !== undefined && owner !== tabId) await chrome.tabs.ungroup(tabId).catch(() => {});
}
// Chromium discards no tab by itself (memory pressure, Memory Saver): only the runtime does, so a
// tab's page is never replaced behind it.
function keepFromAutoDiscard(tabId) {
  if (typeof tabId === "number") chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
}
chrome.tabs.query({}).then((tabs) => tabs.forEach((tab) => keepFromAutoDiscard(tab.id)), () => {});
chrome.tabs.onCreated.addListener((tab) => {
  keepFromAutoDiscard(tab.id);
  void guardGroup(tab.id, tab.groupId);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if ("groupId" in changeInfo) void guardGroup(tabId, changeInfo.groupId);
});
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  keepFromAutoDiscard(addedTabId);
  void updateOwners((owners) => {
    for (const groupId of Object.keys(owners))
      if (owners[groupId] === removedTabId) owners[groupId] = addedTabId;
  });
});
chrome.tabs.onRemoved.addListener((tabId) => {
  void ownersWrite.then(async () => {
    const owners = await readOwners();
    for (const groupId of Object.keys(owners)) {
      if (owners[groupId] !== tabId) continue;
      // The named tab is gone: no tab left in its group inherits its name.
      const members = await chrome.tabs.query({ groupId: Number(groupId) }).catch(() => []);
      for (const member of members) await chrome.tabs.ungroup(member.id).catch(() => {});
      await updateOwners((current) => {
        delete current[groupId];
      });
    }
  });
});
globalThis.__opensteer = {
  async inventory() {
    const [tabs, targets, groups] = await Promise.all([
      chrome.tabs.query({}),
      chrome.debugger.getTargets(),
      chrome.tabGroups.query({}),
    ]);
    const titleByGroupId = new Map();
    for (const group of groups) titleByGroupId.set(group.id, group.title || "");
    const targetByTabId = new Map();
    for (const target of targets) {
      if (target.type === "page" && typeof target.tabId === "number") {
        targetByTabId.set(target.tabId, target.id);
      }
    }
    // The read agrees with itself only if every tab's group is among the groups read.
    const consistent = tabs.every(
      (tab) => typeof tab.groupId !== "number" || tab.groupId < 0 || titleByGroupId.has(tab.groupId),
    );
    const rows = tabs
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
        identity:
          typeof tab.groupId === "number" && tab.groupId >= 0
            ? titleByGroupId.get(tab.groupId) || null
            : null,
      }));
    return { consistent, rows };
  },
  async nameTab(tabId, name) {
    const tab = await chrome.tabs.get(tabId);
    if (typeof tab.groupId === "number" && tab.groupId >= 0) {
      const group = await chrome.tabGroups.get(tab.groupId);
      const members = await chrome.tabs.query({ groupId: tab.groupId });
      const owner = (await readOwners())[tab.groupId];
      if (group.title === name && members.length === 1 && (owner === undefined || owner === tabId)) {
        // Already this tab's own name (after a restart, the record is taken up again here).
        await updateOwners((owners) => {
          owners[tab.groupId] = tabId;
        });
        return true;
      }
      await chrome.tabs.ungroup(tabId);
    }
    const groupId = await chrome.tabs.group({ tabIds: [tabId] });
    await updateOwners((owners) => {
      owners[groupId] = tabId;
    });
    await chrome.tabGroups.update(groupId, { title: name, collapsed: false });
    return true;
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

/**
 * The longest name the runtime writes or reads (K10): the smaller of 512 and what Chromium keeps
 * through a restart (4096 measured). A longer title is that row's problem: it names nothing.
 */
export const tabNameBound = 512;

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
  /** The title of the tab's own group: the Home surface id Opensteer named it with, or null. */
  identity: z.string().max(tabNameBound).nullable().optional().catch(null),
});

export type ChromiumTabEntry = z.infer<typeof tabEntrySchema>;

const inventorySchema = z.object({ consistent: z.boolean(), rows: z.array(tabEntrySchema) });
const discardResultSchema = z.object({
  ok: z.boolean(),
  newTabId: z.number().int().nullable(),
});
const activateResultSchema = z.object({
  ok: z.boolean(),
  tabId: z.number().int().nullable(),
  discarded: z.boolean(),
});

/** Chromium's own answer to activating a tab: which tab it activated, and whether discarded. */
export type ActivateReply = z.infer<typeof activateResultSchema>;

export function isInternalExtensionUrl(url: string | undefined): boolean {
  return typeof url === "string" && url.startsWith("chrome-extension://");
}

function extensionOriginFromUrl(url: string | undefined): string | null {
  if (typeof url !== "string") return null;
  const match = /^(chrome-extension:\/\/[^/]+)/u.exec(url);
  return match?.[1] ?? null;
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
const inventoryReadAttempts = 3;
const workerCallMs = 5_000;
const cdpStepMs = 1_500;

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
  private wakeInFlight: Promise<void> | null = null;

  constructor(
    context: PlaywrightBrowserContext,
    browserCdp: PlaywrightCdpSession,
    privatePage?: Page,
  ) {
    this.context = context;
    this.browserCdp = browserCdp;
    this.privatePage = privatePage;
  }

  private async runningServiceWorkerTarget(timeoutMs = cdpStepMs): Promise<string | null> {
    const response = (await withTimeout(this.browserCdp.send("Target.getTargets"), timeoutMs, {
      timeoutError: () => new Error("Helper Target.getTargets timed out."),
    })) as {
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

  private async wakeServiceWorker(remainingMs: number): Promise<void> {
    if (!this.privatePage || this.privatePage.isClosed() || remainingMs <= 0) return;
    if (this.wakeInFlight) {
      await withTimeout(this.wakeInFlight, Math.max(100, remainingMs), {
        timeoutError: () => new Error("Helper wake wait timed out."),
      }).catch(() => undefined);
      return;
    }
    const run = this.wakeServiceWorkerOnce(remainingMs).finally(() => {
      if (this.wakeInFlight === run) this.wakeInFlight = null;
    });
    this.wakeInFlight = run;
    await run;
  }

  private async wakeServiceWorkerOnce(remainingMs: number): Promise<void> {
    if (!this.privatePage || this.privatePage.isClosed() || remainingMs <= 0) return;
    const stepMs = Math.max(100, Math.min(cdpStepMs, remainingMs));
    const origin =
      extensionOriginFromUrl(this.serviceWorkerUrl) ??
      extensionOriginFromUrl(
        this.context
          .serviceWorkers()
          .find((candidate) => candidate.url().endsWith("/sw.js"))
          ?.url(),
      );
    if (!origin) {
      await withTimeout(this.privatePage.goto("about:blank"), stepMs, {
        timeoutError: () => new Error("Helper blank anchor navigation timed out."),
      }).catch(() => undefined);
      return;
    }
    let session: PlaywrightCdpSession | undefined;
    try {
      await withTimeout(this.privatePage.goto(`${origin}/manifest.json`), stepMs, {
        timeoutError: () => new Error("Helper manifest navigation timed out."),
      }).catch(() => undefined);
      session = await withTimeout(this.context.newCDPSession(this.privatePage), stepMs, {
        timeoutError: () => new Error("Helper CDP attach timed out."),
      });
      await withTimeout(session.send("ServiceWorker.enable"), stepMs, {
        timeoutError: () => new Error("Helper ServiceWorker.enable timed out."),
      });
      await withTimeout(
        session.send("ServiceWorker.startWorker", { scopeURL: `${origin}/` }),
        stepMs,
        {
          timeoutError: () => new Error("Helper ServiceWorker.startWorker timed out."),
        },
      );
    } catch {
      // Best effort: ensureWorker continues polling until deadline.
    } finally {
      await withTimeout(session?.detach() ?? Promise.resolve(), 500, {
        timeoutError: () => new Error("Helper CDP detach timed out."),
      }).catch(() => undefined);
      if (!this.privatePage.isClosed()) {
        await withTimeout(this.privatePage.goto("about:blank"), 500, {
          timeoutError: () => new Error("Helper anchor reset timed out."),
        }).catch(() => undefined);
      }
    }
  }

  private async ensureWorker(): Promise<Worker> {
    const deadline = Date.now() + workerWaitMs;
    let woke = false;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const runningUrl = await this.runningServiceWorkerTarget(
        Math.max(100, Math.min(cdpStepMs, remaining)),
      ).catch(() => null);
      if (!runningUrl && !woke) {
        woke = true;
        await this.wakeServiceWorker(deadline - Date.now());
      }
      if (Date.now() >= deadline) break;
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
          Math.max(100, Math.min(1_000, deadline - Date.now())),
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

  /**
   * A read is retried once. A change (discard, activate, remove) is retried only when the worker
   * could not be reached: once it was asked, a failure or timeout is an unknown outcome the caller
   * resolves from the inventory, never a second request (Rule B).
   */
  private async callWorker<T>(
    fn: (worker: Worker) => Promise<T>,
    kind: "read" | "change" = "read",
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      let asked = false;
      try {
        const worker = await this.ensureWorker();
        asked = true;
        return await withTimeout(fn(worker), workerCallMs, {
          timeoutError: () => new Error("Opensteer tab lifecycle helper call timed out."),
        });
      } catch (error) {
        lastError = error;
        if (asked && kind === "change") break;
      }
    }
    throw lastError;
  }

  /**
   * The one reading of Chromium's tabs (K1): rows only from a read that agrees with itself (every
   * tab's group among the groups read); otherwise read again, and then throw: "not known".
   */
  async inventory(deadline = Number.POSITIVE_INFINITY): Promise<readonly ChromiumTabEntry[]> {
    for (
      let attempt = 0;
      attempt < inventoryReadAttempts && (attempt === 0 || performance.now() < deadline);
      attempt++
    ) {
      const raw = await this.callWorker((worker) =>
        worker.evaluate(() =>
          (
            globalThis as unknown as { __opensteer: { inventory(): Promise<unknown> } }
          ).__opensteer.inventory(),
        ),
      );
      const read = inventorySchema.parse(raw);
      if (read.consistent) return read.rows;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("The tab inventory did not agree with itself.");
  }

  /** Discards a tab; the id Chromium answers is the tab's id afterwards (it may be new). */
  async discardByTabId(tabId: number): Promise<number | null> {
    const raw = await this.callWorker(
      (worker) =>
        worker.evaluate(
          (id) =>
            (
              globalThis as unknown as {
                __opensteer: { discardByTabId(tabId: number): Promise<unknown> };
              }
            ).__opensteer.discardByTabId(id),
          tabId,
        ),
      "change",
    );
    const parsed = discardResultSchema.parse(raw);
    return parsed.ok ? parsed.newTabId : null;
  }

  async activateByTabId(tabId: number): Promise<ActivateReply> {
    const raw = await this.callWorker(
      (worker) =>
        worker.evaluate(
          (id) =>
            (
              globalThis as unknown as {
                __opensteer: { activateByTabId(tabId: number): Promise<unknown> };
              }
            ).__opensteer.activateByTabId(id),
          tabId,
        ),
      "change",
    );
    return activateResultSchema.parse(raw);
  }

  async nameTab(tabId: number, name: string): Promise<boolean> {
    const raw = await this.callWorker(
      (worker) =>
        worker.evaluate(
          ([id, title]) =>
            (
              globalThis as unknown as {
                __opensteer: { nameTab(tabId: number, name: string): Promise<unknown> };
              }
            ).__opensteer.nameTab(id, title),
          [tabId, name] as const,
        ),
      "change",
    );
    return raw === true;
  }

  async removeByTabId(tabId: number): Promise<boolean> {
    const raw = await this.callWorker(
      (worker) =>
        worker.evaluate(
          (id) =>
            (
              globalThis as unknown as {
                __opensteer: { removeByTabId(tabId: number): Promise<unknown> };
              }
            ).__opensteer.removeByTabId(id),
          tabId,
        ),
      "change",
    );
    return raw === true;
  }
}
