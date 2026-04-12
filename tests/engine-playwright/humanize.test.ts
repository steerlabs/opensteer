import type { Page } from "playwright";
import { chromium } from "playwright";
import { afterEach, expect, test, vi } from "vitest";

import { createPoint } from "../../packages/browser-core/src/index.js";
import { createPlaywrightBrowserCoreEngine } from "../../packages/engine-playwright/src/index.js";
import { humanizedTextInput } from "../../packages/engine-playwright/src/humanize.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("humanizedTextInput falls back to keyboard.type for unknown Unicode graphemes", async () => {
  vi.useFakeTimers();

  const keyboard = {
    down: vi.fn(async (key: string) => {
      if (key === "你" || key === "e\u0301" || key === "👨‍👩‍👧‍👦") {
        throw new Error(`Unknown key: '${key}'`);
      }
    }),
    up: vi.fn(async () => {}),
    type: vi.fn(async () => {}),
  };
  const page = { keyboard } as unknown as Page;

  const input = humanizedTextInput(page, "A你e\u0301👨‍👩‍👧‍👦B");
  await vi.runAllTimersAsync();
  await input;

  expect(keyboard.down.mock.calls.map(([key]) => key)).toEqual(["A", "你", "e\u0301", "👨‍👩‍👧‍👦", "B"]);
  expect(keyboard.up.mock.calls.map(([key]) => key)).toEqual(["A", "B"]);
  expect(keyboard.type.mock.calls.map(([key]) => key)).toEqual(["你", "e\u0301", "👨‍👩‍👧‍👦"]);
});

for (const scenario of [
  {
    name: "humanizes scroll movement and wheel cadence when both flags are enabled",
    humanize: { mouse: true, scroll: true },
    moveCalls: "multiple",
    wheelCalls: "multiple",
  },
  {
    name: "humanizes scroll movement even when only mouse humanization is enabled",
    humanize: { mouse: true, scroll: false },
    moveCalls: "multiple",
    wheelCalls: 1,
  },
  {
    name: "keeps direct cursor movement when only scroll cadence is humanized",
    humanize: { mouse: false, scroll: true },
    moveCalls: 1,
    wheelCalls: "multiple",
  },
] as const) {
  test(scenario.name, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        viewport: {
          width: 800,
          height: 600,
        },
      });

      try {
        const page = await context.newPage();
        await page.setContent(`
          <!doctype html>
          <html lang="en">
            <head>
              <style>
                body { margin: 0; }
                #content { height: 3200px; }
              </style>
            </head>
            <body>
              <div id="content"></div>
            </body>
          </html>
        `);

        const engine = await createPlaywrightBrowserCoreEngine({
          browser,
          attachedContext: context,
          attachedPage: page,
          closeBrowserOnDispose: false,
          closeAttachedContextOnSessionClose: false,
          context: {
            viewport: {
              width: 800,
              height: 600,
            },
            humanize: scenario.humanize,
          },
        });

        try {
          const sessionRef = await engine.createSession();
          const created = await engine.createPage({ sessionRef });
          const moveSpy = vi.spyOn(page.mouse, "move");
          const wheelSpy = vi.spyOn(page.mouse, "wheel");

          await engine.mouseScroll({
            pageRef: created.data.pageRef,
            point: createPoint(200, 240),
            coordinateSpace: "layout-viewport-css",
            delta: createPoint(0, 400),
          });

          expect(moveSpy.mock.calls.at(-1)).toEqual([200, 240]);
          if (scenario.moveCalls === "multiple") {
            expect(moveSpy.mock.calls.length).toBeGreaterThan(1);
          } else {
            expect(moveSpy).toHaveBeenCalledTimes(scenario.moveCalls);
          }

          if (scenario.wheelCalls === "multiple") {
            expect(wheelSpy.mock.calls.length).toBeGreaterThan(1);
          } else {
            expect(wheelSpy).toHaveBeenCalledTimes(scenario.wheelCalls);
          }

          expect(await page.evaluate(() => Math.round(globalThis.scrollY))).toBeGreaterThan(0);
        } finally {
          await engine.dispose();
        }
      } finally {
        await context.close().catch(() => undefined);
      }
    } finally {
      if (browser.isConnected()) {
        await browser.close().catch(() => undefined);
      }
    }
  });
}
