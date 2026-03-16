import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createDocumentEpoch,
  createDocumentRef,
  createFrameRef,
  createPageRef,
  createSessionRef,
  createSize,
} from "../../packages/browser-core/src/index.js";
import { buildSelectChooserOptions } from "../../packages/engine-abp/src/action-events.js";
import {
  assertAllowedCdpMethod,
  PAGE_CDP_METHOD_ALLOWLIST,
} from "../../packages/engine-abp/src/cdp-transport.js";
import { createAbpComputerUseBridge } from "../../packages/engine-abp/src/computer-use.js";
import { AbpApiError, normalizeAbpError } from "../../packages/engine-abp/src/errors.js";
import { buildAbpLaunchCommand } from "../../packages/engine-abp/src/launcher.js";
import {
  AbpRestClient,
  buildInputActionRequest,
} from "../../packages/engine-abp/src/rest-client.js";
import { buildAbpScrollSegments } from "../../packages/engine-abp/src/scroll.js";
import {
  chooseNextActivePageRef,
  resolveTabOpeners,
  shouldClaimBootstrapTab,
  shouldParkPageAsBootstrap,
} from "../../packages/engine-abp/src/session-model.js";
import type {
  AbpActionResponse,
  PageController,
  SessionState,
} from "../../packages/engine-abp/src/types.js";

