// The measurement's guest workload (experiments/browser-pool/fixture.mjs on browser-pool-gcp,
// a74266859) for a pool guest in bench mode: fixture pages on the guest's loopback, and on the
// guest's bridge port (the only port its host side may reach) a status endpoint, isolation
// probes and Chromium's CDP.
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const guest = "172.16.0.2";

function workload(mib, rows, title) {
  return `<!doctype html><meta charset=utf-8><title>${title}</title>
    <style>body{font:18px sans-serif;margin:32px}article{padding:12px;border-bottom:1px solid #ddd}</style>
    <h1>${title}</h1><input id="test" aria-label="Snapshot check">
    <main></main><script>
      window.workload = [];
      for (let i = 0; i < ${mib}; i++) {
        const page = new Uint8Array(1024 * 1024);
        for (let j = 0; j < page.length; j += 4096) page[j] = (i + (j >> 12)) % 255 + 1;
        window.workload.push(page);
      }
      const fragment = document.createDocumentFragment();
      for (let i = 0; i < ${rows}; i++) {
        const article = document.createElement("article");
        const title = document.createElement("strong");
        title.textContent = "Section " + (i + 1);
        const body = document.createElement("p");
        body.textContent = "Local test document with headings, body text and a reachable JavaScript allocation.";
        article.append(title, body);
        fragment.append(article);
      }
      document.querySelector("main").append(fragment);
      window.fixtureReady = true;
    </script>`;
}

createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  const mib = Number(url.searchParams.get("mib"));
  const rows = Number(url.searchParams.get("rows"));
  const tab = Number(url.searchParams.get("tab"));
  if (
    !Number.isInteger(mib) ||
    mib < 0 ||
    mib > 512 ||
    !Number.isInteger(rows) ||
    rows < 0 ||
    rows > 8000 ||
    !Number.isInteger(tab) ||
    tab < 0 ||
    tab > 16
  ) {
    response.writeHead(400).end();
    return;
  }
  response
    .writeHead(200, { "Content-Type": "text/html" })
    .end(workload(mib, rows, `Fixture tab ${tab}`));
}).listen(8080, "127.0.0.1");

// The bridge port (4312), the one port the host side may reach: status, probes, and CDP.
const bridge = createServer((request, response) => {
  const url = new URL(request.url, "http://guest");
  if (request.method === "POST" && (url.pathname === "/sync" || url.pathname === "/drop")) {
    execFileSync("/opensteer/busybox", ["sync"]);
    if (url.pathname === "/drop")
      execFileSync("/opensteer/busybox", ["sh", "-c", "echo 3 > /proc/sys/vm/drop_caches"]);
    response.writeHead(204).end();
    return;
  }
  if (request.method === "GET" && url.pathname === "/status") {
    response.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        wallMs: Date.now(),
        monotonicMs: Number(process.hrtime.bigint() / 1000000n),
        boottimeSeconds: Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]),
        clocksource: readFileSync(
          "/sys/devices/system/clocksource/clocksource0/current_clocksource",
          "utf8",
        ).trim(),
      }),
    );
    return;
  }
  if (request.method === "GET" && url.pathname === "/probe") {
    // Isolation checks from inside the guest: can a TCP connection be opened at all?
    const host = url.searchParams.get("host") ?? "";
    const port = Number(url.searchParams.get("port"));
    const started = Date.now();
    const socket = connect({ host, port, timeout: 1500 });
    const answer = (result) => {
      socket.destroy();
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ host, port, result, ms: Date.now() - started }));
    };
    socket.once("connect", () => answer("connected"));
    socket.once("timeout", () => answer("timeout"));
    socket.once("error", (error) => answer(error.code ?? "error"));
    return;
  }
  // Everything else is CDP's HTTP endpoint on the guest's loopback.
  const upstream = httpRequest(
    {
      host: "127.0.0.1",
      port: 9222,
      method: request.method,
      path: request.url,
      headers: { ...request.headers, host: "localhost:9222" },
    },
    (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    },
  );
  upstream.on("error", () => response.writeHead(502).end());
  request.pipe(upstream);
});
// A CDP WebSocket is passed through as bytes.
bridge.on("upgrade", (request, client, head) => {
  const upstream = connect(9222, "127.0.0.1", () => {
    const lines = [`${request.method} ${request.url} HTTP/1.1`];
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      const name = request.rawHeaders[i];
      lines.push(
        `${name}: ${name.toLowerCase() === "host" ? "localhost:9222" : request.rawHeaders[i + 1]}`,
      );
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head);
    client.pipe(upstream).pipe(client);
  });
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
});
bridge.listen(4312, guest);
