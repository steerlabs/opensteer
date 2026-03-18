import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface Phase6FixtureServer {
  readonly url: string;
  close(): Promise<void>;
}

const temporaryRoots: string[] = [];
const retryAttemptCounts = new Map<string, number>();

export async function createPhase6TemporaryRoot(): Promise<string> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "opensteer-phase6-"));
  temporaryRoots.push(rootPath);
  return rootPath;
}

export async function cleanupPhase6TemporaryRoots(): Promise<void> {
  await Promise.all(
    temporaryRoots.splice(0).map((rootPath) => rm(rootPath, { recursive: true, force: true })),
  );
}

export async function startPhase6FixtureServer(): Promise<Phase6FixtureServer> {
  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to start phase 6 fixture server");
  }

  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (url.pathname === "/phase6/main") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(mainDocumentHtml());
    return;
  }

  if (url.pathname === "/phase6/child") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(childDocumentHtml());
    return;
  }

  if (url.pathname === "/phase6/close-delayed") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(closeDelayedDocumentHtml());
    return;
  }

  if (
    url.pathname === "/child-relative" ||
    url.pathname === "/item-1" ||
    url.pathname === "/item-2"
  ) {
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.end(url.pathname);
    return;
  }

  if (url.pathname === "/small.png" || url.pathname === "/large.png") {
    response.setHeader("content-type", "image/png");
    response.end(Buffer.from([137, 80, 78, 71]));
    return;
  }

  if (url.pathname === "/phase10/session") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("set-cookie", "phase10-session=abc123; Path=/; SameSite=Lax");
    response.end(
      html(
        `
          <div id="phase10-session">phase10 session ready</div>
        `,
        "Phase 10 session",
      ),
    );
    return;
  }

  if (url.pathname === "/phase10/capture") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(
      html(
        `
          <div id="phase10-capture">phase10 capture</div>
          <script>
            window.addEventListener("load", () => {
              void fetch("/phase10/api/capture?step=load", {
                method: "POST",
                headers: {
                  "authorization": "Bearer hidden-token",
                  "content-type": "application/json; charset=utf-8",
                  "x-csrf-token": "csrf-visible"
                },
                body: JSON.stringify({ hello: "capture" })
              });
            });
          </script>
        `,
        "Phase 10 capture",
      ),
    );
    return;
  }

  if (url.pathname === "/phase10/page-eval") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(
      html(
        `
          <div id="phase10-page-eval">page eval ready</div>
          <script>
            const originalFetch = window.fetch.bind(window);
            window.fetch = (input, init = {}) => {
              const headers = new Headers(init.headers ?? {});
              headers.set("x-page-eval", "active");
              return originalFetch(input, {
                ...init,
                headers
              });
            };
          </script>
        `,
        "Phase 10 page eval",
      ),
    );
    return;
  }

  if (url.pathname === "/phase10/api/capture") {
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("set-cookie", "phase10-capture=server; Path=/; SameSite=Lax");
    response.end(
      JSON.stringify({
        ok: true,
        step: url.searchParams.get("step"),
      }),
    );
    return;
  }

  if (url.pathname === "/phase10/api/session-http") {
    const body = await readRequestBody(request);
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(
      JSON.stringify({
        cookie: request.headers.cookie ?? "",
        csrf: request.headers["x-csrf-token"] ?? "",
        source: url.searchParams.get("source"),
        body: body.length === 0 ? null : JSON.parse(body.toString("utf8")),
      }),
    );
    return;
  }

  if (url.pathname === "/phase10/api/recovery-session") {
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (!(request.headers.cookie ?? "").includes("phase10-token=fresh")) {
      response.statusCode = 401;
      response.end(
        JSON.stringify({
          ok: false,
          code: "auth-expired",
        }),
      );
      return;
    }
    response.end(
      JSON.stringify({
        ok: true,
        mode: "session-http",
      }),
    );
    return;
  }

  if (url.pathname === "/phase10/api/refresh-cookie") {
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("set-cookie", "phase10-token=fresh; Path=/; SameSite=Lax");
    response.end(
      JSON.stringify({
        refreshed: true,
      }),
    );
    return;
  }

  if (url.pathname === "/phase10/api/direct-protected") {
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.headers.authorization !== "Bearer phase10-refreshed") {
      response.statusCode = 401;
      response.end(
        JSON.stringify({
          ok: false,
          code: "token-expired",
        }),
      );
      return;
    }
    response.end(
      JSON.stringify({
        ok: true,
        mode: "direct-http",
      }),
    );
    return;
  }

  if (url.pathname === "/phase10/api/direct-refresh") {
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(
      JSON.stringify({
        token: "phase10-refreshed",
      }),
    );
    return;
  }

  if (url.pathname === "/phase10/api/form-protected") {
    const body = (await readRequestBody(request)).toString("utf8");
    const fields = new URLSearchParams(body);
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (fields.get("recaptcha-token") !== "phase10-refreshed") {
      response.statusCode = 401;
      response.end(
        JSON.stringify({
          ok: false,
          code: "token-expired",
        }),
      );
      return;
    }
    response.end(
      JSON.stringify({
        ok: true,
        mode: "form-template",
        token: fields.get("recaptcha-token"),
        query: url.searchParams.get("source"),
      }),
    );
    return;
  }

  if (url.pathname === "/phase10/api/retry-once") {
    const key = url.searchParams.get("key") ?? "default";
    const attempt = (retryAttemptCounts.get(key) ?? 0) + 1;
    retryAttemptCounts.set(key, attempt);
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (attempt === 1) {
      response.statusCode = 429;
      response.setHeader("retry-after", "0");
      response.end(
        JSON.stringify({
          ok: false,
          code: "rate-limited",
          attempt,
        }),
      );
      return;
    }
    response.end(
      JSON.stringify({
        ok: true,
        mode: "retry-policy",
        attempt,
      }),
    );
    return;
  }

  if (url.pathname === "/phase10/api/page-eval-protected") {
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.headers["x-page-eval"] !== "active") {
      response.statusCode = 403;
      response.end(
        JSON.stringify({
          ok: false,
          code: "missing-page-context",
        }),
      );
      return;
    }
    response.end(
      JSON.stringify({
        ok: true,
        mode: "page-eval-http",
      }),
    );
    return;
  }

  const userOrderMatch = url.pathname.match(/^\/phase10\/api\/users\/([^/]+)\/orders$/);
  if (userOrderMatch) {
    const body = await readRequestBody(request);
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(
      JSON.stringify({
        userId: decodeURIComponent(userOrderMatch[1]!),
        cookie: request.headers.cookie ?? "",
        csrf: request.headers["x-csrf-token"] ?? "",
        staticHeader: request.headers["x-static"] ?? "",
        page: url.searchParams.get("page"),
        debug: url.searchParams.get("debug"),
        body: body.length === 0 ? null : JSON.parse(body.toString("utf8")),
      }),
    );
    return;
  }

  response.statusCode = 404;
  response.end("not found");
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function mainDocumentHtml(): string {
  return html(
    `
      <button id="main-action" type="button">Main Action</button>
      <div id="hover-target" role="button" tabindex="0">Hover Target</div>
      <button id="rewrite" type="button">Rewrite Descriptor</button>
      <div id="descriptor-slot">
        <button id="descriptor-button" data-testid="descriptor-button" type="button">Descriptor V1</button>
      </div>
      <div id="scroll-box">
        <div id="scroll-anchor" role="button" tabindex="0">Scroll Anchor</div>
        <div style="height:900px"></div>
      </div>
      <input id="main-input" type="text" />
      <div id="mirror"></div>
      <div id="status">ready</div>
      <div id="shadow-host"></div>
      <button id="move-offscreen" type="button">Move Offscreen</button>
      <button id="offscreen-action" type="button">Offscreen Action</button>
      <div id="offscreen-scroll-box" role="button" tabindex="0">
        <div style="height:1200px"></div>
      </div>
      <iframe id="child-frame" src="/phase6/child"></iframe>
      <script>
        const status = document.getElementById("status");
        document.getElementById("main-action").addEventListener("click", () => {
          status.textContent = "main clicked";
        });
        document.getElementById("hover-target").addEventListener("mouseenter", () => {
          status.textContent = "hovered";
        });
        document.getElementById("main-input").addEventListener("input", (event) => {
          document.getElementById("mirror").textContent = event.target.value;
          status.textContent = "input " + event.target.value;
        });
        document.getElementById("move-offscreen").addEventListener("click", () => {
          document.getElementById("offscreen-action").style.top = "1600px";
          document.getElementById("offscreen-scroll-box").style.top = "1760px";
          status.textContent = "moved";
        });
        document.getElementById("offscreen-action").addEventListener("click", () => {
          status.textContent = "clicked";
        });
        const wireDescriptorButton = (label) => {
          document.getElementById("descriptor-button").addEventListener("click", () => {
            status.textContent = "descriptor clicked " + label;
          });
        };
        wireDescriptorButton("v1");
        document.getElementById("rewrite").addEventListener("click", () => {
          document.getElementById("descriptor-slot").innerHTML =
            '<div class="wrapper"><button id="descriptor-button" data-testid="descriptor-button" type="button">Descriptor V2</button></div>';
          wireDescriptorButton("v2");
        });
        document.getElementById("scroll-box").addEventListener("scroll", (event) => {
          status.textContent = "scrolled " + event.target.scrollTop;
        });
        document.getElementById("offscreen-scroll-box").addEventListener("scroll", (event) => {
          status.textContent = event.target.scrollTop > 0 ? "scrolled" : "ready";
        });
        const shadowHost = document.getElementById("shadow-host");
        const shadowRoot = shadowHost.attachShadow({ mode: "open" });
        shadowRoot.innerHTML =
          '<button id="shadow-action" data-testid="shadow-action" type="button">Shadow Action</button>';
      </script>
    `,
    "Phase 6 main",
  );
}

