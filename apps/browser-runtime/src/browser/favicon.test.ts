import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";
import { SurfaceLedger } from "@opensteer/browser-runtime-core";
import { validClaims } from "@opensteer/browser-runtime-core/test-support";
import { BrowserFaviconSchema, browserFaviconMaxBytes } from "@opensteer/protocol/browser";
import {
  TestChromiumLauncher,
  cleanup,
  findChromium,
  waitForBrowserState,
  withBrowserTestSignal,
} from "./browser-test-lifecycle.js";

const executablePath = findChromium();

it("resolves and refreshes real page icons as decodable bounded rasters", async () => {
  const browser = await new TestChromiumLauncher({
    executablePath,
    chromiumSandbox: false,
    headless: true,
  }).launch({
    initialViewport: { devicePixelRatio: 1, height: 600, width: 800 },
    partitionKey: `session:${validClaims().sessionId}`,
    sessionId: validClaims().sessionId,
    snapshot: { cookies: [], origins: [] },
  });
  cleanup.push(() => browser.close());
  const ledger = new SurfaceLedger(browser.context);
  await ledger.start();
  cleanup.push(() => ledger.close());
  const active = ledger.active();
  if (!active) throw new Error("Expected a live page.");
  const pendingCommands = new Set<Promise<unknown>>();
  let privateFetches = 0;
  let privateAcquisitionFinished = false;
  let iconEvaluations = 0;
  let maximumIconEvaluations = 0;
  let rejectSetup: "binding" | "bootstrap" | null = null;
  const send = active.cdp.send.bind(active.cdp);
  active.cdp.send = <Result = unknown>(method: string, parameters?: Record<string, unknown>) => {
    if (
      (rejectSetup === "binding" && method === "Runtime.addBinding") ||
      (rejectSetup === "bootstrap" &&
        method === "Runtime.evaluate" &&
        String(parameters?.expression).includes("//# sourceURL=opensteer-favicon-"))
    ) {
      rejectSetup = null;
      return Promise.reject(new Error("Injected transient favicon setup failure."));
    }
    const operation = send<Result>(method, parameters);
    if (method === "Network.disable" && privateFetches >= 2) {
      void operation.then(
        () => {
          privateAcquisitionFinished = true;
        },
        () => undefined,
      );
    }
    const iconEvaluation =
      method === "Runtime.evaluate" &&
      String(parameters?.expression).startsWith("globalThis.iconOwner.");
    if (iconEvaluation)
      maximumIconEvaluations = Math.max(maximumIconEvaluations, ++iconEvaluations);
    pendingCommands.add(operation);
    void operation
      .finally(() => {
        pendingCommands.delete(operation);
        if (iconEvaluation) iconEvaluations--;
      })
      .catch(() => undefined);
    return operation;
  };
  const settleCommands = async () => {
    while (pendingCommands.size) await withBrowserTestSignal(Promise.allSettled(pendingCommands));
  };
  const evaluate = async <T>(expression: string, contextId?: number): Promise<T> => {
    const response = await active.cdp.send<{ result: { value: T } }>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      ...(contextId === undefined ? {} : { contextId }),
    });
    return response.result.value;
  };
  const red = await evaluate<string>(`(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 32;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 32, 32);
    return canvas.toDataURL();
  })()`);
  const png = Buffer.from(red.split(",")[1]!, "base64");
  const ico = Buffer.concat([
    Buffer.from([0, 0, 1, 0, 1, 0, 32, 32, 0, 0, 1, 0, 32, 0]),
    Buffer.from(Uint32Array.of(png.length).buffer),
    Buffer.from(Uint32Array.of(22).buffer),
    png,
  ]);
  const svg = (color: string, padding = 0) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><!--${" ".repeat(padding)}--><rect width="64" height="64" fill="${color}"/></svg>`;
  const styledSvg = (attributes = false) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><style>.background { fill: #0a66c2; } .mark { fill: white; }</style><rect ${attributes ? 'style="fill: #0a66c2"' : 'class="background"'} width="64" height="64"/><rect class="mark" x="4" y="4" width="8" height="8"/></svg>`;
  let svgProbeOrigin = "";
  const viewBox = svg("#00ff00").replace('width="64" height="64"', 'viewBox="0 0 64 64"');
  const chunkTimers = new Set<ReturnType<typeof setTimeout>>();
  let version = "#0000ff";
  let fallback = true;
  let privateReady = false;
  const slowResponses = new Set<() => void>();
  const releaseSlow = () => {
    for (const release of slowResponses) release();
    slowResponses.clear();
  };
  const requests: string[] = [];
  const fetches: string[] = [];
  active.cdp.on("Network.requestWillBeSent", (value: unknown) => {
    const event = value as { type?: string; request?: { url?: string } };
    if (event.type === "Fetch" && event.request?.url) {
      fetches.push(event.request.url);
      if (event.request.url.endsWith("/private.svg")) privateFetches++;
    }
  });
  const cdn = createServer((request, response) => {
    if (request.url === "/red.png" || request.url === "/red.ico")
      return response
        .writeHead(200, {
          "content-type": request.url === "/red.png" ? "image/png" : "image/x-icon",
        })
        .end(request.url === "/red.png" ? png : ico);
    if (request.url === "/redirect")
      return response.writeHead(302, { location: "/doctype.svg" }).end();
    if (request.url === "/chunked.svg") {
      const body = svg("#00ff00", 900 * 1024);
      response.writeHead(200, { "content-type": "image/svg+xml" });
      response.write(body.slice(0, 64 * 1024));
      const timer = setTimeout(() => {
        chunkTimers.delete(timer);
        response.end(body.slice(64 * 1024));
      }, 80);
      chunkTimers.add(timer);
      return response;
    }
    return response
      .writeHead(200, {
        "content-type": "image/svg+xml",
        "cache-control": "max-age=3600",
      })
      .end(
        request.url === "/doctype.svg"
          ? `<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">${svg("#00ff00")}`
          : request.url === "/viewbox.svg"
            ? viewBox
            : request.url === "/styled.svg"
              ? styledSvg()
              : request.url === "/styled-attributes.svg"
                ? styledSvg(true)
                : request.url === "/inert.svg"
                  ? styledSvg()
                      .replace(
                        "<style>",
                        `<style>@import url('${svgProbeOrigin}/svg-external.css');`,
                      )
                      .replace(
                        "</svg>",
                        `<script>document.querySelector('.background').setAttribute('style','fill:red');fetch('${svgProbeOrigin}/svg-script');</script><image href="${svgProbeOrigin}/svg-external.png" width="4" height="4"/></svg>`,
                      )
                  : svg(
                      "#00ff00",
                      request.url === "/oversized.svg"
                        ? 2 * 1024 * 1024
                        : request.url === "/large.svg"
                          ? 900 * 1024
                          : 0,
                    ),
      );
  });
  cdn.listen(0, "127.0.0.1");
  await once(cdn, "listening");
  cleanup.push(async () => {
    for (const timer of chunkTimers) clearTimeout(timer);
    cdn.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      cdn.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const cdnAddress = cdn.address();
  if (!cdnAddress || typeof cdnAddress === "string") throw new Error("Missing CDN address.");
  const site = createServer((request, response) => {
    const path = request.url ?? "/";
    requests.push(path);
    const html = (head: string) =>
      response
        .writeHead(200, { "content-type": "text/html", "cache-control": "no-store" })
        .end(`<!doctype html><title>${path}</title>${head}<body>Icon fixture</body>`);
    const image = (body: string | Buffer, type = "image/svg+xml") =>
      response.writeHead(200, { "content-type": type, "cache-control": "no-store" }).end(body);
    switch (path) {
      case "/svg":
        return html('<link rel="icon" href="/blue.svg" type="image/svg+xml">');
      case "/styled":
      case "/styled-attributes":
      case "/styled-inline":
      case "/styled-cross-site":
      case "/styled-cross-site-attributes":
      case "/styled-cross-site-inert":
        response.setHeader("content-security-policy", "default-src 'none'; img-src * data:");
        return html(
          `<link rel="icon" href="${
            path.startsWith("/styled-cross-site")
              ? `http://localhost:${cdnAddress.port}/${path.endsWith("attributes") ? "styled-attributes.svg" : path.endsWith("inert") ? "inert.svg" : "styled.svg"}`
              : path === "/styled-inline"
                ? `data:image/svg+xml,${encodeURIComponent(styledSvg())}`
                : path === "/styled-attributes"
                  ? "/styled-attributes.svg"
                  : "/styled.svg"
          }">`,
        );
      case "/opaque-png":
      case "/opaque-ico":
        return html(
          `<link rel="icon" href="http://localhost:${cdnAddress.port}/red.${path === "/opaque-png" ? "png" : "ico"}">`,
        );
      case "/large":
        return html('<link rel="icon" href="/large.svg">');
      case "/inline":
        return html(
          `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(svg("#0000ff"))}">`,
        );
      case "/inline-png":
        return html(`<link rel="icon" href="${red}">`);
      case "/cdn":
        return html(
          `<link rel="shortcut icon" href="http://127.0.0.1:${cdnAddress.port}/icon.png">`,
        );
      case "/cross-site":
      case "/cross-site-large":
        response.setHeader("content-security-policy", "default-src 'none'; img-src *");
        return html(
          `<link rel="icon" href="http://localhost:${cdnAddress.port}/${path === "/cross-site" ? "redirect" : "oversized.svg"}">`,
        );
      case "/fallback":
        return html("");
      case "/not-an-image":
        return html('<link rel="icon" href="/html-icon">');
      case "/html-icon":
        return html("<h1>Not found</h1>");
      case "/csp":
        response.setHeader(
          "content-security-policy",
          "default-src 'none'; img-src 'self'; script-src 'none'",
        );
        return html('<link rel="icon" href="/blue.svg">');
      case "/broken":
        return html(
          '<link rel="icon" sizes="32x32" href="/broken.png"><link rel="icon" sizes="48x48" href="/blue.svg">',
        );
      case "/corrupt":
        return html('<link rel="icon" href="/corrupt.png">');
      case "/dynamic":
        return html('<link rel="icon" href="/red.png">');
      case "/reload":
        return html('<link rel="icon" href="/version.svg">');
      case "/private":
        return html('<link rel="icon" href="/private.svg">');
      case "/slow":
        return html('<link rel="icon" href="/slow.svg">');
      case "/media":
        return html(
          '<link rel="icon" href="/red.png" media="(prefers-color-scheme: light)"><link rel="icon" href="/blue.svg" media="(prefers-color-scheme: dark)">',
        );
      case "/oversized":
        return html('<link rel="icon" href="/oversized.svg">');
      case "/blue.svg":
        return image(svg("#0000ff"));
      case "/styled.svg":
        return image(styledSvg());
      case "/styled-attributes.svg":
        return image(styledSvg(true));
      case "/green.svg":
        return image(svg("#00ff00"));
      case "/viewbox.svg":
        return image(viewBox);
      case "/version.svg":
        return image(svg(version));
      case "/large.svg":
        return image(svg("#0000ff", 32 * 1024));
      case "/oversized.svg":
        return image(svg("#0000ff", 2 * 1024 * 1024));
      case "/red.png":
        return image(png, "text/plain");
      case "/corrupt.png":
        return image(Buffer.concat([png.subarray(0, 8), Buffer.alloc(20)]), "image/png");
      case "/private.svg":
        return privateReady && request.headers.cookie?.includes("session=yes")
          ? image(svg("#0000ff"))
          : response.writeHead(403).end();
      case "/slow.svg":
        slowResponses.add(() => {
          if (!response.headersSent) image(svg("#0000ff"));
        });
        return;
      case "/favicon.ico":
        return fallback ? image(ico, "image/x-icon") : response.writeHead(404).end();
      default:
        return response.writeHead(404).end();
    }
  });
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  cleanup.push(async () => {
    releaseSlow();
    site.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      site.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = site.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address.");
  const origin = `http://127.0.0.1:${address.port}`;
  svgProbeOrigin = origin;
  const shown = () => ledger.snapshot().find((surface) => surface.active);
  const evidence = join(
    process.env.OPENSTEER_FAVICON_EVIDENCE_DIR ?? join(tmpdir(), "opensteer-favicons"),
  );
  await mkdir(evidence, { recursive: true });
  const results: { name: string; color: readonly number[]; file: string }[] = [];
  const visit = async (path: string) => {
    await active.cdp.send("Page.navigate", { url: `${origin}${path}` });
    await waitForBrowserState(() => shown()?.title === path && !shown()?.loading);
  };
  const check = async (name: string, color: readonly number[]) => {
    const { frameTree } = await active.cdp.send<{ frameTree: { frame: { id: string } } }>(
      "Page.getFrameTree",
    );
    const { executionContextId } = await active.cdp.send<{ executionContextId: number }>(
      "Page.createIsolatedWorld",
      {
        frameId: frameTree.frame.id,
        worldName: "favicon-artifact-verifier",
        contentSecurityPolicy: "default-src 'none'; img-src data:",
      },
    );
    await waitForBrowserState(async () => {
      const icon = shown()?.favicon;
      if (!icon) return false;
      BrowserFaviconSchema.parse(icon);
      const pixels = await evaluate<number[] | null>(
        `(async () => {
        const image = new Image(); image.src = ${JSON.stringify(icon)};
        try { await image.decode(); } catch { return null; }
        if (image.naturalWidth !== 32 || image.naturalHeight !== 32) return null;
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32;
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0, 32, 32);
        return [...ctx.getImageData(16, 16, 1, 1).data];
      })()`,
        executionContextId,
      );
      return JSON.stringify(pixels) === JSON.stringify([...color, 255]);
    });
    const icon = shown()!.favicon!;
    const bytes = Buffer.from(icon.split(",")[1]!, "base64");
    expect(bytes.length).toBeLessThanOrEqual(browserFaviconMaxBytes);
    const file = `${results.length + 1}-${name}.png`;
    await writeFile(join(evidence, file), bytes);
    results.push({ name, color, file });
  };
  try {
    rejectSetup = "binding";
    await visit("/svg");
    await waitForBrowserState(() => rejectSetup === null);
    await ledger.refresh(active.surface.id);
    await check("svg", [0, 0, 255]);
    const precedingIcon = shown()!.favicon;
    const precedingUrl = shown()!.url;
    const navigationPublications: { url: string; committedUrl: string; oldIcon: boolean }[] = [];
    const stopObservingNavigation = ledger.subscribe((event) => {
      if (event.type !== "changed" || event.surface.id !== active.surface.id) return;
      const committedUrl = ledger.durableSnapshot().find((tab) => tab.id === event.surface.id)?.url;
      if (committedUrl && committedUrl !== precedingUrl)
        navigationPublications.push({
          url: event.surface.url,
          committedUrl,
          oldIcon: event.surface.favicon === precedingIcon,
        });
    });
    await visit("/dynamic");
    await check("committed-document-icon", [255, 0, 0]);
    stopObservingNavigation();
    await writeFile(
      join(evidence, "navigation-publications.json"),
      JSON.stringify(navigationPublications, null, 2),
    );
    expect(navigationPublications.length).toBeGreaterThan(0);
    expect(
      navigationPublications.every(
        (publication) => publication.url === publication.committedUrl && !publication.oldIcon,
      ),
    ).toBe(true);
    for (const path of [
      "/styled",
      "/styled-attributes",
      "/styled-inline",
      "/styled-cross-site",
      "/styled-cross-site-attributes",
      "/styled-cross-site-inert",
    ]) {
      await visit(path);
      await check(path.slice(1), [10, 102, 194]);
      expect(
        await evaluate(`(() => {
          const style=document.createElement('style');style.textContent='body { display: none; }';
          document.head.append(style);return getComputedStyle(document.body).display;
        })()`),
      ).toBe("block");
    }
    expect(requests.filter((path) => path.startsWith("/svg-"))).toEqual([]);
    fallback = false;
    for (const path of ["/opaque-png", "/opaque-ico"]) {
      await visit(path);
      await check(path.slice(1), [255, 0, 0]);
    }
    fallback = true;
    await visit("/inline");
    await check("data-svg", [0, 0, 255]);
    fallback = false;
    await visit("/inline-png");
    await check("data-png", [255, 0, 0]);
    fallback = true;
    await visit("/cdn");
    await check("cross-origin", [0, 255, 0]);
    await visit("/cross-site");
    await check("cross-site-csp-redirect-doctype", [0, 255, 0]);
    await visit("/cross-site-large");
    await check("opaque-source-bound", [255, 0, 0]);
    await visit("/fallback");
    await check("ico-fallback", [255, 0, 0]);
    await visit("/not-an-image");
    await check("html-falls-back", [255, 0, 0]);
    await visit("/csp");
    await check("page-csp", [0, 0, 255]);
    await visit("/large");
    await check("large-source", [0, 0, 255]);
    await visit("/broken");
    await check("second-candidate", [0, 0, 255]);
    await visit("/corrupt");
    await check("corrupt-falls-back", [255, 0, 0]);
    await visit("/oversized");
    await check("bounded-source-falls-back", [255, 0, 0]);
    await visit("/dynamic");
    await check("initial", [255, 0, 0]);
    await evaluate(`document.querySelector('link').href = '/blue.svg'`);
    await check("late-mutation", [0, 0, 255]);
    await evaluate(
      `document.querySelector('link').href = URL.createObjectURL(new Blob([${JSON.stringify(svg("#00ff00"))}], {type:'image/svg+xml'}))`,
    );
    await check("blob", [0, 255, 0]);
    for (const [name, href] of [
      ["viewbox", "/viewbox.svg"],
      ["opaque-viewbox", `http://localhost:${cdnAddress.port}/viewbox.svg`],
      ["opaque-large", `http://localhost:${cdnAddress.port}/large.svg`],
      ["opaque-chunked", `http://localhost:${cdnAddress.port}/chunked.svg`],
    ]) {
      await evaluate(`document.querySelector('link').href = '/red.png'`);
      await check(`${name}-reset`, [255, 0, 0]);
      await evaluate(`document.querySelector('link').href = ${JSON.stringify(href)}`);
      await check(name!, [0, 255, 0]);
    }
    const cachedIcon = `http://localhost:${cdnAddress.port}/cached.svg`;
    await evaluate(`document.querySelector('link').href = '/red.png'`);
    await check("before-opaque-cache", [255, 0, 0]);
    await evaluate(`document.querySelector('link').href = ${JSON.stringify(cachedIcon)}`);
    await check("opaque-cache-first", [0, 255, 0]);
    await evaluate(`document.querySelector('link').href = '/red.png'`);
    await check("before-cache-reuse", [255, 0, 0]);
    await evaluate(
      `void fetch(${JSON.stringify(cachedIcon)}, {mode:'no-cors'}); document.querySelector('link').href = ${JSON.stringify(cachedIcon)}`,
    );
    await check("opaque-cache-reuse-concurrent-fetch", [0, 255, 0]);
    await visit("/reload");
    await check("before-reload", [0, 0, 255]);
    version = "#00ff00";
    const previousDocument = shown()?.documentId;
    await active.cdp.send("Page.reload");
    await waitForBrowserState(() => shown()?.documentId !== previousDocument && !shown()?.loading);
    await check("same-url-reload", [0, 255, 0]);
    await visit("/private");
    await check("private-uses-fallback", [255, 0, 0]);
    await waitForBrowserState(
      () => fetches.filter((url) => url === `${origin}/private.svg`).length >= 2,
    );
    await waitForBrowserState(() => privateAcquisitionFinished);
    privateReady = true;
    await active.cdp.send("Network.setCookie", { name: "session", value: "yes", url: origin });
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 5_001);
    try {
      await ledger.refresh(active.surface.id);
    } finally {
      clock.mockRestore();
    }
    await check("credentialed-retry", [0, 0, 255]);
    await active.cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "light" }],
    });
    await visit("/media");
    await check("media-light", [255, 0, 0]);
    await active.cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "dark" }],
    });
    await check("media-change", [0, 0, 255]);
    await visit("/slow");
    await waitForBrowserState(() => slowResponses.size > 0);
    await visit("/dynamic");
    await check("navigation-wins", [255, 0, 0]);
    releaseSlow();
    await settleCommands();
    await check("stale-result-rejected", [255, 0, 0]);
    await active.cdp.send("Page.navigate", { url: "about:blank" });
    await waitForBrowserState(() => shown()?.url === "about:blank" && !shown()?.favicon);
    rejectSetup = "bootstrap";
    await visit("/svg");
    await waitForBrowserState(() => rejectSetup === null);
    await ledger.refresh(active.surface.id);
    await check("bootstrap-recovery", [0, 0, 255]);
    const observer = await active.page.agentCdp();
    cleanup.push(() => observer.detach());
    const { executionContextId } = await observer.send<{ executionContextId: number }>(
      "Page.createIsolatedWorld",
      { frameId: await active.page.targetId(), worldName: "opensteer-favicon" },
    );
    await observer.send("Runtime.evaluate", {
      contextId: executionContextId,
      expression: `(() => { const plan=iconOwner.plan; iconOwner.plan=()=>{iconOwner.plan=plan;alert('favicon deadline');return plan()}; })()`,
    });
    let dialogOpen = false;
    active.cdp.on("Page.javascriptDialogOpening", () => {
      dialogOpen = true;
    });
    await ledger.refresh(active.surface.id);
    await waitForBrowserState(() => dialogOpen);
    const beforeDialog = shown()?.favicon;
    const dialogDeadline = Date.now() + 8_200;
    await waitForBrowserState(() => Date.now() >= dialogDeadline);
    expect(shown()?.favicon).toBe(beforeDialog);
    expect(maximumIconEvaluations).toBeLessThanOrEqual(1);
    await active.cdp.send("Page.handleJavaScriptDialog", { accept: true });
    await check("dialog-resumes", [0, 0, 255]);
    const updates: string[] = [];
    let lastIcon = shown()?.favicon;
    const unsubscribe = ledger.subscribe(() => {
      const icon = shown()?.favicon;
      if (icon && icon !== lastIcon) {
        updates.push(icon);
        lastIcon = icon;
      }
    });
    try {
      await evaluate(`(async () => {
        const link=document.querySelector('link');
        for(let index=0;index<50;index++) {
          link.href='data:image/svg+xml,'+encodeURIComponent(${JSON.stringify(svg("COLOR"))}.replace('COLOR', index%2?'#ff0000':'#0000ff'));
          await new Promise(resolve=>setTimeout(resolve,100));
        }
        link.href='/green.svg';
      })()`);
      await check("animation-converges", [0, 255, 0]);
      expect(updates.length).toBeLessThanOrEqual(6);
    } finally {
      unsubscribe();
    }
    await observer.send("Runtime.evaluate", {
      contextId: executionContextId,
      expression: `(() => { const stop=iconOwner.stop; globalThis.iconStopped=false; iconOwner.stop=()=>{stop();globalThis.iconStopped=true}; })()`,
    });
    const beforeClose = fetches.filter((url) => url === `${origin}/slow.svg`).length;
    await evaluate(`document.querySelector('link').href='/slow.svg'`);
    await waitForBrowserState(
      () => fetches.filter((url) => url === `${origin}/slow.svg`).length > beforeClose,
    );
    await ledger.close();
    const stopped = await observer.send<{ result: { value: boolean } }>("Runtime.evaluate", {
      contextId: executionContextId,
      expression: "globalThis.iconStopped",
      returnByValue: true,
    });
    expect(stopped.result.value).toBe(true);
    expect(results).toHaveLength(48);
  } finally {
    await writeFile(
      join(evidence, "journey.json"),
      JSON.stringify(
        {
          engine: executablePath,
          results,
          requests,
          fetches,
          finalSurface: shown(),
        },
        null,
        2,
      ),
    );
  }
}, 60_000);
