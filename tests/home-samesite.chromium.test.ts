import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * D (G3): a Home on its own HTTPS origin keeps its session cookie as `__Host-` and `SameSite=Lax`,
 * as the identity service sets it. In the person's own Chrome, a page of another site (a shared
 * tab an agent drives, its popup's pages, its workers) sends that cookie with no request to the
 * Home; only a top-level navigation does, which the extension refuses for the agent's tab.
 */
describe("an HTTPS Home's session cookie stays off another site's requests (D)", () => {
  let directory: string;
  let server: Server;
  let browser: Browser;
  const homeHits: { path: string; cookie: string; dest: string }[] = [];
  const siteHits: string[] = [];
  const told = (path: string, times = 1) =>
    vi.waitFor(
      () => expect(siteHits.filter((hit) => hit === path).length).toBeGreaterThanOrEqual(times),
      {
        timeout: 15_000,
      },
    );
  let port = 0;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "opensteer-samesite-"));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=home.test",
        "-addext",
        "subjectAltName=DNS:home.test,DNS:site.test",
        "-keyout",
        join(directory, "key.pem"),
        "-out",
        join(directory, "cert.pem"),
      ],
      { stdio: "pipe" },
    );
    server = createServer(
      {
        key: await readFile(join(directory, "key.pem")),
        cert: await readFile(join(directory, "cert.pem")),
      },
      (request, response) => {
        const host = (request.headers.host ?? "").split(":")[0];
        const url = request.url ?? "/";
        if (host === "home.test") {
          if (url === "/sign-in") {
            response.writeHead(200, {
              "content-type": "text/html",
              "set-cookie":
                "__Host-opensteer.session=home-secret; Path=/; HttpOnly; Secure; SameSite=Lax",
            });
            response.end("<title>Signed in</title>");
            return;
          }
          // The browser's own request for the icon of the Home's own page (its sign-in, loaded
          // first), which can arrive late: no page of another site makes it.
          if (url === "/favicon.ico") {
            response.writeHead(404).end();
            return;
          }
          homeHits.push({
            path: url,
            cookie: String(request.headers.cookie ?? ""),
            dest: String(request.headers["sec-fetch-dest"] ?? ""),
          });
          response.writeHead(200, {
            "content-type": url.endsWith(".png") ? "image/png" : "text/html",
            "access-control-allow-origin": "https://site.test:" + port,
            "access-control-allow-credentials": "true",
          });
          response.end("home");
          return;
        }
        siteHits.push(url);
        const home = `https://home.test:${port}`;
        const pages: Record<string, [string, string]> = {
          "/subresources": [
            "text/html",
            `<img src="${home}/img.png"><iframe src="${home}/frame"></iframe><script>
              Promise.allSettled([
                fetch("${home}/fetch", { credentials: "include" }),
                fetch("${home}/no-cors", { credentials: "include", mode: "no-cors" }),
                new Promise((done) => setTimeout(done, 500)),
              ]).then(() => fetch("/done-subresources"));
            </script>`,
          ],
          "/worker.js": [
            "text/javascript",
            `fetch("${home}/worker", { credentials: "include" }).catch(() => {}).then(() => fetch("/done-worker"));`,
          ],
          "/workers": [
            "text/html",
            `<script>new Worker("/worker.js"); navigator.serviceWorker.register("/sw.js");</script>`,
          ],
          "/sw.js": [
            "text/javascript",
            `self.addEventListener("activate", (e) => e.waitUntil(fetch("${home}/service-worker", { credentials: "include" }).catch(() => {}).then(() => fetch("/done-service-worker"))));`,
          ],
          "/popup": ["text/html", `<p>popup</p>`],
        };
        const page = pages[url];
        response.writeHead(page ? 200 : 404, { "content-type": page?.[0] ?? "text/plain" });
        response.end(page?.[1] ?? "");
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
    browser = await chromium.launch({
      channel: "chromium",
      headless: true,
      args: ["--ignore-certificate-errors", "--host-resolver-rules=MAP *.test 127.0.0.1"],
    });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  it("is sent with a top-level navigation only", async () => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const home = `https://home.test:${port}`;
    const site = `https://site.test:${port}`;
    // The person is signed in to their Home in this Chrome.
    await page.goto(`${home}/sign-in`);
    expect((await context.cookies(home)).map(({ name }) => name)).toEqual([
      "__Host-opensteer.session",
    ]);
    homeHits.length = 0;
    // Another site, as a shared tab an agent drives is: subresources, a frame, workers.
    await page.goto(`${site}/subresources`);
    await told("/done-subresources");
    await page.goto(`${site}/workers`);
    await told("/done-worker");
    await told("/done-service-worker");
    // A popup that site opens, and that popup's own subresource requests.
    const popup = context.waitForEvent("page");
    await page.evaluate(`window.open(${JSON.stringify(`${site}/subresources`)})`);
    await (await popup).waitForLoadState();
    await told("/done-subresources", 2);
    const carried = homeHits.filter(({ cookie }) => cookie.includes("opensteer.session"));
    expect(homeHits.length).toBeGreaterThan(0);
    expect(carried).toEqual([]);
    // A top-level navigation to the Home carries it: the one way, and the extension refuses it
    // for the tab an agent drives (its session rule blocks the Home's addresses for that tab).
    homeHits.length = 0;
    await page.evaluate(`location.href = ${JSON.stringify(`${home}/top`)}`);
    await page.waitForURL(`${home}/top`);
    expect(homeHits.find(({ path }) => path === "/top")?.cookie).toContain("opensteer.session");
    await context.close();
  }, 60_000);
});
