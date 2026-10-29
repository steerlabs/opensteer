import { createServer } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";

const [originFile, evidence] = process.argv.slice(2);
const escape = (text) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const server = createServer((request, response) => {
  const path = request.url;
  let data = "";
  request.on("data", (chunk) => {
    data += chunk;
  });
  request.on("end", () => {
    appendFileSync(
      evidence,
      JSON.stringify({ mono: uptime(), method: request.method, path, data }) + "\n",
    );
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "POST") {
      response.end("ok");
      return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><title>${escape(path)}</title><h1>${escape(path)}</h1>
      <p>Deterministic Opensteer background shortcut journey</p><input aria-label="Target person-key sentinel">
      <script>document.addEventListener('keydown', e => {
        fetch('/receipt', {method:'POST',body:JSON.stringify({path:location.pathname+location.search,key:e.key})});
      });</script>`);
  });
});
server.listen(0, "127.0.0.1", () =>
  writeFileSync(originFile, `http://127.0.0.1:${server.address().port}`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => server.close(() => process.exit(0)));
