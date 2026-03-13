import { describe, expect, test } from "vitest";

import {
  createDocumentEpoch,
  createDocumentRef,
  createFakeBrowserCoreEngine,
  createFrameRef,
  createNodeRef,
  createPageRef,
  createPoint,
  findDomSnapshotNode,
  mergeBrowserCapabilities,
  noBrowserCapabilities,
  type DomSnapshot,
  type DomSnapshotNode,
} from "../../packages/browser-core/src/index.js";

function findNodeById(nodes: readonly DomSnapshotNode[], id: string) {
  return nodes.find((node) =>
    node.attributes.some((attribute) => attribute.name === "id" && attribute.value === id),
  );
}

describe("FakeBrowserCoreEngine", () => {
  test("models session/page/frame topology and popup relationships", async () => {
    const engine = createFakeBrowserCoreEngine();
    const sessionRef = await engine.createSession();

    const pageResult = await engine.createPage({
      sessionRef,
      url: "https://example.com",
    });
    const popupResult = await engine.createPage({
      sessionRef,
      openerPageRef: pageResult.data.pageRef,
      url: "https://popup.example.com",
    });

    const pages = await engine.listPages({ sessionRef });
    const popupFrames = await engine.listFrames({ pageRef: popupResult.data.pageRef });

    expect(pageResult.events.map((event) => event.kind)).toEqual(["page-created"]);
    expect(popupResult.events.map((event) => event.kind)).toEqual(["page-created", "popup-opened"]);
    expect(pages).toHaveLength(2);
    expect(pages.find((page) => page.pageRef === popupResult.data.pageRef)?.openerPageRef).toBe(
      pageResult.data.pageRef,
    );
    expect(popupFrames).toHaveLength(1);
    expect(popupFrames[0]?.isMainFrame).toBe(true);
  });

  test("preserves DocumentRef on same-document navigation and rotates it on cross-document navigation", async () => {
    const engine = createFakeBrowserCoreEngine();
    const sessionRef = await engine.createSession();
    const created = await engine.createPage({
      sessionRef,
      url: "https://example.com/path",
    });
    const initialFrame = await engine.getFrameInfo({
      frameRef: created.frameRef!,
    });

    const sameDocument = await engine.navigate({
      pageRef: created.data.pageRef,
      url: "https://example.com/path#details",
    });
    const reload = await engine.reload({ pageRef: created.data.pageRef });
    const crossDocument = await engine.navigate({
      pageRef: created.data.pageRef,
      url: "https://example.com/next",
    });

    expect(sameDocument.data.mainFrame.frameRef).toBe(initialFrame.frameRef);
    expect(sameDocument.data.mainFrame.documentRef).toBe(initialFrame.documentRef);
    expect(sameDocument.data.mainFrame.documentEpoch).toBe(initialFrame.documentEpoch);

    expect(reload.data.mainFrame.frameRef).toBe(initialFrame.frameRef);
    expect(reload.data.mainFrame.documentRef).not.toBe(initialFrame.documentRef);

    expect(crossDocument.data.mainFrame.frameRef).toBe(initialFrame.frameRef);
    expect(crossDocument.data.mainFrame.documentRef).not.toBe(
      sameDocument.data.mainFrame.documentRef,
    );
  });

  test("invalidates stale NodeRefs deterministically when the document epoch advances", async () => {
    const engine = createFakeBrowserCoreEngine();
    const sessionRef = await engine.createSession();
    const created = await engine.createPage({
      sessionRef,
      url: "https://example.com",
    });
    const initialSnapshot = await engine.getDomSnapshot({
      frameRef: created.frameRef!,
    });
    const continueNode = findNodeById(initialSnapshot.nodes, "continue");
    const locator = {
      documentRef: initialSnapshot.documentRef,
      documentEpoch: initialSnapshot.documentEpoch,
      nodeRef: continueNode?.nodeRef!,
    };

    expect(await engine.readText(locator)).toBe("Continue");

    const nextEpoch = engine.advanceDocumentEpoch(initialSnapshot.documentRef);
    const nextSnapshot = await engine.getDomSnapshot({
      documentRef: initialSnapshot.documentRef,
    });
    const nextContinueNode = findNodeById(nextSnapshot.nodes, "continue");

    await expect(engine.readText(locator)).rejects.toMatchObject({
      code: "stale-node-ref",
    });
    expect(nextEpoch).toBe(nextSnapshot.documentEpoch);
    expect(nextContinueNode?.nodeRef).not.toBe(locator.nodeRef);
  });

  test("retires old documents on cross-document navigation while stale locators still fail deterministically", async () => {
    const engine = createFakeBrowserCoreEngine();
    const sessionRef = await engine.createSession();
    const created = await engine.createPage({
      sessionRef,
      url: "https://example.com/start",
    });
    const initialSnapshot = await engine.getDomSnapshot({
      frameRef: created.frameRef!,
    });
    const continueNode = findNodeById(initialSnapshot.nodes, "continue");
    const locator = {
      documentRef: initialSnapshot.documentRef,
      documentEpoch: initialSnapshot.documentEpoch,
      nodeRef: continueNode?.nodeRef!,
    };

    await engine.navigate({
      pageRef: created.data.pageRef,
      url: "https://example.com/next",
    });

    await expect(
      engine.getHtmlSnapshot({
        documentRef: initialSnapshot.documentRef,
      }),
    ).rejects.toMatchObject({
      code: "not-found",
    });
    await expect(
      engine.getDomSnapshot({ documentRef: initialSnapshot.documentRef }),
    ).rejects.toMatchObject({
      code: "not-found",
    });
    await expect(engine.readText(locator)).rejects.toMatchObject({
      code: "stale-node-ref",
    });
  });

  test("returns structured HTML/DOM snapshots and ordered attributes", async () => {
    const engine = createFakeBrowserCoreEngine();
    const sessionRef = await engine.createSession();
    const created = await engine.createPage({
      sessionRef,
      url: "https://example.com",
    });

    const html = await engine.getHtmlSnapshot({
      frameRef: created.frameRef!,
    });
    const dom = await engine.getDomSnapshot({
      documentRef: html.documentRef,
    });
    const continueNode = findNodeById(dom.nodes, "continue");

    expect(html.html).toContain('<button id="continue"');
    expect(dom.shadowDomMode).toBe("flattened");
    expect(continueNode?.attributes).toEqual([
      { name: "id", value: "continue" },
      { name: "type", value: "button" },
    ]);
  });

  test("supports preserved shadow and iframe metadata in the browser-core DOM snapshot model", () => {
    const hostRef = createNodeRef("host");
    const snapshot: DomSnapshot = {
      pageRef: createPageRef("page-meta"),
      frameRef: createFrameRef("frame-meta"),
      documentRef: createDocumentRef("document-meta"),
      documentEpoch: createDocumentEpoch(0),
      url: "https://example.com",
      capturedAt: 100,
      rootSnapshotNodeId: 1,
      shadowDomMode: "preserved",
      nodes: [
        {
          snapshotNodeId: 1,
          nodeType: 9,
          nodeName: "#document",
          nodeValue: "",
          childSnapshotNodeIds: [2],
          attributes: [],
        },
        {
          snapshotNodeId: 2,
          nodeRef: createNodeRef("child"),
          parentSnapshotNodeId: 1,
          childSnapshotNodeIds: [],
          shadowRootType: "open",
          shadowHostNodeRef: hostRef,
          contentDocumentRef: createDocumentRef("document-child"),
          nodeType: 1,
          nodeName: "BUTTON",
          nodeValue: "",
          attributes: [{ name: "id", value: "child" }],
        },
      ],
    };

    expect(findDomSnapshotNode(snapshot, 2)).toMatchObject({
      shadowRootType: "open",
      shadowHostNodeRef: hostRef,
      contentDocumentRef: "document:document-child",
    });
  });

  test("hit tests in viewport coordinates using the current scroll offset", async () => {
    const engine = createFakeBrowserCoreEngine();
    const sessionRef = await engine.createSession();
    const created = await engine.createPage({
      sessionRef,
      url: "https://example.com",
    });

    await engine.mouseScroll({
      pageRef: created.data.pageRef,
      point: createPoint(0, 0),
      coordinateSpace: "layout-viewport-css",
      delta: createPoint(0, 10),
    });

    const result = await engine.hitTest({
      pageRef: created.data.pageRef,
      point: createPoint(20, 10),
      coordinateSpace: "layout-viewport-css",
      ignorePointerEventsNone: true,
    });

    expect(result.resolvedPoint).toEqual(createPoint(20, 20));
    expect(result.resolvedCoordinateSpace).toBe("document-css");
    expect(result.pointerEventsSkipped).toBe(true);
    expect(result.nodeRef).toBeDefined();
  });

  test("preserves ordered duplicate headers and strips bodies when not requested", async () => {
    const engine = createFakeBrowserCoreEngine();
    const sessionRef = await engine.createSession();
    const created = await engine.createPage({
      sessionRef,
      url: "https://example.com",
    });

    await engine.navigate({
      pageRef: created.data.pageRef,
      url: "https://example.com/next",
      referrer: "https://referrer.example.com",
    });

    const withBodies = await engine.getNetworkRecords({
      sessionRef,
      pageRef: created.data.pageRef,
      includeBodies: true,
    });
    const withoutBodies = await engine.getNetworkRecords({
      sessionRef,
      pageRef: created.data.pageRef,
      includeBodies: false,
    });

    expect(withBodies).toHaveLength(1);
    expect(withBodies[0]?.responseHeaders.map((header) => header.name)).toEqual([
      "content-type",
      "set-cookie",
      "set-cookie",
    ]);
    expect(withBodies[0]?.requestBody).toBeDefined();
    expect("requestBody" in (withoutBodies[0] ?? {})).toBe(false);
    expect("responseBody" in (withoutBodies[0] ?? {})).toBe(false);
  });

  test("defaults network inspection to bodyless reads on backends without body capture", async () => {
    const engine = createFakeBrowserCoreEngine({
      capabilities: mergeBrowserCapabilities(noBrowserCapabilities(), {
        executor: {
          sessionLifecycle: true,
          pageLifecycle: true,
          navigation: true,
        },
        inspector: {
          network: true,
        },
      }),
    });
    const sessionRef = await engine.createSession();
    const created = await engine.createPage({
      sessionRef,
      url: "https://example.com",
    });

    await engine.navigate({
      pageRef: created.data.pageRef,
      url: "https://example.com/next",
    });

    const records = await engine.getNetworkRecords({
      sessionRef,
      pageRef: created.data.pageRef,
    });

    expect(records).toHaveLength(1);
    expect("requestBody" in (records[0] ?? {})).toBe(false);
    expect("responseBody" in (records[0] ?? {})).toBe(false);
    await expect(
      engine.getNetworkRecords({
        sessionRef,
        pageRef: created.data.pageRef,
        includeBodies: true,
      }),
    ).rejects.toMatchObject({
      code: "unsupported-capability",
    });
  });

  test("filters cookies by origin semantics and can omit storage surfaces", async () => {
    const engine = createFakeBrowserCoreEngine();
    const sessionRef = await engine.createSession();
    await engine.createPage({
      sessionRef,
      url: "https://example.com",
    });

    engine.seedCookies(sessionRef, [
      {
        sessionRef,
        name: "secureCookie",
        value: "1",
        domain: "example.com",
        path: "/",
        secure: true,
        httpOnly: true,
        session: true,
      },
      {
        sessionRef,
        name: "httpCookie",
        value: "1",
        domain: "localhost",
        path: "/",
        secure: true,
        httpOnly: false,
        session: true,
      },
    ]);

    const httpsCookies = await engine.getCookies({
      sessionRef,
      urls: ["https://example.com/dashboard"],
    });
    const httpCookies = await engine.getCookies({
      sessionRef,
      urls: ["http://example.com/dashboard"],
    });
    const localhostCookies = await engine.getCookies({
      sessionRef,
      urls: ["http://localhost/app"],
    });
    const storage = await engine.getStorageSnapshot({
      sessionRef,
      includeSessionStorage: false,
      includeIndexedDb: false,
    });
    const storageWithSessionData = await engine.getStorageSnapshot({
      sessionRef,
      includeIndexedDb: false,
    });

    expect(httpsCookies.map((cookie) => cookie.name)).toEqual(["secureCookie"]);
    expect(httpCookies).toEqual([]);
    expect(localhostCookies.map((cookie) => cookie.name)).toEqual(["httpCookie"]);
    expect(storage.origins[0]?.indexedDb).toBeUndefined();
    expect(storage.origins[0]?.localStorage).toHaveLength(2);
    expect(storage.sessionStorage).toBeUndefined();
    expect(storageWithSessionData.sessionStorage?.[0]).toMatchObject({
      pageRef: expect.stringMatching(/^page:/),
      frameRef: expect.stringMatching(/^frame:/),
      origin: "https://example.com",
      entries: [{ key: "csrf", value: "token-123" }],
    });
  });

  test("executes session-bound transport requests and records execution-state events", async () => {
    const engine = createFakeBrowserCoreEngine();
    const sessionRef = await engine.createSession();
    const created = await engine.createPage({
      sessionRef,
      url: "https://example.com",
    });

    engine.seedTransportResponse(
      sessionRef,
      {
        method: "POST",
        url: "https://example.com/api",
      },
      {
        url: "https://example.com/api",
        status: 201,
        statusText: "Created",
        headers: [{ name: "content-type", value: "application/json" }],
        body: {
          bytes: new TextEncoder().encode('{"ok":true}'),
          encoding: "identity",
          mimeType: "application/json",
          charset: "utf-8",
          truncated: false,
          capturedByteLength: 11,
        },
        redirected: false,
      },
    );

    const transport = await engine.executeRequest({
      sessionRef,
      request: {
        method: "POST",
        url: "https://example.com/api",
      },
    });
    const paused = await engine.setExecutionState({
      pageRef: created.data.pageRef,
      paused: true,
    });
    const pausedAgain = await engine.setExecutionState({
      pageRef: created.data.pageRef,
      paused: true,
    });
    const resumed = await engine.setExecutionState({
      pageRef: created.data.pageRef,
      paused: false,
    });
    const frozen = await engine.setExecutionState({
      pageRef: created.data.pageRef,
      frozen: true,
    });

    expect(transport.data.status).toBe(201);
    expect(new TextDecoder().decode(transport.data.body?.bytes)).toBe('{"ok":true}');
    expect(paused.events.map((event) => event.kind)).toContain("paused");
    expect(pausedAgain.events).toEqual([]);
    expect(resumed.events.map((event) => event.kind)).toContain("resumed");
    expect(frozen.events.map((event) => event.kind)).toContain("frozen");
  });

  test("keeps executor operations working when matching event capabilities are absent", async () => {
    const engine = createFakeBrowserCoreEngine({
      capabilities: mergeBrowserCapabilities(noBrowserCapabilities(), {
        executor: {
          sessionLifecycle: true,
          pageLifecycle: true,
          executionControl: {
            pause: true,
            resume: true,
            freeze: true,
          },
        },
      }),
    });
    const sessionRef = await engine.createSession();
    const created = await engine.createPage({ sessionRef });
    const paused = await engine.setExecutionState({
      pageRef: created.data.pageRef,
      paused: true,
    });
    const closed = await engine.closePage({
      pageRef: created.data.pageRef,
    });

    expect(created.events).toEqual([]);
    expect(paused.events).toEqual([]);
    expect(paused.data).toEqual({
      paused: true,
      frozen: false,
    });
    expect(closed.events).toEqual([]);
  });

  test("gates unsupported event families by capability", async () => {
    const engine = createFakeBrowserCoreEngine({
      capabilities: mergeBrowserCapabilities(noBrowserCapabilities(), {
        executor: {
          sessionLifecycle: true,
          pageLifecycle: true,
        },
        inspector: {
          pageEnumeration: true,
          frameEnumeration: true,
          html: true,
          domSnapshot: true,
          text: true,
          attributes: true,
          hitTest: true,
          viewportMetrics: true,
          network: true,
          networkBodies: true,
          cookies: true,
          localStorage: true,
          sessionStorage: true,
          indexedDb: true,
        },
        transport: {
          sessionHttp: true,
        },
        events: {
          pageLifecycle: true,
        },
      }),
    });
    const sessionRef = await engine.createSession();
    const created = await engine.createPage({ sessionRef });

    expect(() =>
      engine.enqueueStepEvents(created.data.pageRef, [
        {
          eventId: "event:manual",
          kind: "console",
          timestamp: 0,
          sessionRef,
          pageRef: created.data.pageRef,
          level: "log",
          text: "hello",
        },
      ]),
    ).toThrow(/events\.console/);
  });
});
