import type { Browser, BrowserContext, Page } from "playwright";

interface BrowserTargetInfo {
  readonly targetId?: unknown;
  readonly type?: unknown;
  readonly openerId?: unknown;
}

interface NormalizedPageTargetInfo {
  readonly targetId: string;
  readonly openerId: string | undefined;
}

export async function readPageTargetId(page: Page): Promise<string | null> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const result = (await cdp.send("Target.getTargetInfo")) as {
      readonly targetInfo?: {
        readonly targetId?: unknown;
      };
    } | null;
    const targetId = result?.targetInfo?.targetId;
    return typeof targetId === "string" && targetId.length > 0 ? targetId : null;
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

export async function readBrowserPageTargetOrder(
  browserContext: BrowserContext,
): Promise<readonly string[]> {
  const browser = browserContext.browser();
  if (!browser || !hasBrowserCdpSession(browser)) {
    return [];
  }

  const cdp = await browser.newBrowserCDPSession();
  try {
    const result = (await cdp.send("Target.getTargets")) as {
      readonly targetInfos?: readonly BrowserTargetInfo[];
    } | null;
    return normalizeBrowserPageTargetOrder(result?.targetInfos ?? []);
  } catch {
    return [];
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

export async function orderPagesByBrowserTargetOrder(
  browserContext: BrowserContext,
  pages: readonly Page[],
): Promise<readonly Page[]> {
  if (pages.length < 2) {
    return pages;
  }

  const orderedTargetIds = await readBrowserPageTargetOrder(browserContext);
  if (orderedTargetIds.length === 0) {
    return pages;
  }

  const rankByTargetId = new Map(orderedTargetIds.map((targetId, index) => [targetId, index]));
  const targetIds = await Promise.all(
    pages.map((page) => readPageTargetId(page).catch(() => null)),
  );

  return pages
    .map((page, index) => {
      const targetId = targetIds[index] ?? undefined;
      return {
        page,
        index,
        rank: targetId === undefined ? undefined : rankByTargetId.get(targetId),
      };
    })
    .sort((left, right) => {
      if (left.rank !== undefined && right.rank !== undefined) {
        return left.rank - right.rank;
      }
      if (left.rank !== undefined) {
        return -1;
      }
      if (right.rank !== undefined) {
        return 1;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.page);
}

function hasBrowserCdpSession(browser: Browser): browser is Browser & {
  newBrowserCDPSession(): Promise<{
    send(method: string, params?: object): Promise<unknown>;
    detach(): Promise<void>;
  }>;
} {
  return (
    typeof (browser as Browser & { newBrowserCDPSession?: unknown }).newBrowserCDPSession ===
    "function"
  );
}

function normalizeBrowserPageTargetOrder(
  targetInfos: readonly BrowserTargetInfo[],
): readonly string[] {
  const reversedPageInfos: NormalizedPageTargetInfo[] = [];
  for (const targetInfo of targetInfos) {
    if (targetInfo.type !== "page") {
      continue;
    }
    const targetId =
      typeof targetInfo.targetId === "string" && targetInfo.targetId.length > 0
        ? targetInfo.targetId
        : undefined;
    if (targetId === undefined) {
      continue;
    }
    reversedPageInfos.push({
      targetId,
      openerId:
        typeof targetInfo.openerId === "string" && targetInfo.openerId.length > 0
          ? targetInfo.openerId
          : undefined,
    });
  }
  reversedPageInfos.reverse();

  const targetInfoById = new Map(
    reversedPageInfos.map((targetInfo) => [targetInfo.targetId, targetInfo] as const),
  );
  const orderedTargetIds: string[] = [];
  const placed = new Set<string>();

  const placeTarget = (targetId: string): void => {
    if (placed.has(targetId)) {
      return;
    }

    const targetInfo = targetInfoById.get(targetId);
    if (!targetInfo) {
      return;
    }

    const openerId =
      targetInfo.openerId !== undefined && targetInfoById.has(targetInfo.openerId)
        ? targetInfo.openerId
        : undefined;
    if (openerId === undefined) {
      orderedTargetIds.push(targetId);
      placed.add(targetId);
      return;
    }

    placeTarget(openerId);
    const openerIndex = orderedTargetIds.indexOf(openerId);
    const insertionIndex =
      openerIndex === -1
        ? orderedTargetIds.length
        : findPopupInsertionIndex(orderedTargetIds, openerIndex, targetInfoById);
    orderedTargetIds.splice(insertionIndex, 0, targetId);
    placed.add(targetId);
  };

  for (const targetInfo of reversedPageInfos) {
    placeTarget(targetInfo.targetId);
  }

  return orderedTargetIds;
}

function findPopupInsertionIndex(
  orderedTargetIds: readonly string[],
  openerIndex: number,
  targetInfoById: ReadonlyMap<string, NormalizedPageTargetInfo>,
): number {
  let index = openerIndex + 1;
  while (index < orderedTargetIds.length) {
    const candidateTargetId = orderedTargetIds[index];
    if (
      !candidateTargetId ||
      !isDescendantTarget(candidateTargetId, orderedTargetIds[openerIndex]!, targetInfoById)
    ) {
      break;
    }
    index += 1;
  }
  return index;
}

function isDescendantTarget(
  targetId: string,
  ancestorTargetId: string,
  targetInfoById: ReadonlyMap<string, NormalizedPageTargetInfo>,
): boolean {
  let currentTargetId: string | undefined = targetId;
  while (currentTargetId !== undefined) {
    const currentTargetInfo = targetInfoById.get(currentTargetId);
    const openerId = currentTargetInfo?.openerId;
    if (openerId === undefined) {
      return false;
    }
    if (openerId === ancestorTargetId) {
      return true;
    }
    currentTargetId = openerId;
  }
  return false;
}
