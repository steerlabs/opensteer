import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { once } from "node:events";
import { createServer } from "node:http";
import { chromium, type Browser, type BrowserServer, type Page } from "playwright-core";
import { appFrameHeaders, prepareAppHtml } from "@opensteer/shared/appFrame";
import { closeHttpServerNow } from "@opensteer/shared/httpServer";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { afterAll, beforeAll, expect, it } from "vitest";

const appPrefix = `/v1/apps/app_11111111-1111-4111-8111-111111111111/dark/${"a".repeat(43)}/`;
let browser: Browser | undefined;
let browserServer: BrowserServer | undefined;
let page: Page;
afterAll(async () => {
  if (browserServer)
    await withTimeout(browserServer.kill(), 5_000, {
      timeoutError: () => new Error("Owned Chromium did not exit"),
    });
});
beforeAll(async () => {
  browserServer = await chromium.launchServer({ timeout: 5_000 });
  browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: 5_000 });
  page = await browser.newPage();
});

it("runs a server-style app with relative JSON POST, assets, incremental SSE and navigation while isolating credentials, storage and parent, and preserves theme", async () => {
  const bundle = await build({
    stdin: {
      contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {AppCard} from './src/components/apps/app-card.tsx';
      import {TranscriptHostClientContext} from './src/components/attachments/message-attachments.tsx';
      const snapshot = {connection:'connected',session:'authenticated',appVersions:{}};
      const client = {subscribe:()=>()=>{},getSnapshot:()=>snapshot,viewApp:async()=>({app:{title:'Chart'},url:location.origin+'${appPrefix}'})};
      localStorage.setItem('session','secret');window.appHeights=[];window.appReady=false;
      addEventListener('message',e=>{if(e.data.type==='isolation-result')window.appResult=e.data.result;if(e.data.type==='opensteer-app:size')window.appHeights.push(e.data.height);if(e.data.type==='opensteer-app:ready')window.appReady=true});
      document.addEventListener('load',e=>{if(e.target.tagName==='IFRAME')window.appReadyAtLoad=window.appReady},true);
      createRoot(document.getElementById('root')).render(React.createElement(TranscriptHostClientContext,{value:client},React.createElement(AppCard,{entry:{appId:'app_test',title:'Chart'}})));
    `,
      resolveDir: process.cwd() + "/apps/web",
      loader: "tsx",
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const css = await readFile("apps/web/src/styles/apps.css", "utf8");
  let apiRequests = 0;
  let preflights = 0;
  let apiCookie: string | undefined;
  let finishSse: (() => void) | undefined;
  const server = createServer((request, response) => {
    if (request.url === "/parent.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(bundle.outputFiles[0]!.text);
      return;
    }
    if (request.url === "/card.css") {
      response.writeHead(200, { "content-type": "text/css" });
      response.end(css);
      return;
    }
    if (request.url === "/v1/rpc/bootstrap.get") {
      apiRequests++;
      apiCookie = request.headers.cookie;
      response.writeHead(request.headers.cookie?.includes("session=secret") ? 200 : 401, {
        "access-control-allow-origin": "null",
        "access-control-allow-credentials": "true",
      });
      response.end(
        request.headers.cookie?.includes("session=secret") ? "secret" : "unauthenticated",
      );
      return;
    }
    if (request.url === appPrefix + "api/") {
      if (request.method === "OPTIONS") {
        preflights++;
        response.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "POST",
          "access-control-allow-headers": "content-type",
        });
        response.end();
        return;
      }
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.once("end", () => {
        response.writeHead(200, {
          ...appFrameHeaders(),
          "content-type": "application/json",
          "access-control-allow-origin": "*",
        });
        response.end(JSON.stringify({ received: JSON.parse(body) }));
      });
      return;
    }
    if (request.url === appPrefix + "events") {
      response.writeHead(200, {
        ...appFrameHeaders(),
        "content-type": "text/event-stream",
        "access-control-allow-origin": "*",
      });
      response.write("data: first\n\n");
      finishSse = () => response.end("data: last\n\n");
      return;
    }
    if (request.url === appPrefix + "assets/app.js") {
      response.writeHead(200, {
        ...appFrameHeaders(),
        "content-type": "text/javascript",
        "access-control-allow-origin": "*",
      });
      response.end("window.relativeAsset=true");
      return;
    }
    if (request.url === appPrefix + "settings") {
      response.writeHead(200, appFrameHeaders());
      response.end(prepareAppHtml("<h1>Settings</h1>", "dark"));
      return;
    }
    if (request.url === appPrefix) {
      response.writeHead(200, { ...appFrameHeaders(), "access-control-allow-origin": "*" });
      response.end(
        prepareAppHtml(
          `<!doctype html><html><head></head><body style="height:2400px"><script src="assets/app.js"></script><a href="settings">Settings</a><a href="#details">Details</a><a href="https://example.com/docs">Docs</a><script>
        (async()=>{
          const blocked=fn=>{try{fn();return false}catch{return true}};
          const result={cookie:blocked(()=>document.cookie),storage:blocked(()=>localStorage.getItem('session')),parent:blocked(()=>parent.document.cookie)};
          result.api=(await fetch(new URL('/v1/rpc/bootstrap.get',location.href).href,{credentials:'include'})).status;
          result.post=await (await fetch('api/',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({value:42})})).json();
          result.asset=window.relativeAsset;
          const events=new EventSource('events');
          result.first=await new Promise((resolve,reject)=>{events.onmessage=e=>{events.close();resolve(e.data)};events.onerror=()=>reject(new Error('SSE failed'))});
          parent.postMessage({type:'isolation-result',result},'*');
        })();
      </script></body></html>`,
          "dark",
        ),
      );
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html",
      "content-security-policy": "default-src 'self'; script-src 'self'; frame-src 'self'",
      "set-cookie": "session=secret; SameSite=Lax",
    });
    response.end(
      '<!doctype html><link rel="stylesheet" href="/card.css"><div id="root"></div><script src="/parent.js"></script>',
    );
  });
  try {
    const listening = once(server, "listening", { signal: AbortSignal.timeout(5_000) });
    server.listen(0, "127.0.0.1");
    await listening;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test listener missing");
    await page.goto(`http://127.0.0.1:${address.port}`, { timeout: 1_500 });
    await page.waitForFunction(
      () => Reflect.get(window, "appResult") && Reflect.get(window, "appHeights").length,
      undefined,
      {
        timeout: 1_500,
      },
    );
    expect(await page.evaluate("window.appResult")).toEqual({
      cookie: true,
      storage: true,
      parent: true,
      api: 401,
      post: { received: { value: 42 } },
      asset: true,
      first: "first",
    });
    expect(apiRequests).toBe(1);
    expect(apiCookie).toBeUndefined();
    expect(preflights).toBe(1);
    expect(finishSse).toBeTypeOf("function");
    finishSse!();
    expect(await page.evaluate("window.appReadyAtLoad")).toBe(true);
    expect(await page.getByRole("alert").count()).toBe(0);
    expect(await page.evaluate("Math.max(...window.appHeights)")).toBeGreaterThan(2_000);
    const frame = page.frames().find((frame) => frame.url().endsWith(appPrefix))!;
    expect(await frame.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
    // Ordinary links leave through a new window (the system browser on desktop and mobile);
    // the app's own document and in-page fragments stay put.
    await page
      .context()
      .route("https://example.com/**", (route) =>
        route.fulfill({ contentType: "text/html", body: "Docs" }),
      );
    const popup = page.waitForEvent("popup", { timeout: 1_500 });
    await frame.getByRole("link", { name: "Docs" }).click({ timeout: 1_500 });
    const outside = await popup;
    expect(outside.url()).toBe("https://example.com/docs");
    await outside.close();
    await frame.getByRole("link", { name: "Details" }).click({ timeout: 1_500 });
    expect(new URL(frame.url()).pathname).toBe(appPrefix);
    expect(new URL(frame.url()).hash).toBe("#details");
    expect(page.context().pages()).toHaveLength(1);
    await page.evaluate(
      "document.querySelector('iframe').contentWindow.postMessage({type:'opensteer-app:theme',theme:'light'},'*')",
    );
    await frame.waitForFunction(
      () => document.documentElement.dataset.theme === "light",
      undefined,
      { timeout: 1_500 },
    );
    expect(await frame.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(
      "light",
    );
    await frame.getByRole("link", { name: "Settings" }).click({ timeout: 1_500 });
    await frame.getByRole("heading", { name: "Settings" }).waitFor({ timeout: 1_500 });
    expect(new URL(frame.url()).pathname).toBe(appPrefix + "settings");
    expect(page.context().pages()).toHaveLength(1);
  } finally {
    if (server.listening) await closeHttpServerNow(server);
  }
});