function expectThrownCode(fn: () => unknown, code: string): void {
  let error: unknown;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }

  expect(error).toMatchObject({ code });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("engine-abp internals", () => {
  test("enforces the read-only page CDP allowlist", () => {
    expect(() => assertAllowedCdpMethod("Page.enable", PAGE_CDP_METHOD_ALLOWLIST)).not.toThrow();
    expect(() =>
      assertAllowedCdpMethod("Runtime.evaluate", PAGE_CDP_METHOD_ALLOWLIST),
    ).not.toThrow();
    expect(() =>
      assertAllowedCdpMethod("Page.addScriptToEvaluateOnNewDocument", PAGE_CDP_METHOD_ALLOWLIST),
    ).not.toThrow();
    expectThrownCode(
      () => assertAllowedCdpMethod("Network.enable", PAGE_CDP_METHOD_ALLOWLIST),
      "operation-failed",
    );
  });

  test("normalizes ABP HTTP errors into browser-core errors", () => {
    const pageRef = createPageRef("abp-test-page");
    expect(normalizeAbpError(new AbpApiError(408, "request timed out", {}), pageRef)).toMatchObject(
      {
        code: "timeout",
      },
    );
    expect(normalizeAbpError(new AbpApiError(404, "missing", {}), pageRef)).toMatchObject({
      code: "page-closed",
    });
    expect(normalizeAbpError(new AbpApiError(500, "boom", {}), pageRef)).toMatchObject({
      code: "operation-failed",
    });
  });

  test("normalizes ABP wire responses at the REST boundary", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            requests: [{ request_id: "req-1", url: "https://example.com", method: "GET" }],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status_code: 204,
            headers: { "content-type": "application/octet-stream" },
            body: "aGVsbG8=",
            body_is_base64: true,
            final_url: "https://example.com/final",
            redirected: true,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: {
              type: "object",
              value: {
                ok: true,
              },
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );

    const client = new AbpRestClient("http://127.0.0.1:9222/api/v1");
    await expect(client.queryNetwork({ includeBodies: false })).resolves.toEqual([
      {
        request_id: "req-1",
        url: "https://example.com",
        method: "GET",
      },
    ]);
    await expect(
      client.curlTab("tab-1", {
        url: "https://example.com",
        method: "GET",
      }),
    ).resolves.toEqual({
      status: 204,
      headers: { "content-type": "application/octet-stream" },
      body: "aGVsbG8=",
      bodyEncoding: "base64",
      url: "https://example.com/final",
      redirected: true,
    });
    await expect(
      client.executeScript("tab-1", "({ ok: true })", {
        wait_until: {
          type: "immediate",
        },
        screenshot: {
          area: "none",
        },
      }),
    ).resolves.toEqual({
      ok: true,
    });
  });

  test("rejects malformed ABP network responses instead of assuming wrapper fields", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ calls: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const client = new AbpRestClient("http://127.0.0.1:9222/api/v1");
    await expect(client.queryNetwork({ includeBodies: false })).rejects.toMatchObject({
      code: "operation-failed",
    });
  });

  test("can omit the default ABP action-complete timeout when the caller owns budgeting", () => {
    expect(buildInputActionRequest({ omitDefaultTimeout: true })).toEqual({
      wait_until: {
        type: "action_complete",
      },
      network: {
        types: ["Document", "XHR", "Fetch"],
      },
    });

    expect(
      buildInputActionRequest({
        omitDefaultTimeout: true,
        timeoutMs: 4_321,
      }),
    ).toEqual({
      wait_until: {
        type: "action_complete",
        timeout_ms: 4_321,
      },
      network: {
        types: ["Document", "XHR", "Fetch"],
      },
    });
  });

  test("models bootstrap-tab claiming and parking explicitly", () => {
    const openerPageRef = createPageRef("popup-opener");
    expect(shouldClaimBootstrapTab("tab-1", undefined)).toBe(true);
    expect(shouldClaimBootstrapTab("tab-1", openerPageRef)).toBe(false);
    expect(
      shouldParkPageAsBootstrap({
        launchOwned: true,
        remainingLogicalPages: 0,
      }),
    ).toBe(true);
    expect(
      shouldParkPageAsBootstrap({
        launchOwned: true,
        remainingLogicalPages: 1,
      }),
    ).toBe(false);
  });

  test("chooses the next active page deterministically", () => {
    const first = createPageRef("first");
    const second = createPageRef("second");

    expect(chooseNextActivePageRef([first, second], second)).toBe(second);
    expect(chooseNextActivePageRef([first, second], createPageRef("third"))).toBe(first);
    expect(chooseNextActivePageRef([])).toBeUndefined();
  });

  test("resolves opener relationships after adopted pages are registered", () => {
    const openerPageRef = createPageRef("opener");
    const popupPageRef = createPageRef("popup");
    const openerByTabId = resolveTabOpeners(
      [
        {
          targetId: "tab-1",
          type: "page",
          title: "Opener",
          url: "https://example.com",
          attached: true,
        },
        {
          targetId: "tab-2",
          type: "page",
          title: "Popup",
          url: "https://example.com/popup",
          attached: true,
          openerId: "tab-1",
        },
      ],
      new Map([
        ["tab-1", openerPageRef],
        ["tab-2", popupPageRef],
      ]),
    );

    expect(openerByTabId.get("tab-2")).toBe(openerPageRef);
  });

  test("maps ABP select popup items into chooser options", () => {
    expect(
      buildSelectChooserOptions(
        [
          { index: 0, type: "option", label: "Alpha", checked: false },
          { index: 1, type: "separator", label: "---" },
          { index: 2, type: "checkable_option", label: "Beta", checked: true },
          { index: 3, type: "option", tool_tip: "Gamma" },
        ],
        0,
      ),
    ).toEqual([
      {
        index: 0,
        label: "Alpha",
        value: "Alpha",
        selected: true,
      },
      {
        index: 2,
        label: "Beta",
        value: "Beta",
        selected: true,
      },
      {
        index: 3,
        label: "Gamma",
        value: "Gamma",
        selected: false,
      },
    ]);
  });

  test("builds distinct launch commands for the wrapper and browser-binary modes", () => {
    expect(
      buildAbpLaunchCommand({
        port: 8222,
        userDataDir: "/tmp/opensteer-user-data",
        sessionDir: "/tmp/opensteer-session",
        abpExecutablePath: "/usr/local/bin/abp",
        headless: true,
        args: ["--remote-debugging-port=0"],
        verbose: false,
      }),
    ).toEqual({
      executablePath: "/usr/local/bin/abp",
      args: [
        "--port",
        "8222",
        "--headless",
        "--user-data-dir",
        "/tmp/opensteer-user-data",
        "--session-dir",
        "/tmp/opensteer-session",
        "--",
        "--remote-debugging-port=0",
      ],
    });

    expect(
      buildAbpLaunchCommand({
        port: 8222,
        userDataDir: "/tmp/opensteer-user-data",
        sessionDir: "/tmp/opensteer-session",
        browserExecutablePath: "/Applications/ABP.app/Contents/MacOS/ABP",
        headless: true,
        args: ["--remote-debugging-port=0"],
        verbose: false,
      }),
    ).toEqual({
      executablePath: "/Applications/ABP.app/Contents/MacOS/ABP",
      args: [
        "--abp-port=8222",
        "--use-mock-keychain",
        "--headless=new",
        "--user-data-dir=/tmp/opensteer-user-data",
        "--abp-session-dir=/tmp/opensteer-session",
        "--remote-debugging-port=0",
      ],
    });
  });

  test("rejects ambiguous launch configuration that mixes wrapper and browser paths", () => {
    expectThrownCode(
      () =>
        buildAbpLaunchCommand({
          port: 8222,
          userDataDir: "/tmp/opensteer-user-data",
          sessionDir: "/tmp/opensteer-session",
          abpExecutablePath: "/usr/local/bin/abp",
          browserExecutablePath: "/Applications/ABP.app/Contents/MacOS/ABP",
          headless: true,
          args: ["--remote-debugging-port=0"],
          verbose: false,
        }),
      "invalid-argument",
    );
  });

  test("computer-use bridge translates drag requests and returns ABP's native screenshot", async () => {
    const bridge = createAbpComputerUseBridge(createComputerBridgeContext());
    const signal = new AbortController().signal;

    const output = await bridge.execute({
      pageRef: createPageRef("main"),
      action: {
        type: "drag",
        start: { x: 10, y: 20 },
        end: { x: 200, y: 180 },
        steps: 12,
      },
      screenshot: {
        format: "png",
        includeCursor: true,
        annotations: ["clickable", "grid"],
      },
      signal,
      remainingMs: () => 10_000,
      policySettle: async () => {},
    });

    const rest = outputTestState.rest;
    expect(rest.dragTab).toHaveBeenCalledWith(
      "tab-main",
      expect.objectContaining({
        start_x: 10,
        start_y: 20,
        end_x: 200,
        end_y: 180,
        steps: 12,
        screenshot: {
          area: "viewport",
          cursor: true,
          format: "png",
          markup: ["clickable", "grid"],
        },
      }),
      {
        signal,
      },
    );
    expect(outputTestState.flushDomUpdateTask).toHaveBeenCalledWith(
      expect.objectContaining({ pageRef: createPageRef("main") }),
    );
    expect(rest.screenshotTab).not.toHaveBeenCalled();
    expect(output.screenshot.size).toEqual(output.viewport.visualViewport.size);
    expect(output.timing.totalMs).toBe(80);
  });

  test("computer-use bridge hands off tab_changed responses discovered after the action", async () => {
    const popupPageRef = createPageRef("popup");
    const bridge = createAbpComputerUseBridge(
      createComputerBridgeContext({
        popupPageRef,
        tabChanged: true,
        discoveredPopupPageRef: popupPageRef,
      }),
    );

    const output = await bridge.execute({
      pageRef: createPageRef("main"),
      action: {
        type: "click",
        x: 40,
        y: 30,
      },
      screenshot: {
        format: "png",
        includeCursor: false,
        annotations: [],
      },
      signal: new AbortController().signal,
      remainingMs: () => 10_000,
      policySettle: async () => {},
    });

    const rest = outputTestState.rest;
    expect(output.pageRef).toBe(popupPageRef);
    expect(output.events.map((event) => event.kind)).toContain("page-created");
    expect(outputTestState.flushDomUpdateTask).toHaveBeenCalledWith(
      expect.objectContaining({ pageRef: popupPageRef }),
    );
    expect(rest.screenshotTab).not.toHaveBeenCalled();
  });

  test("computer-use bridge threads semantic timeout budgets and abort signals into ABP actions", async () => {
    const bridge = createAbpComputerUseBridge(createComputerBridgeContext());
    const controller = new AbortController();

    await bridge.execute({
      pageRef: createPageRef("main"),
      action: {
        type: "click",
        x: 40,
        y: 30,
      },
      screenshot: {
        format: "png",
        includeCursor: false,
        annotations: [],
      },
      signal: controller.signal,
      remainingMs: () => 4_321,
      policySettle: async () => {},
    });

    expect(outputTestState.rest.clickTab).toHaveBeenCalledWith(
      "tab-main",
      expect.objectContaining({
        wait_until: {
          type: "action_complete",
          timeout_ms: 4_321,
        },
      }),
      {
        signal: controller.signal,
      },
    );
    expect(outputTestState.flushDomUpdateTask).toHaveBeenCalledWith(
      expect.objectContaining({ pageRef: createPageRef("main") }),
    );
  });

  test("computer-use bridge translates wait requests to the native wait endpoint", async () => {
    const bridge = createAbpComputerUseBridge(createComputerBridgeContext());
    const signal = new AbortController().signal;

    await bridge.execute({
      pageRef: createPageRef("main"),
      action: {
        type: "wait",
        durationMs: 250,
      },
      screenshot: {
        format: "jpeg",
        includeCursor: false,
        annotations: ["selected"],
      },
      signal,
      remainingMs: () => 10_000,
      policySettle: async () => {},
    });

    expect(outputTestState.rest.waitTab).toHaveBeenCalledWith(
      "tab-main",
      expect.objectContaining({
        duration_ms: 250,
        screenshot: {
          area: "viewport",
          format: "jpeg",
          markup: ["selected"],
        },
      }),
      {
        signal,
      },
    );
    expect(outputTestState.rest.screenshotTab).not.toHaveBeenCalled();
  });

  test("computer-use bridge encodes scroll actions using ABP scroll segments", async () => {
    const bridge = createAbpComputerUseBridge(createComputerBridgeContext());
    const signal = new AbortController().signal;

    await bridge.execute({
      pageRef: createPageRef("main"),
      action: {
        type: "scroll",
        x: 320,
        y: 240,
        deltaX: 40,
        deltaY: -180,
      },
      screenshot: {
        format: "png",
        includeCursor: false,
        annotations: [],
      },
      signal,
      remainingMs: () => 10_000,
      policySettle: async () => {},
    });

    expect(outputTestState.rest.scrollTab).toHaveBeenCalledWith(
      "tab-main",
      expect.objectContaining({
        x: 320,
        y: 240,
        scrolls: [
          { delta_px: 40, direction: "x" },
          { delta_px: -180, direction: "y" },
        ],
      }),
      {
        signal,
      },
    );
    expect(outputTestState.rest.screenshotTab).not.toHaveBeenCalled();
  });

  test("computer-use bridge rejects ABP responses whose screenshot and viewport sizes drift", async () => {
    const bridge = createAbpComputerUseBridge(
      createComputerBridgeContext({
        viewportWidth: 700,
        viewportHeight: 500,
      }),
    );

    await expect(
      bridge.execute({
        pageRef: createPageRef("main"),
        action: {
          type: "click",
          x: 40,
          y: 30,
        },
        screenshot: {
          format: "png",
          includeCursor: false,
          annotations: [],
        },
        signal: new AbortController().signal,
        remainingMs: () => 10_000,
        policySettle: async () => {},
      }),
    ).rejects.toThrow("did not match viewport");
  });

  test("buildAbpScrollSegments rejects zero-delta scroll requests", () => {
    expectThrownCode(() => buildAbpScrollSegments({ x: 0, y: 0 }), "invalid-argument");
  });
});

