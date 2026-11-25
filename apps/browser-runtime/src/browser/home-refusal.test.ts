import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homeElsewhereText } from "@opensteer/shared/homeAddress";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startFollowSession } from "./chromium.test-support.js";

/** A server that records every request it is sent, and answers each with a page. */
async function listen(
  handle: (request: IncomingMessage) => {
    type?: string;
    body: string;
    status?: number;
    location?: string;
  },
) {
  const hits: string[] = [];
  const server: Server = createServer((request, response) => {
    hits.push(request.url ?? "");
    const answer = handle(request);
    response.writeHead(answer.status ?? 200, {
      "content-type": answer.type ?? "text/html",
      ...(answer.location ? { location: answer.location } : {}),
      "cache-control": "no-store",
    });
    response.end(answer.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    hits,
    port,
    origin: `http://127.0.0.1:${port}`,
    close: () => {
      server.closeAllConnections();
      return new Promise((r) => server.close(r));
    },
  };
}

const closing: (() => unknown)[] = [];
afterEach(async () => {
  while (closing.length) await closing.pop()!();
});

describe("no page of a browser the Home owns loads one of the Home's addresses, for anyone (G1)", () => {
  it("refuses every way there, a page's, a popup's, a frame's, a worker's, a service worker's and a redirect's, and keeps other sites", async () => {
    const home = await listen(() => ({ body: "<p>Sign in to your Home</p>" }));
    closing.push(home.close);
    const homeUrl = `${home.origin}/settings`;
    // Each page of the site tries the Home, then tells its own site it has finished trying.
    const site = await listen((request) => {
      const url = request.url ?? "/";
      const home = JSON.stringify(homeUrl);
      if (url === "/popup")
        return {
          body: `<script>window.open(${home}); setTimeout(() => fetch("/done-popup"), 1000);</script>`,
        };
      if (url === "/frame")
        return {
          body: `<iframe src=${home} onload="fetch('/done-frame')" onerror="fetch('/done-frame')"></iframe>`,
        };
      if (url === "/worker.js")
        return {
          type: "text/javascript",
          body: `fetch(${home}).finally(() => postMessage("tried")).catch(() => undefined);`,
        };
      if (url === "/worker")
        return {
          body: `<script>new Worker("/worker.js").onmessage = () => fetch("/done-worker");</script>`,
        };
      if (url === "/sw.js")
        return {
          type: "text/javascript",
          body: `self.addEventListener("activate", (e) => e.waitUntil(fetch(${home}, { credentials: "include" }).catch(() => undefined).then(() => fetch("/done-sw"))));`,
        };
      if (url === "/sw")
        return { body: `<script>navigator.serviceWorker.register("/sw.js")</script>` };
      if (url === "/redirect") return { status: 302, location: "/redirect-2", body: "" };
      if (url === "/redirect-2") return { status: 302, location: homeUrl, body: "" };
      return { body: "<p>A site</p>" };
    });
    closing.push(site.close);
    // A cold start: the Home's addresses arrive in the ticket, before the first page loads.
    const session = await startFollowSession({
      claims: { homeAddresses: { origins: [home.origin], loopbackPorts: [home.port] } },
    });
    const root = session.rootSurfaceId;
    const go = (url: string) =>
      session.read(root, `location.href = ${JSON.stringify(url)}; true`).catch(() => undefined);
    const told = (done: string) =>
      vi.waitFor(() => expect(site.hits.some((hit) => hit.startsWith(done))).toBe(true), {
        timeout: 15_000,
      });
    const showsWhereTheHomeOpens = () =>
      vi.waitFor(
        async () =>
          expect(
            String(await session.read(root, "document.body?.innerText ?? ''").catch(() => "")),
          ).toContain(homeElsewhereText),
        { timeout: 15_000 },
      );
    // The person's own page goes there itself: refused, and the tab says where the Home opens.
    await go(homeUrl);
    await showsWhereTheHomeOpens();
    // A redirect chain from another site, ending on the Home.
    await go(`${site.origin}/`);
    await vi.waitFor(async () =>
      expect(String(await session.read(root, "location.href"))).toBe(`${site.origin}/`),
    );
    await go(`${site.origin}/redirect`);
    await showsWhereTheHomeOpens();
    // A popup, a frame, a worker and a service worker of another site.
    for (const path of ["popup", "frame", "worker", "sw"]) {
      await go(`${site.origin}/${path}`);
      await told(`/done-${path}`);
    }
    // An agent's own navigation, through its page session.
    await go(`${site.origin}/`);
    await vi.waitFor(async () =>
      expect(String(await session.read(root, "location.href"))).toBe(`${site.origin}/`),
    );
    const attached = (await session.agent("Target.attachToTarget", {
      targetId: await session.browser.context.pages()[0]!.targetId(),
      flatten: true,
    })) as { sessionId?: string } | undefined;
    expect(attached?.sessionId).toBeTypeOf("string");
    await session
      .agent("Page.navigate", { url: homeUrl }, attached!.sessionId)
      .catch(() => undefined);
    await showsWhereTheHomeOpens();
    // Not one request of all of these reached the Home.
    expect(home.hits).toEqual([]);
    // Another site, a dev server on another loopback port, still opens as before.
    await go(`${site.origin}/`);
    await vi.waitFor(async () =>
      expect(String(await session.read(root, "location.href"))).toBe(`${site.origin}/`),
    );
  }, 60_000);

  it("refuses every spelling of the Home's own host: a trailing dot, another case (M3)", async () => {
    const home = await listen(() => ({ body: "<p>Sign in to your Home</p>" }));
    closing.push(home.close);
    // The Home's canonical origin is a name; the browser resolves it to this machine.
    const session = await startFollowSession({
      args: ["--host-resolver-rules=MAP home.test 127.0.0.1,MAP home.test. 127.0.0.1"],
      claims: {
        homeAddresses: { origins: [`http://home.test:${home.port}`], loopbackPorts: [] },
      },
    });
    const root = session.rootSurfaceId;
    for (const url of [
      `http://home.test.:${home.port}/settings`,
      `http://HOME.test:${home.port}/`,
      `http://user@home.test:${home.port}/`,
    ]) {
      await session
        .read(root, `location.href = ${JSON.stringify(url)}; true`)
        .catch(() => undefined);
      await vi.waitFor(
        async () =>
          expect(
            String(await session.read(root, "document.body?.innerText ?? ''").catch(() => "")),
          ).toContain(homeElsewhereText),
        { timeout: 15_000 },
      );
      await session.read(root, `location.href = "about:blank"; true`).catch(() => undefined);
    }
    expect(home.hits).toEqual([]);
  }, 60_000);
});
