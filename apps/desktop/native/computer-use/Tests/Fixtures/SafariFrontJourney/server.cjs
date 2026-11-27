// The Safari fixture: two pages with a field, a link to the other page and a long body. Every
// input, click, scroll and focus change on them is logged with the page's and this server's
// wall-clock times. Usage: node server.cjs <log.jsonl> <ready.json>
const http = require("node:http");
const fs = require("node:fs");
const [logPath, readyPath] = process.argv.slice(2);
const page = (title, other) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:18px system-ui;margin:24px;height:4000px}#field{font:18px system-ui;width:360px;height:32px}</style>
<h1>${title}</h1><input id="field" aria-label="Fixture field" autocomplete="off" spellcheck="false">
<p><a id="link" href="${other.href}">${other.label}</a></p><p>Long page for scrolling.</p>
<script>
const send = (row) => navigator.sendBeacon('/log', JSON.stringify({ ...row, page: location.pathname, at: Date.now() }));
document.querySelector('#field').addEventListener('input', (e) => send({ kind: 'input', data: e.data, value: e.target.value }));
addEventListener('keydown', (e) => send({ kind: 'keydown', key: e.key, trusted: e.isTrusted }));
addEventListener('mousedown', (e) => send({ kind: 'mousedown', x: e.clientX, y: e.clientY, target: e.target.id || e.target.tagName }));
addEventListener('click', (e) => send({ kind: 'click', target: e.target.id || e.target.tagName }));
let scrolled = 0; addEventListener('scroll', () => { const now = Date.now(); if (now - scrolled > 200) { scrolled = now; send({ kind: 'scroll', y: scrollY }); } });
addEventListener('focus', () => send({ kind: 'window-focus' })); addEventListener('blur', () => send({ kind: 'window-blur' }));
send({ kind: 'load' });
</script>`;
const one = page("Sol fixture one", { href: "/two", label: "Open fixture page two" });
const two = page("Sol fixture two", { href: "/", label: "Open fixture page one" });
const server = http.createServer((request, response) => {
  if (request.method === "POST" && request.url === "/log") {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      try {
        fs.appendFileSync(
          logPath,
          JSON.stringify({ ...JSON.parse(body), received: Date.now() }) + "\n",
        );
      } catch {}
      response.end();
    });
    return;
  }
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(request.url === "/two" ? two : one);
});
server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(logPath, "");
  fs.writeFileSync(readyPath, JSON.stringify({ pid: process.pid, port: server.address().port }));
});
