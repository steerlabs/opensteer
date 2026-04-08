import { describe, expect, test } from "vitest";

import { createPlaywrightBrowserCoreEngine } from "../../packages/engine-playwright/src/index.js";
import { compileOpensteerSnapshot } from "../../packages/runtime-core/src/sdk/snapshot/compiler.js";

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

describe("snapshot visibility handling", () => {
  test(
    "preserves visible descendants under self-hidden wrappers without leaking truly hidden text",
    { timeout: 60_000 },
    async () => {
      const engine = await createPlaywrightBrowserCoreEngine({
        launch: { headless: true },
      });

      try {
        const sessionRef = await engine.createSession();
        const created = await engine.createPage({
          sessionRef,
          url: dataUrl(
            `
              <div id="plain">Plain visible text</div>
              <div id="aria-hidden-self" aria-hidden="true">ARIA hidden but visually visible</div>
              <div id="visibility-parent" style="visibility:hidden">
                Hidden parent text
                <span id="visible-child" style="visibility:visible">
                  Visible child through visibility override
                </span>
              </div>
              <div id="visibility-parent-abs" style="visibility:hidden;width:0;height:0;overflow:visible">
                <div>
                  <div
                    id="visible-abs"
                    style="visibility:visible;position:absolute;left:0;top:20px"
                  >
                    Visible absolute child through hidden parent
                  </div>
                </div>
              </div>
              <div id="opacity-zero" style="opacity:0">Opacity zero text</div>
              <div id="hidden-attr" hidden>Hidden attr text</div>
            `,
            "Snapshot visibility",
          ),
        });

        await wait(300);

        const extractionSnapshot = await compileOpensteerSnapshot({
          engine,
          pageRef: created.data.pageRef,
          mode: "extraction",
        });
        const actionSnapshot = await compileOpensteerSnapshot({
          engine,
          pageRef: created.data.pageRef,
          mode: "action",
        });

        for (const html of [extractionSnapshot.html, actionSnapshot.html]) {
          expect(html).toContain("Plain visible text");
          expect(html).toContain("ARIA hidden but visually visible");
          expect(html).toContain("Visible child through visibility override");
          expect(html).toContain("Visible absolute child through hidden parent");

          expect(html).not.toContain("Hidden parent text");
          expect(html).not.toContain("Opacity zero text");
          expect(html).not.toContain("Hidden attr text");
        }
      } finally {
        await engine.dispose();
      }
    },
  );
});
