import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrowserRuntime } from "@opensteer/browser-runtime-core";
import {
  FakeSink,
  FakeTicketVerifier,
  freshClaims,
  testSessionFilesRoot,
} from "@opensteer/browser-runtime-core/test-support";
import { BrowserSurfaceSchema, type BrowserSurface } from "@opensteer/protocol/browser";
import { expect, it } from "vitest";
import {
  TestChromiumLauncher,
  cleanup,
  findChromium,
  waitForBrowserMessages,
} from "./browser-test-lifecycle.js";

it.each([false, true])(
  "negotiates navigation history and real cache bypass with real Chromium (claim %s)",
  async (negotiated) => {
    let assetRequests = 0;
    const site = createServer((request, response) => {
      if (request.url === "/asset.js") {
        assetRequests++;
        response
          .writeHead(200, {
            "content-type": "text/javascript",
            "cache-control": "public,max-age=3600",
          })
          .end(`document.body.dataset.asset = '${assetRequests}'`);
      } else if (request.url === "/favicon.ico") response.writeHead(404).end();
      else
        response
          .writeHead(200, { "content-type": "text/html", "cache-control": "no-store" })
          .end(
            `<!doctype html><title>${request.url}</title><body><script src="/asset.js"></script></body>`,
          );
    });
    site.listen(0, "127.0.0.1");
    await once(site, "listening");
    cleanup.push(async () => {
      site.closeAllConnections();
      await new Promise<void>((resolve) => site.close(() => resolve()));
    });
    const address = site.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    const origin = `http://127.0.0.1:${address.port}`;
    const claims = freshClaims(negotiated ? { navigationVersion: 1 } : {});
    const runtime = new BrowserRuntime({
      launcher: new TestChromiumLauncher({
        executablePath: findChromium(),
        chromiumSandbox: false,
        headless: true,
      }),
      runtimeId: claims.runtimeId,
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier: new FakeTicketVerifier(claims),
    });
    cleanup.push(() => runtime.shutdown());
    const sink = new FakeSink();
    const attachment = await runtime.attach("ticket", sink);
    const surfaces = (): BrowserSurface[] =>
      sink.messages
        .flatMap((message) =>
          message.type === "browser.snapshot" || message.type === "browser.surfaces.changed"
            ? message.surfaces
            : [],
        )
        .slice(-1);
    const id = surfaces()[0]!.id;
    const send = (message: object) =>
      attachment.handle(JSON.stringify({ ...message, surfaceId: id }));
    const trace: Record<string, unknown>[] = [];
    const observe = async (url: string, back: boolean, forward: boolean) => {
      await waitForBrowserMessages(
        sink,
        () =>
          surfaces()[0]?.url === url &&
          !surfaces()[0]?.loading &&
          (negotiated
            ? surfaces()[0]?.canGoBack === back && surfaces()[0]?.canGoForward === forward
            : true),
      ).catch(async (error: unknown) => {
        await writeFile(
          `/tmp/opensteer-chrome-browser/w3-evidence/runtime-failure-${negotiated}.json`,
          JSON.stringify({ expected: { url, back, forward }, messages: sink.messages }, null, 2),
        );
        throw error;
      });
      trace.push({ surface: surfaces()[0], assetRequests });
    };
    if (negotiated)
      await waitForBrowserMessages(
        sink,
        () => surfaces()[0]?.canGoBack === false && surfaces()[0]?.canGoForward === false,
      );
    await send({ type: "navigation.go", url: `${origin}/one` });
    await observe(`${origin}/one`, true, false);
    await send({ type: "navigation.go", url: `${origin}/two` });
    await observe(`${origin}/two`, true, false);
    await send({ type: "navigation.back" });
    await observe(`${origin}/one`, true, true);
    await send({ type: "navigation.back" });
    await observe("about:blank", false, true);
    await send({ type: "navigation.forward" });
    await observe(`${origin}/one`, true, true);
    await send({ type: "navigation.forward" });
    await observe(`${origin}/two`, true, false);
    await send({ type: "navigation.go", url: `${origin}/two#fragment` });
    await observe(`${origin}/two#fragment`, true, false);
    const beforeReload = assetRequests;
    const beforeEvents = sink.messages.length;
    await send({ type: "navigation.reload" });
    await waitForBrowserMessages(sink, () =>
      sink.messages
        .slice(beforeEvents)
        .some(
          (message) =>
            message.type === "browser.surfaces.changed" &&
            message.surfaces.some((surface) => surface.loading),
        ),
    );
    await observe(`${origin}/two#fragment`, true, false);
    expect(assetRequests).toBe(beforeReload);
    if (negotiated) {
      await send({ type: "navigation.reload", ignoreCache: true });
      await waitForBrowserMessages(sink, () => assetRequests === beforeReload + 1);
      await observe(`${origin}/two#fragment`, true, false);
      expect(assetRequests).toBe(beforeReload + 1);
    } else {
      for (const ignoreCache of [false, true]) {
        await send({ type: "navigation.reload", ignoreCache });
        expect(sink.messages.at(-1)).toMatchObject({
          type: "browser.error",
          error: { code: "conflict" },
        });
      }
      const oldSurface = BrowserSurfaceSchema.omit({ canGoBack: true, canGoForward: true });
      for (const message of sink.messages)
        if (message.type === "browser.snapshot" || message.type === "browser.surfaces.changed")
          for (const surface of message.surfaces)
            expect(oldSurface.safeParse(surface).success).toBe(true);
      expect(assetRequests).toBe(beforeReload);
    }
    const evidence = join(
      process.env.OPENSTEER_NAVIGATION_EVIDENCE_DIR ?? join(tmpdir(), "opensteer-navigation"),
      `runtime-${negotiated ? "negotiated" : "old-host"}.json`,
    );
    await mkdir(join(evidence, ".."), { recursive: true });
    await writeFile(
      evidence,
      JSON.stringify({ negotiated, trace, assetRequests, beforeReload, passed: true }, null, 2),
    );
  },
);
