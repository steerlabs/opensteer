import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { chromium } from "playwright";
import { describe, expect, test } from "vitest";

import { createPlaywrightBrowserCoreEngine } from "../../packages/engine-playwright/src/index.js";
import {
  OpensteerSessionRuntime,
  createFilesystemOpensteerWorkspace,
} from "../../packages/opensteer/src/index.js";

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
          workspace,
          engine,
          observability: {
            profile: "off",
          },
        });

        try {
          const session = await runtime.open();
          await runtime.setObservabilityConfig({
            profile: "diagnostic",
          });

          await runtime.input({
            pageRef: session.pageRef,
            target: {
              kind: "selector",
              selector: "#name",
            },
            text: "secret-token",
          });
          await runtime.click({
            pageRef: session.pageRef,
            target: {
              kind: "selector",
              selector: "#trigger",
            },
          });
          await wait(400);
          await runtime.snapshot({
            pageRef: session.pageRef,
          });

          const events = await workspace.observations.listEvents(session.sessionRef);
          const artifacts = await workspace.observations.listArtifacts(session.sessionRef);

          expect(
            events.some(
              (event) =>
                event.kind === "console" &&
                event.phase === "emitted" &&
                event.data?.message === "clicked secret-token",
            ),
          ).toBe(true);
          expect(
            events.some(
              (event) =>
                event.kind === "error" &&
                event.phase === "emitted" &&
                event.error?.message === "page boom",
            ),
          ).toBe(true);
          expect(
            events.some(
              (event) =>
                event.kind === "operation" &&
                event.phase === "completed" &&
                event.data?.operation === "page.snapshot" &&
                (event.artifactIds?.length ?? 0) > 0,
            ),
          ).toBe(true);
          expect(artifacts.some((artifact) => artifact.kind === "dom-snapshot")).toBe(true);
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
