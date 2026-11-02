import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { once } from "node:events";
import { createServer } from "node:http";
import { chromium, type Browser, type Page } from "playwright-core";
import { appFrameHeaders, prepareAppHtml } from "@opensteer/shared/appFrame";
import { closeHttpServerNow } from "@opensteer/shared/httpServer";
import { afterAll, beforeAll, expect, it } from "vitest";

let browser: Browser | undefined;
let page: Page;
afterAll(async () => {
  await browser?.close();
});
beforeAll(async () => {
  browser = await chromium.launch({ timeout: 5_000 });
  page = await browser.newPage();
});

it("runs inline HTML in an opaque origin without cookies, storage, parent access or Host API traffic, and receives both themes, and preserves input through full-screen", async () => {
  const bundle = await build({
    stdin: {
      contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {AppCard} from './src/components/apps/app-card.tsx';
      import {TranscriptHostClientContext} from './src/components/attachments/message-attachments.tsx';
      const snapshot = {connection:'connected',session:'authenticated',appVersions:{}};
      const client = {subscribe:()=>()=>{},getSnapshot:()=>snapshot,viewApp:async()=>({app:{title:'Chart'},url:location.origin+'/app'})};
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
      response.end("secret");
      return;
    }
    if (request.url === "/app") {
      response.writeHead(200, appFrameHeaders());
      response.end(
        prepareAppHtml(
          `<!doctype html><html><head></head><body style="height:2400px"><input aria-label="App input"><script>
        (async()=>{
          const blocked=fn=>{try{fn();return false}catch{return true}};
          const result={cookie:blocked(()=>document.cookie),storage:blocked(()=>localStorage.getItem('session')),parent:blocked(()=>parent.document.cookie)};
          try {await fetch(new URL('/v1/rpc/bootstrap.get',location.href).href);result.api=false}catch{result.api=true}
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
      api: true,
    });
    expect(apiRequests).toBe(0);
    expect(await page.evaluate("window.appReadyAtLoad")).toBe(true);
    expect(await page.getByRole("alert").count()).toBe(0);
    expect(await page.evaluate("Math.max(...window.appHeights)")).toBeGreaterThan(2_000);
    const frame = page.frames().find((frame) => frame.url().endsWith("/app"))!;
    expect(await frame.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
    await frame.getByRole("textbox", { name: "App input" }).fill("Unsaved input");
    await page.evaluate("window.originalAppFrame=document.querySelector('iframe')");
    await page.getByRole("button", { name: "Open", exact: true }).click({ timeout: 1_500 });
    expect(await page.getByRole("dialog").count()).toBe(1);
    expect(await page.locator("iframe").count()).toBe(1);
    expect(await frame.getByRole("textbox").inputValue()).toBe("Unsaved input");
    await page.getByRole("button", { name: "Close", exact: true }).click({ timeout: 1_500 });
    expect(await page.evaluate("document.querySelector('iframe')===window.originalAppFrame")).toBe(
      true,
    );
    expect(await frame.getByRole("textbox").inputValue()).toBe("Unsaved input");
    await page.getByRole("button", { name: "Open", exact: true }).click({ timeout: 1_500 });
    await frame.getByRole("textbox").press("Escape");
    await page.waitForFunction(() => !document.querySelector("[role=dialog]"), undefined, {
      timeout: 1_500,
    });
    expect(
      await page
        .getByRole("button", { name: "Open", exact: true })
        .evaluate((element) => element === document.activeElement),
    ).toBe(true);
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
  } finally {
    if (server.listening) await closeHttpServerNow(server);
  }
});
