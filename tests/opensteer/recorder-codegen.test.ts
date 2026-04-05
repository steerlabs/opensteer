import { describe, expect, test } from "vitest";

import { generateReplayScript, type RecordedAction } from "../../packages/runtime-core/src/index.js";

describe("recorder codegen", () => {
  test("merges Enter into the preceding input call", () => {
    const script = generateReplayScript({
      workspace: "recorder-test",
      startUrl: "https://example.com",
      actions: [
        {
          kind: "type",
          timestamp: 1,
          pageId: "page0",
          pageUrl: "https://example.com",
          selector: 'input[name="email"]',
          detail: {
            kind: "type",
            text: "user@example.com",
          },
        },
        {
          kind: "keypress",
          timestamp: 2,
          pageId: "page0",
          pageUrl: "https://example.com",
          selector: 'input[name="email"]',
          detail: {
            kind: "keypress",
            key: "Enter",
            modifiers: [],
          },
        },
      ] satisfies readonly RecordedAction[],
    });

    expect(script).toContain(
      `await opensteer.input({ selector: "input[name=\\"email\\"]", text: "user@example.com", pressEnter: true });`,
    );
    expect(script).not.toContain(`await dispatchKey(page0, "Enter");`);
  });

  test("generates stable multi-tab replay with page variables", () => {
    const script = generateReplayScript({
      workspace: "recorder-test",
      startUrl: "https://example.com",
      actions: [
        {
          kind: "click",
          timestamp: 1,
          pageId: "page0",
          pageUrl: "https://example.com",
          selector: 'a[target="_blank"]',
          detail: {
            kind: "click",
            button: 0,
            modifiers: [],
          },
        },
        {
          kind: "new-tab",
          timestamp: 2,
          pageId: "page1",
          pageUrl: "https://example.com/docs",
          detail: {
            kind: "new-tab",
            openerPageId: "page0",
            initialUrl: "https://example.com/docs",
          },
        },
        {
          kind: "switch-tab",
          timestamp: 3,
          pageId: "page1",
          pageUrl: "https://example.com/docs",
          detail: {
            kind: "switch-tab",
            fromPageId: "page0",
            toPageId: "page1",
          },
        },
        {
          kind: "close-tab",
          timestamp: 4,
          pageId: "page1",
          pageUrl: "https://example.com/docs",
          detail: {
            kind: "close-tab",
          },
        },
      ] satisfies readonly RecordedAction[],
    });

    expect(script).toContain(
      `const page1 = (await opensteer.waitForPage({ openerPageRef: page0, timeoutMs: 30_000 })).pageRef;`,
    );
    expect(script).toContain(`await opensteer.closePage({ pageRef: page1 });`);
    expect(script).toContain(`activePageRef = page1;`);
  });

  test("preserves pixel scroll distance and falls back to window scrolling when needed", () => {
    const script = generateReplayScript({
      workspace: "recorder-test",
      startUrl: "https://example.com",
      actions: [
        {
          kind: "scroll",
          timestamp: 1,
          pageId: "page0",
          pageUrl: "https://example.com",
          selector: "#results",
          detail: {
            kind: "scroll",
            deltaX: 0,
            deltaY: 480,
          },
        },
        {
          kind: "scroll",
          timestamp: 2,
          pageId: "page0",
          pageUrl: "https://example.com",
          detail: {
            kind: "scroll",
            deltaX: 0,
            deltaY: -240,
          },
        },
      ] satisfies readonly RecordedAction[],
    });

    expect(script).toContain(
      `await opensteer.scroll({ selector: "#results", direction: "down", amount: 480 });`,
    );
    expect(script).toContain(`script: "(deltaX, deltaY) => {\\n  window.scrollBy(Number(deltaX), Number(deltaY));\\n}",`);
    expect(script).toContain(`args: [0, -240],`);
  });

  test("still produces a runnable shell for empty action lists", () => {
    const script = generateReplayScript({
      workspace: "recorder-test",
      startUrl: "https://example.com",
      actions: [],
    });

    expect(script).toContain(`const page0 = (await opensteer.open("https://example.com")).pageRef;`);
    expect(script).toContain(`await opensteer.close();`);
  });
});