function closeDelayedDocumentHtml(): string {
  return html(
    `
      <div id="status">closing</div>
      <script>
        window.addEventListener("load", () => {
          setTimeout(() => {
            window.close();
          }, 100);
        });
      </script>
    `,
    "Phase 6 close delayed",
  );
}

function childDocumentHtml(): string {
  return html(
    `
      <button id="child-action" type="button">Child Action</button>
      <a id="child-link" href="/child-relative">Child Link</a>
      <img id="child-image" srcset="/small.png 320w, /large.png 1280w" alt="image" />
      <ul id="child-list">
        <li class="card"><a class="title" href="/item-1">One</a><span class="price">$1</span></li>
        <li class="card"><a class="title" href="/item-2">Two</a><span class="price">$2</span></li>
      </ul>
      <div id="child-shadow-host"></div>
      <script>
        const childHost = document.getElementById("child-shadow-host");
        const childRoot = childHost.attachShadow({ mode: "open" });
        childRoot.innerHTML =
          '<button id="child-shadow-action" type="button">Child Shadow</button>';
      </script>
    `,
    "Phase 6 child",
  );
}

function html(body: string, title: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${title}</title>
    <style>
      body { margin: 0; font: 16px/1.4 sans-serif; height: 2600px; }
      #main-action, #hover-target, #rewrite, #descriptor-slot, #main-input, #mirror, #status, #shadow-host, #scroll-box, iframe {
        position: absolute;
        left: 20px;
      }
      #main-action { top: 20px; width: 180px; height: 42px; }
      #hover-target { top: 80px; width: 180px; height: 42px; display:flex; align-items:center; justify-content:center; border:1px solid #222; }
      #rewrite { top: 140px; width: 180px; height: 42px; }
      #descriptor-slot { top: 200px; width: 180px; height: 42px; }
      #scroll-box { top: 260px; width: 220px; height: 120px; overflow: auto; border: 1px solid #222; }
      #scroll-anchor { height: 40px; display:flex; align-items:center; justify-content:center; border-bottom:1px solid #ccc; }
      #main-input { top: 400px; width: 220px; height: 36px; }
      #mirror { top: 446px; width: 220px; }
      #status { top: 486px; width: 320px; }
      #shadow-host { top: 540px; width: 220px; }
      #move-offscreen, #offscreen-action, #offscreen-scroll-box { position: absolute; left: 320px; }
      #move-offscreen { top: 420px; width: 180px; height: 42px; }
      #offscreen-action { top: 480px; width: 180px; height: 42px; }
      #offscreen-scroll-box { top: 540px; width: 220px; height: 120px; overflow: auto; border: 1px solid #222; }
      iframe { top: 20px; left: 320px; width: 420px; height: 360px; border: 0; }
    </style>
  </head>
  <body>${body}</body>
</html>`;
}
