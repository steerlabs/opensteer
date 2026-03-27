import { describe, expect, test } from "vitest";

import { createPlaywrightBrowserCoreEngine } from "../../packages/engine-playwright/src/index.js";
import { createDomRuntime } from "../../packages/opensteer/src/index.js";
import {
  compileOpensteerExtractionPayload,
  replayOpensteerExtractionPayload,
} from "../../packages/opensteer/src/sdk/extraction.js";
import { compileOpensteerSnapshot } from "../../packages/opensteer/src/sdk/snapshot/compiler.js";

function dataUrl(body: string, title: string): string {
  return `data:text/html,${encodeURIComponent(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${title}</title>
  </head>
  <body>${body}</body>
</html>`)}`;
}

async function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("Extraction descriptor replay paths", () => {
  test("compiles authored extraction payloads to deterministic replay paths", async () => {
    const engine = await createPlaywrightBrowserCoreEngine({
      launch: { headless: true },
    });

    try {
      const dom = createDomRuntime({ engine });
      const sessionRef = await engine.createSession();
      const created = await engine.createPage({
        sessionRef,
        url: dataUrl(
          `
            <button id="counter-target" type="button">Counter target</button>
            <div id="selector-target">Selector target</div>
          `,
          "Extraction payload compile",
        ),
      });

      await wait(300);

      const snapshot = await compileOpensteerSnapshot({
        engine,
        pageRef: created.data.pageRef,
        mode: "extraction",
      });
      const counter = snapshot.counters.find((candidate) =>
        candidate.pathHint.includes("#counter-target"),
      );
      if (!counter) {
        throw new Error("failed to find extraction counter for #counter-target");
      }

      const payload = await compileOpensteerExtractionPayload({
        dom,
        pageRef: created.data.pageRef,
        latestSnapshotCounters: snapshot.counterRecords,
        schema: {
          counterValue: { element: counter.element },
          selectorValue: { selector: "#selector-target" },
        },
      });

      expect(payload).toMatchObject({
        counterValue: {
          $path: {
            resolution: "deterministic",
          },
        },
        selectorValue: {
          $path: {
            resolution: "deterministic",
          },
        },
      });
    } finally {
      await engine.dispose();
    }
  }, 60_000);

  test("replays ambiguous persisted extraction paths by choosing the first match", async () => {
    const engine = await createPlaywrightBrowserCoreEngine({
      launch: { headless: true },
    });

    try {
      const dom = createDomRuntime({ engine });
      const sessionRef = await engine.createSession();
      const created = await engine.createPage({
        sessionRef,
        url: dataUrl(
          `
            <button class="dup" type="button">One</button>
            <button class="dup" type="button">Two</button>
          `,
          "Extraction payload ambiguity",
        ),
      });

      await wait(300);

      await expect(
        replayOpensteerExtractionPayload({
          dom,
          pageRef: created.data.pageRef,
          payload: {
            value: {
              $path: {
                resolution: "deterministic",
                context: [],
                nodes: [
                  {
                    tag: "button",
                    attrs: { class: "dup" },
                    position: { nthChild: 1, nthOfType: 1 },
                    match: [{ kind: "attr", key: "class", op: "exact", value: "dup" }],
                  },
                ],
              },
            },
          },
        }),
      ).resolves.toEqual({
        value: "One",
      });
    } finally {
      await engine.dispose();
    }
  }, 60_000);

  test("compiles and replays array descriptors when row classes normalize differently", async () => {
    const engine = await createPlaywrightBrowserCoreEngine({
      launch: { headless: true },
    });

    try {
      const dom = createDomRuntime({ engine });
      const sessionRef = await engine.createSession();
      const created = await engine.createPage({
        sessionRef,
        url: dataUrl(
          `
            <ul id="products">
              <li class="product card lazyloaded">
                <a class="title" href="/item-1">One</a>
                <span class="price">$1</span>
              </li>
              <li class="card product lazyloaded">
                <a class="title" href="/item-2">Two</a>
                <span class="price">$2</span>
              </li>
            </ul>
          `,
          "Extraction array class normalization",
        ),
      });

      await wait(300);

      const payload = await compileOpensteerExtractionPayload({
        dom,
        pageRef: created.data.pageRef,
        schema: {
          items: [
            {
              title: { selector: "#products li:nth-child(1) a.title" },
              url: { selector: "#products li:nth-child(1) a.title", attribute: "href" },
              price: { selector: "#products li:nth-child(1) .price" },
            },
            {
              title: { selector: "#products li:nth-child(2) a.title" },
              url: { selector: "#products li:nth-child(2) a.title", attribute: "href" },
              price: { selector: "#products li:nth-child(2) .price" },
            },
          ],
        },
      });

      await expect(
        replayOpensteerExtractionPayload({
          dom,
          pageRef: created.data.pageRef,
          payload,
        }),
      ).resolves.toEqual({
        items: [
          { title: "One", url: "/item-1", price: "$1" },
          { title: "Two", url: "/item-2", price: "$2" },
        ],
      });
    } finally {
      await engine.dispose();
    }
  }, 60_000);

  test("replays persisted extraction payloads from the captured snapshot without live node reads", async () => {
    const engine = await createPlaywrightBrowserCoreEngine({
      launch: { headless: true },
    });

    try {
      const dom = createDomRuntime({ engine });
      const sessionRef = await engine.createSession();
      const created = await engine.createPage({
        sessionRef,
        url: dataUrl(
          `
            <ul id="products">
              <li class="product">
                <a class="title" href="/item-1">One</a>
                <span class="price">$1</span>
              </li>
              <li class="product">
                <a class="title" href="/item-2">Two</a>
                <span class="price">$2</span>
              </li>
            </ul>
          `,
          "Extraction replay snapshot-only",
        ),
      });

      await wait(300);

      const payload = await compileOpensteerExtractionPayload({
        dom,
        pageRef: created.data.pageRef,
        schema: {
          items: [
            {
              title: { selector: "#products li:nth-child(1) .title" },
              url: { selector: "#products li:nth-child(1) .title", attribute: "href" },
              price: { selector: "#products li:nth-child(1) .price" },
            },
            {
              title: { selector: "#products li:nth-child(2) .title" },
              url: { selector: "#products li:nth-child(2) .title", attribute: "href" },
              price: { selector: "#products li:nth-child(2) .price" },
            },
          ],
        },
      });

      const originalReadText = engine.readText.bind(engine);
      const originalReadAttributes = engine.readAttributes.bind(engine);
      engine.readText = async () => {
        throw new Error("readText should not be called during extraction replay");
      };
      engine.readAttributes = async () => {
        throw new Error("readAttributes should not be called during extraction replay");
      };

      await expect(
        replayOpensteerExtractionPayload({
          dom,
          pageRef: created.data.pageRef,
          payload,
        }),
      ).resolves.toEqual({
        items: [
          { title: "One", url: "/item-1", price: "$1" },
          { title: "Two", url: "/item-2", price: "$2" },
        ],
      });

      engine.readText = originalReadText;
      engine.readAttributes = originalReadAttributes;
    } finally {
      await engine.dispose();
    }
  }, 60_000);
});
