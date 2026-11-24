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
      const snapshot = {connection:'connected',session:'authenticated',appVersions:{},tabs:{rows:new Map()}};
      const client = {subscribe:()=>()=>{},getSnapshot:()=>snapshot,viewApp:async()=>({title:'Chart',url:location.origin+'${appPrefix}'})};
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
    // Outside a workspace an ordinary link leaves through the page around the app, to the
    // person's own browser; the app's own document and in-page fragments stay put.
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

it("opens a person's clicks out of an app as workspace tabs at once, never asks, keeps a browser's own gestures, and opens nothing an app asks for alone", async () => {
  const bundle = await build({
    stdin: {
      contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {MemoryRouter} from 'react-router';
      import {AppCard} from './src/components/apps/app-card.tsx';
      import {WorkspaceProvider} from './src/components/workspace/workspace-context.tsx';
      import {TranscriptHostClientContext} from './src/components/attachments/message-attachments.tsx';
      import {ToastProvider} from './src/components/toast.tsx';
      const snapshot = {connection:'connected',session:'authenticated',appVersions:{},tabs:{rows:new Map()}};
      const client = {subscribe:()=>()=>{},getSnapshot:()=>snapshot,viewApp:async()=>({title:'Leads',url:location.origin+'${appPrefix}'})};
      window.opened=[];
      const card=React.createElement(TranscriptHostClientContext,{value:client},React.createElement(AppCard,{entry:{appId:'app_test',title:'Leads'}}));
      createRoot(document.getElementById('root')).render(React.createElement(MemoryRouter,null,React.createElement(ToastProvider,null,
        React.createElement(WorkspaceProvider,{attention:0,nav:{},openDrawer(){},openWebLink:a=>window.opened.push(a)},card))));
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
  const server = createServer((request, response) => {
    if (request.url === "/parent.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(bundle.outputFiles[0]!.text);
      return;
    }
    if (request.url === appPrefix) {
      response.writeHead(200, appFrameHeaders());
      response.end(
        prepareAppHtml(
          `<!doctype html><html><head></head><body>
          <a href="https://www.linkedin.com/in/someone">LinkedIn</a>
          <button id="reddit" onclick="window.open('https://www.reddit.com/r/opensteer','_blank')">Reddit</button>
          <button id="burst" onclick="for(const n of [1,2,3])window.open('https://burst.test/'+n)">Burst</button>
          <button id="sign-in" onclick="window.signIn=window.open('https://login.test/','signin','width=400,height=500');window.signInHandle=!!window.signIn">Sign in</button>
          <script>
            // The app looks for the bootstrap's port, before and after it arrives.
            window.sawPort=false;
            addEventListener('message',e=>{if(e.ports.length||(e.data&&e.data.type==='opensteer-app:links'))window.sawPort=true},true);
            // Asked while nobody pressed anything, or by imitating the bootstrap: never opened.
            addEventListener('load',()=>{
              window.open('https://alone.test/a');
              parent.postMessage({type:'opensteer-app:open-link',url:'https://alone.test/b'},'*');
              const channel=new MessageChannel();
              parent.postMessage({type:'opensteer-app:ready'},'*',[channel.port2]);
              channel.port1.postMessage({url:'https://alone.test/c'});
              setTimeout(()=>parent.postMessage({type:'app-asked'},'*'),100);
            });
          </script></body></html>`,
          "dark",
        ),
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      '<!doctype html><button id="page-press">Page</button><div id="root"></div><script src="/parent.js"></script>',
    );
  });
  const context = await browser!.newContext();
  const tab = await context.newPage();
  try {
    const listening = once(server, "listening", { signal: AbortSignal.timeout(5_000) });
    server.listen(0, "127.0.0.1");
    await listening;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test listener missing");
    await tab.addInitScript(() => {
      addEventListener("message", (event) => {
        if ((event.data as { type?: string } | null)?.type === "app-asked")
          Reflect.set(window, "appAsked", true);
      });
      // Every question Opensteer shows, kept after its toast leaves.
      const questions: string[] = [];
      Reflect.set(window, "questions", questions);
      new MutationObserver((records) => {
        for (const record of records)
          for (const node of record.addedNodes)
            if (node instanceof HTMLElement)
              for (const toast of node.matches(".toast") ? [node] : node.querySelectorAll(".toast"))
                if (toast.querySelector(".toast__action")) questions.push(toast.textContent ?? "");
      }).observe(document, { childList: true, subtree: true });
    });
    await tab.goto(`http://127.0.0.1:${address.port}`, { timeout: 1_500 });
    await tab.waitForFunction(() => Reflect.get(window, "appAsked") === true, undefined, {
      timeout: 1_500,
    });
    const frame = tab.frames().find((candidate) => candidate.url().endsWith(appPrefix))!;
    const opened = () => tab.evaluate(() => Reflect.get(window, "opened") as string[]);
    expect(await opened()).toEqual([]);
    expect(context.pages()).toHaveLength(1);
    expect(await frame.evaluate(() => Reflect.get(window, "sawPort"))).toBe(false);

    const questions = () => tab.evaluate(() => Reflect.get(window, "questions") as string[]);

    // A click in the app opens at once, in the workspace.
    await frame.getByRole("link", { name: "LinkedIn" }).click({ timeout: 1_500 });
    await tab.waitForFunction(() => Reflect.get(window, "opened").length === 1);
    expect(await opened()).toEqual(["https://www.linkedin.com/in/someone"]);
    expect(context.pages()).toHaveLength(1);
    expect(new URL(frame.url()).pathname).toBe(appPrefix);

    // That press is spent: the app asking for more while it keeps focus, long past any timer,
    // opens nothing, though the browser still calls the press under way.
    await frame.evaluate(() => {
      Reflect.set(
        window,
        "again",
        setInterval(() => window.open("https://again.test/"), 50),
      );
    });
    await tab.waitForTimeout(1_500);
    await frame.evaluate(() => clearInterval(Reflect.get(window, "again") as number));
    expect(await opened()).toEqual(["https://www.linkedin.com/in/someone"]);

    // One press opens one page; what else the app asks for at the same moment opens nothing,
    // and nothing asks.
    await tab.waitForTimeout(800);
    await frame.getByRole("button", { name: "Burst" }).click({ timeout: 1_500 });
    await tab.waitForFunction(() => Reflect.get(window, "opened").length === 2);
    await tab.waitForTimeout(300);
    expect(await opened()).toEqual(["https://www.linkedin.com/in/someone", "https://burst.test/1"]);

    // A window the app's script opens for a press is a link too.
    await tab.waitForTimeout(800);
    await frame.getByRole("button", { name: "Reddit" }).click({ timeout: 1_500 });
    await tab.waitForFunction(() => Reflect.get(window, "opened").length === 3);
    expect((await opened())[2]).toBe("https://www.reddit.com/r/opensteer");
    expect(context.pages()).toHaveLength(1);

    // A modifier keeps the browser's own gesture: its own new tab, not the workspace.
    await tab.waitForTimeout(800);
    const newTab = context.waitForEvent("page", { timeout: 1_500 });
    await frame
      .getByRole("link", { name: "LinkedIn" })
      .click({ modifiers: ["ControlOrMeta"], timeout: 1_500 });
    // Headless Chromium opens a modifier's background tab without ever loading it, so the tab
    // itself is the evidence that the browser, not the app's bootstrap, took the gesture.
    const outside = await newTab;
    await outside.close();
    await tab.waitForTimeout(200);
    expect(await opened()).toHaveLength(3);

    // A sign-in window the app opens by name and size stays the browser's own, handle and all.
    await tab.waitForTimeout(800);
    const popup = context.waitForEvent("page", { timeout: 1_500 });
    await frame.getByRole("button", { name: "Sign in" }).click({ timeout: 1_500 });
    await (await popup).close();
    expect(await frame.evaluate(() => Reflect.get(window, "signInHandle"))).toBe(true);
    expect(await opened()).toHaveLength(3);

    // A key in the app, the pointer elsewhere, opens at once too.
    await tab.waitForTimeout(800);
    await tab.mouse.move(1, 1);
    await frame.getByRole("link", { name: "LinkedIn" }).focus({ timeout: 1_500 });
    await tab.keyboard.press("Enter");
    await tab.waitForFunction(() => Reflect.get(window, "opened").length === 4);
    expect((await opened())[3]).toBe("https://www.linkedin.com/in/someone");

    // A press on the page around the app takes focus out of it: an app trying all the while
    // opens nothing.
    await tab.waitForTimeout(800);
    await frame.evaluate(() => {
      Reflect.set(
        window,
        "sneaky",
        setInterval(() => window.open("https://sneaky.test/"), 20),
      );
    });
    await tab.getByRole("button", { name: "Page" }).click({ timeout: 1_500 });
    await tab.waitForTimeout(400);
    await frame.evaluate(() => clearInterval(Reflect.get(window, "sneaky") as number));
    expect(await opened()).toHaveLength(4);
    expect(context.pages()).toHaveLength(1);

    // Just after that press on the page, a click in the app opens at once.
    await frame.getByRole("link", { name: "LinkedIn" }).click({ timeout: 1_500 });
    await tab.waitForFunction(() => Reflect.get(window, "opened").length === 5);
    expect((await opened())[4]).toBe("https://www.linkedin.com/in/someone");
    // Nothing along the way asked.
    expect(await questions()).toEqual([]);
  } finally {
    await context.close();
    if (server.listening) await closeHttpServerNow(server);
  }
});
