import type { BrowserContext } from "playwright";

import { describe, expect, test, vi } from "vitest";

import { readBrowserPageTargetOrder } from "../../packages/opensteer/src/local-view/browser-target-order.js";

describe("browser target order", () => {
  test("drops cyclic opener chains instead of recursing forever", async () => {
    const detach = vi.fn(async () => undefined);
    const send = vi.fn(async () => ({
      targetInfos: [
        {
          targetId: "tab-a",
          type: "page",
          openerId: "tab-b",
        },
        {
          targetId: "tab-b",
          type: "page",
          openerId: "tab-a",
        },
        {
          targetId: "worker-1",
          type: "worker",
        },
      ],
    }));

    const browserContext = {
      browser: () => ({
        newBrowserCDPSession: async () => ({
          send,
          detach,
        }),
      }),
    } as unknown as BrowserContext;

    await expect(readBrowserPageTargetOrder(browserContext)).resolves.toEqual(["tab-b", "tab-a"]);
    expect(send).toHaveBeenCalledWith("Target.getTargets");
    expect(detach).toHaveBeenCalledTimes(1);
  });
});
