import type { BrowserContext, Page } from "playwright";

import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  readBrowserPageTargetOrder: vi.fn(),
  readPageTargetId: vi.fn(),
}));

vi.mock("../../packages/opensteer/src/local-view/browser-target-order.js", () => ({
  readBrowserPageTargetOrder: state.readBrowserPageTargetOrder,
  readPageTargetId: state.readPageTargetId,
}));

import { LocalViewRuntimeState } from "../../packages/opensteer/src/local-view/runtime-state.js";
import { TabStateTracker } from "../../packages/opensteer/src/local-view/tab-state-tracker.js";

describe("TabStateTracker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.readBrowserPageTargetOrder.mockImplementation(async () => ["page-1"]);
    state.readPageTargetId.mockImplementation(async () => "page-1");
  });

  test("does not query browser target order when tracking a single page", async () => {
    const page = {
      title: vi.fn(async () => "Single Tab"),
      url: vi.fn(() => "https://example.com/"),
      evaluate: vi.fn(async () => ({
        visibilityState: "visible",
        hasFocus: true,
      })),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as Page;

    const browserContext = {
      pages: vi.fn(() => [page]),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as BrowserContext;
    const onTabsChanged = vi.fn();

    const tracker = new TabStateTracker({
      browserContext,
      sessionId: "session-1",
      pollMs: 10_000,
      runtimeState: new LocalViewRuntimeState(),
      initialActivePage: page,
      onTabsChanged,
      onActivePageChanged: vi.fn(),
    });

    tracker.start();
    await vi.waitFor(() => expect(onTabsChanged).toHaveBeenCalledTimes(1));
    tracker.stop();

    expect(state.readBrowserPageTargetOrder).not.toHaveBeenCalled();
    expect(onTabsChanged).toHaveBeenCalledWith({
      activeTabIndex: 0,
      tabs: [
        {
          index: 0,
          targetId: "page-1",
          url: "https://example.com/",
          title: "Single Tab",
          active: true,
        },
      ],
    });
  });
});
