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

it("runs inline HTML in an opaque origin without cookies, storage, parent access or Host API traffic, and receives both themes", async () => {
  let apiRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === "/parent.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(
        "localStorage.setItem('session','secret');window.appHeights=[];addEventListener('message',e=>{if(e.data.type==='isolation-result')window.appResult=e.data.result;if(e.data.type==='opensteer-app:size')window.appHeights.push(e.data.height)});",
      );
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
          `<!doctype html><html><head></head><body style="height:2400px"><script>
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
      '<!doctype html><script src="/parent.js"></script><iframe sandbox="allow-scripts allow-popups" src="/app"></iframe>',
    );
  });
  try {
    const listening = once(server, "listening", { signal: AbortSignal.timeout(5_000) });
    server.listen(0, "127.0.0.1");
    await listening;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test listener missing");
    await page.goto(`http://127.0.0.1:${address.port}`, { timeout: 1_500 });
    await page.waitForFunction("window.appResult && window.appHeights.length", undefined, {
      timeout: 1_500,
    });
    expect(await page.evaluate("window.appResult")).toEqual({
      cookie: true,
      storage: true,
      parent: true,
      api: true,
    });
    expect(apiRequests).toBe(0);
    expect(await page.evaluate("Math.max(...window.appHeights)")).toBeGreaterThan(2_000);
    const frame = page.frames().find((frame) => frame.url().endsWith("/app"))!;
    expect(await frame.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
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
