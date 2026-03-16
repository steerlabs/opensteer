import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createPlaywrightBrowserCoreEngine } from "../../packages/engine-playwright/src/index.js";
import { OpensteerSessionRuntime } from "../../packages/opensteer/src/index.js";
import { compileOpensteerSnapshot } from "../../packages/opensteer/src/sdk/snapshot/compiler.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((rootDir) => rm(rootDir, { recursive: true, force: true })),
  );
});

function dataUrl(body: string, title: string): string {
  return `data:text/html,${encodeURIComponent(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${title}</title>
    <style>
      body { margin: 0; font: 16px/1.4 sans-serif; }
      #overlay-shell { width: 0; height: 0; }
      #status { position: absolute; left: 20px; top: 20px; }
    </style>
  </head>
  <body>${body}</body>
</html>`)}`;
}

async function createTemporaryRoot(): Promise<string> {
  const rootDir = await mkdtemp(path.join(tmpdir(), "opensteer-snapshot-fidelity-"));
  temporaryRoots.push(rootDir);
  return rootDir;
}

describe("snapshot fidelity", () => {
  test("compiled snapshots preserve shadow controls, overlay descendants, and counter text", async () => {
    const engine = await createPlaywrightBrowserCoreEngine({
      launch: { headless: true },
    });

    try {
      const sessionRef = await engine.createSession();
      const created = await engine.createPage({
        sessionRef,
        url: dataUrl(
          `
            <h1 id="tracking-title">Shipment &amp; Container Tracking</h1>
            <div id="overlay-shell">
              <div id="overlay-card" style="position:fixed;left:0;top:0;width:320px;height:160px;display:flex;gap:8px;align-items:flex-start;background:#fff;border:1px solid #111">
                <button id="manage-preferences" type="button">Manage preferences</button>
                <button id="allow-all" type="button">Allow all</button>
              </div>
            </div>
            <div id="tracking-host"></div>
            <script>
              const host = document.getElementById("tracking-host");
              const root = host.attachShadow({ mode: "open" });
              root.innerHTML =
                '<select id="shadow-select" aria-labelledby="tracking-title" style="display:block;width:220px;height:40px"><option>Container</option></select>' +
                '<input id="shadow-input" placeholder="BL or container number" type="text" style="display:block;margin-top:12px;width:220px;height:36px" />' +
                '<div id="nested-button-host" style="display:block;margin-top:12px"></div>';
              const nestedHost = root.getElementById("nested-button-host");
              const nestedRoot = nestedHost.attachShadow({ mode: "open" });
              nestedRoot.innerHTML = '<button id="shadow-track" type="button">Track</button>';
            </script>
          `,
          "Snapshot fidelity",
        ),
      });

      const snapshot = await compileOpensteerSnapshot({
        engine,
        pageRef: created.data.pageRef,
        mode: "action",
      });

      expect(snapshot.html).toContain("<select");
      expect(snapshot.html).toContain('placeholder="BL or container number"');
      expect(snapshot.html).toContain(">Track</button>");
      expect(snapshot.html).toContain(">Allow all</button>");
      expect(
        snapshot.counters.some((counter) =>
          counter.text?.includes("Shipment & Container Tracking"),
        ),
      ).toBe(true);
      expect(
        snapshot.counters.some((counter) => counter.text?.includes("Manage preferences")),
      ).toBe(true);
      expect(snapshot.counters.some((counter) => counter.text?.includes("Allow all"))).toBe(true);
      expect(snapshot.counters.some((counter) => counter.pathHint.includes("#shadow-select"))).toBe(
        true,
      );
      expect(snapshot.counters.some((counter) => counter.pathHint.includes("#shadow-track"))).toBe(
        true,
      );
    } finally {
      await engine.dispose();
    }
  }, 60_000);

  test("runtime snapshot waits for late visible overlays and stays non-empty across repeats", async () => {
    const rootDir = await createTemporaryRoot();
    const runtime = new OpensteerSessionRuntime({
      name: "snapshot-fidelity-runtime",
      rootDir,
      browser: {
        headless: true,
      },
    });

    try {
      await runtime.open({
        url: dataUrl(
          `
            <div id="status">loading</div>
            <script>
              setTimeout(() => {
                const shell = document.createElement("div");
                shell.id = "overlay-shell";
                shell.style.width = "0px";
                shell.style.height = "0px";
                shell.innerHTML =
                  '<div id="cookie-card" style="position:fixed;left:0;top:0;width:320px;height:120px;display:flex;gap:8px;align-items:flex-start;background:#fff;border:1px solid #111">' +
                  '<button id="essential-only" type="button">Essential only</button>' +
                  '<button id="allow-all" type="button">Allow all</button>' +
                  "</div>";
                document.body.appendChild(shell);
                document.getElementById("status").textContent = "ready";
              }, 150);
            </script>
          `,
          "Late overlay",
        ),
      });

      const first = await runtime.snapshot({ mode: "action" });
      const second = await runtime.snapshot({ mode: "action" });

      expect(first.html.length).toBeGreaterThan(0);
      expect(second.html.length).toBeGreaterThan(0);
      expect(first.html).toContain("Essential only");
      expect(first.html).toContain("Allow all");
      expect(second.html).toContain("Essential only");
      expect(second.counters.some((counter) => counter.text?.includes("Allow all"))).toBe(true);
    } finally {
      await runtime.close().catch(() => undefined);
    }
  }, 60_000);
});
