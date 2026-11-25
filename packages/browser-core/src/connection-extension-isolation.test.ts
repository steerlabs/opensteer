import { describe, expect, it } from "vitest";
import { ConnectionExtensionIsolation } from "./connection-extension-isolation.js";
import type { CdpParameters } from "./portable-session-cdp-router.js";

const extension = `chrome-extension://${"a".repeat(32)}`;

/** A connection's page session on a web page that holds one extension iframe. */
function page(): ConnectionExtensionIsolation {
  const isolation = new ConnectionExtensionIsolation("agent-world:test:", { targetId: "main" });
  expect(
    isolation.observeEvent("Page.frameNavigated", {
      frame: { id: "main", url: "https://web.test/", securityOrigin: "https://web.test" },
    }).action,
  ).toBe("forward");
  expect(
    isolation.observeEvent("Page.frameNavigated", {
      frame: { id: "ext-frame", parentId: "main", url: `${extension}/frame.html` },
    }).action,
  ).toBe("drop");
  return isolation;
}

const contentScriptStack = {
  callFrames: [
    {
      functionName: "",
      scriptId: "99",
      url: `${extension}/content.js`,
      lineNumber: 1,
      columnNumber: 1,
    },
  ],
};

describe("ConnectionExtensionIsolation: every field of a page session that can name an extension (N2)", () => {
  // Each row: an event a connection's own web page session can receive, carrying an extension's
  // frame, script or address in a field the per-method rules did not inspect.
  const dropped: [string, string, CdpParameters][] = [
    [
      "a frame an extension's content script attached",
      "Page.frameAttached",
      { frameId: "injected", parentFrameId: "main", stack: contentScriptStack },
    ],
    [
      "a frame attached inside an extension frame",
      "Page.frameAttached",
      { frameId: "nested", parentFrameId: "ext-frame" },
    ],
    [
      "a web frame navigated inside an extension frame",
      "Page.frameNavigated",
      { frame: { id: "nested-2", parentId: "ext-frame", url: "https://inner.test/" } },
    ],
    [
      "a request an extension sent (Origin)",
      "Network.requestWillBeSent",
      {
        requestId: "r1",
        frameId: "main",
        documentURL: "https://web.test/",
        request: { url: "https://api.test/", method: "GET", headers: { Origin: extension } },
      },
    ],
    [
      "a request from an extension page (Referer)",
      "Network.requestWillBeSentExtraInfo",
      { requestId: "r2", headers: { Referer: `${extension}/popup.html` } },
    ],
    [
      "a redirect from an extension address",
      "Network.requestWillBeSent",
      {
        requestId: "r3",
        frameId: "main",
        request: { url: "https://web.test/next", method: "GET", headers: {} },
        redirectResponse: { url: `${extension}/redir.html`, status: 302, headers: {} },
      },
    ],
    [
      "a response that names an extension origin",
      "Network.responseReceived",
      {
        requestId: "r4",
        frameId: "main",
        response: {
          url: "https://api.test/",
          status: 200,
          headers: { "Access-Control-Allow-Origin": extension },
        },
      },
    ],
    [
      "an IFRAME node whose frame is an extension's",
      "DOM.childNodeInserted",
      {
        parentNodeId: 4,
        previousNodeId: 5,
        node: { nodeId: 6, nodeName: "IFRAME", frameId: "ext-frame" },
      },
    ],
    [
      "an issue in an extension frame",
      "Audits.issueAdded",
      {
        issue: {
          code: "MixedContentIssue",
          details: { mixedContentIssueDetails: { frame: { frameId: "ext-frame" } } },
        },
      },
    ],
    [
      "an issue at an extension address",
      "Audits.issueAdded",
      {
        issue: {
          code: "CookieIssue",
          details: { cookieIssueDetails: { siteForCookies: `${extension}/` } },
        },
      },
    ],
    [
      "a dialog opened by an extension frame",
      "Page.javascriptDialogOpening",
      { url: `${extension}/frame.html`, message: "hi", type: "alert", hasBrowserHandler: false },
    ],
    [
      "a lifecycle event of an extension frame",
      "Page.lifecycleEvent",
      { frameId: "ext-frame", loaderId: "l1", name: "load", timestamp: 1 },
    ],
  ];
  for (const [name, method, params] of dropped)
    it(`drops ${name}`, () => {
      expect(page().observeEvent(method, params).action).toBe("drop");
    });

  it("treats a frame an extension attached, and one nested in an extension frame, as extension frames", () => {
    const isolation = page();
    isolation.observeEvent("Page.frameAttached", {
      frameId: "injected",
      parentFrameId: "main",
      stack: contentScriptStack,
    });
    isolation.observeEvent("Page.frameAttached", { frameId: "nested", parentFrameId: "ext-frame" });
    for (const frameId of ["injected", "nested"]) {
      expect(
        isolation.observeEvent("Page.frameNavigated", {
          frame: { id: frameId, parentId: "main", url: "https://inner.test/" },
        }).action,
      ).toBe("drop");
      expect(isolation.observeEvent("Page.frameStoppedLoading", { frameId }).action).toBe("drop");
    }
  });

  it("scrubs an extension's frames from a stack the page itself started", () => {
    const outcome = page().observeEvent("Page.frameAttached", {
      frameId: "web-child",
      parentFrameId: "main",
      stack: {
        callFrames: [
          ...contentScriptStack.callFrames,
          {
            functionName: "f",
            scriptId: "1",
            url: "https://web.test/app.js",
            lineNumber: 2,
            columnNumber: 3,
          },
        ],
      },
    });
    expect(outcome).toEqual({
      action: "forward",
      params: {
        frameId: "web-child",
        parentFrameId: "main",
        stack: {
          callFrames: [
            {
              functionName: "f",
              scriptId: "1",
              url: "https://web.test/app.js",
              lineNumber: 2,
              columnNumber: 3,
            },
          ],
        },
      },
    });
  });

  it("forwards the page's own events unchanged", () => {
    const isolation = page();
    const own: [string, CdpParameters][] = [
      ["Page.frameAttached", { frameId: "web-child", parentFrameId: "main" }],
      [
        "Network.requestWillBeSent",
        {
          requestId: "r5",
          frameId: "main",
          request: {
            url: "https://api.test/",
            method: "GET",
            headers: { Origin: "https://web.test" },
          },
        },
      ],
      [
        "DOM.childNodeInserted",
        {
          parentNodeId: 1,
          previousNodeId: 2,
          node: { nodeId: 3, nodeName: "IFRAME", frameId: "web-child" },
        },
      ],
      ["Page.lifecycleEvent", { frameId: "main", loaderId: "l2", name: "load", timestamp: 2 }],
    ];
    for (const [method, params] of own)
      expect(isolation.observeEvent(method, params), method).toEqual({ action: "forward", params });
  });

  it("removes an extension frame from a reply", () => {
    expect(
      page().sanitizeResult("DOM.getDocument", {
        root: {
          nodeId: 1,
          children: [
            { nodeId: 2, nodeName: "IFRAME", frameId: "ext-frame" },
            { nodeId: 3, nodeName: "IFRAME", frameId: "web-child" },
          ],
        },
      }),
    ).toEqual({
      root: {
        nodeId: 1,
        children: [
          { nodeId: 2, nodeName: "IFRAME" },
          { nodeId: 3, nodeName: "IFRAME", frameId: "web-child" },
        ],
      },
    });
  });
});
