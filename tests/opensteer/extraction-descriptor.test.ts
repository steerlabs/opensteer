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

  test("replay stays strict and rejects ambiguous persisted extraction paths", async () => {
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
      ).rejects.toMatchObject({
        name: "ElementPathError",
        code: "ERR_PATH_TARGET_NOT_UNIQUE",
      });
    } finally {
      await engine.dispose();
    }
  }, 60_000);
});
