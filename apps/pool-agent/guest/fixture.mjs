// The measurement's guest workload (experiments/browser-pool/fixture.mjs on browser-pool-gcp,
// a74266859), at the pool guest's address: fixture pages on the guest's loopback, a status
// endpoint, and a relay from the guest address to Chromium's loopback CDP port.
import { createServer } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
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

createServer((request, response) => {
  if (request.method === "POST" && (request.url === "/sync" || request.url === "/drop")) {
    execFileSync("/opensteer/busybox", ["sync"]);
    if (request.url === "/drop")
      execFileSync("/opensteer/busybox", ["sh", "-c", "echo 3 > /proc/sys/vm/drop_caches"]);
  } else if (request.method !== "GET" || request.url !== "/status") {
    response.writeHead(404).end();
    return;
  }
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
}).listen(8009, guest);

createTcpServer((client) => {
  const upstream = connect(9222, "127.0.0.1");
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
  client.pipe(upstream).pipe(client);
}).listen(9222, guest);