const outputTestState = {
  rest: createRestStubs(),
  flushDomUpdateTask: vi.fn(async () => {}),
};

function createComputerBridgeContext(
  options: {
    readonly popupPageRef?: ReturnType<typeof createPageRef>;
    readonly tabChanged?: boolean;
    readonly discoveredPopupPageRef?: ReturnType<typeof createPageRef>;
    readonly viewportWidth?: number;
    readonly viewportHeight?: number;
  } = {},
) {
  outputTestState.rest = createRestStubs({
    tabChanged: options.tabChanged ?? false,
    viewportWidth: options.viewportWidth,
    viewportHeight: options.viewportHeight,
  });
  outputTestState.flushDomUpdateTask = vi.fn(async () => {});

  const sessionRef = createSessionRef("abp-computer");
  const mainPageRef = createPageRef("main");
  const popupPageRef = options.popupPageRef ?? createPageRef("popup");
  const pageControllerByRef = new Map([
    [mainPageRef, createPageController(sessionRef, mainPageRef, "tab-main")],
    [popupPageRef, createPageController(sessionRef, popupPageRef, "tab-popup")],
  ]);
  const session = {
    sessionRef,
    activePageRef: mainPageRef,
    rest: outputTestState.rest,
  } as SessionState;

  return {
    resolveController: (pageRef: ReturnType<typeof createPageRef>) => {
      const controller = pageControllerByRef.get(pageRef);
      if (!controller) {
        throw new Error(`missing controller for ${pageRef}`);
      }
      return controller as PageController;
    },
    resolveSession: () => session,
    normalizeActionEvents: async () =>
      options.tabChanged && options.discoveredPopupPageRef === undefined
        ? [
            {
              kind: "popup-opened",
              sessionRef,
              pageRef: popupPageRef,
              openerPageRef: mainPageRef,
              eventId: "event:popup",
              timestamp: 1,
            },
          ]
        : [],
    detectNewTabs: async () => ({
      events:
        options.discoveredPopupPageRef === undefined
          ? []
          : [
              {
                kind: "popup-opened",
                sessionRef,
                pageRef: options.discoveredPopupPageRef,
                openerPageRef: mainPageRef,
                eventId: "event:detected-popup",
                timestamp: 3,
              },
            ],
      ...(options.discoveredPopupPageRef === undefined
        ? {}
        : { activePageRef: options.discoveredPopupPageRef }),
    }),
    executeInputAction: async (
      _session: SessionState,
      _controller: PageController,
      execute: () => Promise<AbpActionResponse>,
    ) => ({
      response: await execute(),
      dialogEvents: [],
    }),
    flushDomUpdateTask: outputTestState.flushDomUpdateTask,
    requireMainFrame: (controller: ReturnType<typeof createPageController>) => controller.mainFrame,
    drainQueuedEvents: (pageRef: ReturnType<typeof createPageRef>) =>
      pageRef === popupPageRef &&
      (options.tabChanged || options.discoveredPopupPageRef === popupPageRef)
        ? [
            {
              kind: "page-created",
              sessionRef,
              pageRef,
              eventId: "event:created",
              timestamp: 2,
            },
          ]
        : [],
  };
}

