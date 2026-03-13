import { describe, expect, test } from "vitest";

import type { BrowserCoreEngine, DomSnapshotNode } from "../../packages/browser-core/src/index.js";

interface ConformanceUrls {
  readonly initial: string;
  readonly sameDocument: string;
  readonly crossDocument: string;
  readonly popup: string;
}

interface BrowserCoreConformanceHarness {
  readonly engine: BrowserCoreEngine;
  readonly urls: ConformanceUrls;
  readonly dispose?: () => Promise<void>;
}

export interface BrowserCoreConformanceOptions {
  readonly name: string;
  readonly createHarness: () => Promise<BrowserCoreConformanceHarness>;
}

function findNodeById(nodes: readonly DomSnapshotNode[], id: string) {
  return nodes.find((node) =>
    node.attributes.some((attribute) => attribute.name === "id" && attribute.value === id),
  );
}

export function defineBrowserCoreConformanceSuite(options: BrowserCoreConformanceOptions): void {
  describe(options.name, () => {
    test("models session/page/frame topology and popup relationships", async () => {
      const harness = await options.createHarness();
      try {
        const sessionRef = await harness.engine.createSession();
        const pageResult = await harness.engine.createPage({
          sessionRef,
          url: harness.urls.initial,
        });
        const popupResult = await harness.engine.createPage({
          sessionRef,
          openerPageRef: pageResult.data.pageRef,
          url: harness.urls.popup,
        });

        const pages = await harness.engine.listPages({ sessionRef });
        const popupFrames = await harness.engine.listFrames({ pageRef: popupResult.data.pageRef });

        expect(pageResult.events.map((event) => event.kind)).toContain("page-created");
        expect(popupResult.events.map((event) => event.kind)).toEqual([
          "page-created",
          "popup-opened",
        ]);
        expect(pages).toHaveLength(2);
        expect(pages.find((page) => page.pageRef === popupResult.data.pageRef)?.openerPageRef).toBe(
          pageResult.data.pageRef,
        );
        expect(popupFrames).toHaveLength(1);
        expect(popupFrames[0]?.isMainFrame).toBe(true);
      } finally {
        await harness.dispose?.();
      }
    });

    test("preserves DocumentRef on same-document navigation and rotates it on reload and cross-document navigation", async () => {
      const harness = await options.createHarness();
      try {
        const sessionRef = await harness.engine.createSession();
        const created = await harness.engine.createPage({
          sessionRef,
          url: harness.urls.initial,
        });
        const initialFrame = await harness.engine.getFrameInfo({
          frameRef: created.frameRef!,
        });

        const sameDocument = await harness.engine.navigate({
          pageRef: created.data.pageRef,
          url: harness.urls.sameDocument,
        });
        const reload = await harness.engine.reload({ pageRef: created.data.pageRef });
        const crossDocument = await harness.engine.navigate({
          pageRef: created.data.pageRef,
          url: harness.urls.crossDocument,
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
      } finally {
        await harness.dispose?.();
      }
    });

    test("returns HTML and DOM snapshots with ordered attributes", async () => {
      const harness = await options.createHarness();
      try {
        const sessionRef = await harness.engine.createSession();
        const created = await harness.engine.createPage({
          sessionRef,
          url: harness.urls.initial,
        });

        const html = await harness.engine.getHtmlSnapshot({
          frameRef: created.frameRef!,
        });
        const dom = await harness.engine.getDomSnapshot({
          documentRef: html.documentRef,
        });
        const continueNode = findNodeById(dom.nodes, "continue");

        expect(html.html).toContain("continue");
        expect(dom.shadowDomMode === "flattened" || dom.shadowDomMode === "preserved").toBe(
          true,
        );
        expect(continueNode?.attributes).toEqual([
          { name: "id", value: "continue" },
          { name: "type", value: "button" },
        ]);
      } finally {
        await harness.dispose?.();
      }
    });
  });
}
