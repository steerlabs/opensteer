import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { chromium } from "playwright";
import { describe, expect, test } from "vitest";

import { createPlaywrightBrowserCoreEngine } from "../../packages/engine-playwright/src/index.js";
import { OpensteerSessionRuntime } from "../../packages/opensteer/src/sdk/runtime.js";
import { createFilesystemOpensteerWorkspace } from "../../packages/opensteer/src/index.js";

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

describe("Playwright-backed observations", () => {
  test(
    "captures console and page errors after live observability profile updates",
    { timeout: 30_000 },
    async () => {
      const rootPath = await mkdtemp(path.join(os.tmpdir(), "opensteer-obs-playwright-"));
      const workspace = await createFilesystemOpensteerWorkspace({
        rootPath,
        workspace: "diagnostics",
      });

      const browser = await chromium.launch({ headless: true });
      try {
        const context = await browser.newContext({
          viewport: {
            width: 800,
            height: 600,
          },
        });
        const attachedPage = await context.newPage();
        await attachedPage.goto(
          dataUrl(
            `
              <label for="name">Name</label>
              <input id="name" type="text" />
              <button id="trigger" type="button">Trigger</button>
              <script>
                document.getElementById("trigger").addEventListener("click", () => {
                  console.warn("clicked secret-token");
                  setTimeout(() => {
                    throw new Error("page boom");
                  }, 0);
                });
              </script>
            `,
            "Observation event capture",
          ),
          { waitUntil: "domcontentloaded" },
        );

        const engine = await createPlaywrightBrowserCoreEngine({
          browser,
          attachedContext: context,
          attachedPage,
          closeBrowserOnDispose: true,
          closeAttachedContextOnSessionClose: false,
          context: {
            viewport: {
              width: 800,
              height: 600,
            },
          },
        });

        const runtime = new OpensteerSessionRuntime({
          name: "observation-playwright-runtime",
          rootPath: workspace.rootPath,
          engine,
          observability: {
            profile: "off",
          },
        });

        try {
          await runtime.open();
          await runtime.setObservabilityConfig({
            profile: "diagnostic",
          });

          await runtime.input({
            target: {
              kind: "selector",
              selector: "#name",
            },
            text: "secret-token",
          });
          await runtime.click({
            target: {
              kind: "selector",
              selector: "#trigger",
            },
          });
          await wait(400);
          await runtime.snapshot();

          const sessionInfo = await runtime.info();
          const sessionRef = sessionInfo.sessionId;
          expect(sessionRef).toBeDefined();
          const observationSession = await workspace.observations.getSession(sessionRef!);

          expect(observationSession).toMatchObject({
            sessionId: sessionRef,
            profile: "diagnostic",
          });
        } finally {
          await runtime.close().catch(() => undefined);
        }
      } finally {
        if (browser.isConnected()) {
          await browser.close().catch(() => undefined);
        }
      }
    },
  );
});