function createPageController(
  sessionRef: ReturnType<typeof createSessionRef>,
  pageRef: ReturnType<typeof createPageRef>,
  tabId: string,
) {
  const frameRef = createFrameRef(`frame-${tabId}`);
  return {
    sessionRef,
    pageRef,
    tabId,
    mainFrame: {
      frameRef,
      currentDocument: {
        documentRef: createDocumentRef(`document-${tabId}`),
        documentEpoch: createDocumentEpoch(0),
      },
    },
  };
}

function createRestStubs(
  options: {
    readonly tabChanged?: boolean;
    readonly viewportWidth?: number;
    readonly viewportHeight?: number;
  } = {},
) {
  const actionResponse = {
    result: {},
    tab_changed: options.tabChanged ?? false,
    screenshot_after: {
      data: Buffer.from("computer-use").toString("base64"),
      width: 800,
      height: 600,
      virtual_time_ms: 0,
      format: "png",
    },
    scroll: {
      scrollX: 0,
      scrollY: 0,
      pageWidth: 800,
      pageHeight: 1_200,
      viewportWidth: options.viewportWidth ?? 800,
      viewportHeight: options.viewportHeight ?? 600,
    },
    timing: {
      action_started_ms: 10,
      action_completed_ms: 40,
      wait_completed_ms: 80,
      duration_ms: 80,
    },
  };

  return {
    clickTab: vi.fn().mockResolvedValue(actionResponse),
    moveTab: vi.fn().mockResolvedValue(actionResponse),
    scrollTab: vi.fn().mockResolvedValue(actionResponse),
    dragTab: vi.fn().mockResolvedValue(actionResponse),
    keyPressTab: vi.fn().mockResolvedValue(actionResponse),
    typeTab: vi.fn().mockResolvedValue(actionResponse),
    waitTab: vi.fn().mockResolvedValue(actionResponse),
    screenshotTab: vi.fn().mockResolvedValue(actionResponse),
  };
}
