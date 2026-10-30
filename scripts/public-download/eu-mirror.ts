/** Runs only inside the disposable guest. HTTPS redirects preserve GitHub's two origins. */
import { createServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { createSocket } from "node:dgram";
import { createReadStream, readFileSync, appendFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
const [root, cert, key, log] = process.argv.slice(2) as [string, string, string, string];
const github = "https://github.opensteer.test";
const objects = "https://objects.opensteer.test";
const prefix = "/steerlabs/opensteer/releases";
const assets = new Set([
  "Opensteer-mac-arm64.zip",
  "latest-mac.yml",
  "insider-mac.yml",
  "Opensteer-Beta-mac-arm64.zip",
  "Opensteer-mac-arm64.zip.blockmap",
  "Opensteer-Beta-mac-arm64.zip.blockmap",
]);
const server = createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
  const url = new URL(req.url!, github);
  appendFileSync(
    log,
    JSON.stringify({
      at: Date.now(),
      host: req.headers.host,
      path: url.pathname,
      range: req.headers.range,
      accept: req.headers.accept,
    }) + "\n",
  );
  const latest = readFileSync(path.join(root, "latest"), "utf8").trim();
  const redirect = (location: string) => {
    res.writeHead(302, { location });
    res.end();
  };
  if (req.headers.host === "github.opensteer.test") {
    if (url.pathname === "/api/v3/repos/steerlabs/opensteer/releases/latest") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ tag_name: latest }));
      return;
    }
    if (url.pathname === `${prefix}.atom`) {
      const tags: string[] = existsSync(path.join(root, "atom.json"))
        ? JSON.parse(readFileSync(path.join(root, "atom.json"), "utf8"))
        : [latest];
      res.setHeader("content-type", "application/atom+xml");
      res.end(
        `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${tags.map((tag) => `<entry><id>${tag}</id><title>${tag}</title><updated>2020-01-01T00:00:00Z</updated><link href="${github}${prefix}/tag/${tag}"/><content>Update journey fixture</content></entry>`).join("")}</feed>`,
      );
      return;
    }
    const match = new RegExp(
      `^${prefix}/download/((?:desktop-v|v)[0-9.]+(?:-insider)?)/([^/]+)$`,
      "u",
    ).exec(url.pathname);
    if (match && assets.has(match[2]!)) return redirect(`${objects}/${match[1]}/${match[2]}`);
  }
  const match = /^\/((?:desktop-v|v)[0-9.]+(?:-insider)?)\/([^/]+)$/u.exec(url.pathname);
  if (req.headers.host === "objects.opensteer.test" && match && assets.has(match[2]!)) {
    const file = path.join(root, match[1]!, match[2]!);
    if (!existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const size = statSync(file).size;
    const range = /^bytes=(\d+)-(\d*)$/u.exec(req.headers.range ?? "");
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || end < start) {
      res.writeHead(416, { "content-range": `bytes */${size}` });
      res.end();
      return;
    }
    res.setHeader("accept-ranges", "bytes");
    res.setHeader("content-length", end - start + 1);
    if (range) res.writeHead(206, { "content-range": `bytes ${start}-${end}/${size}` });
    const stream = createReadStream(file, { start, end });
    stream.on("error", () => {
      res.statusCode = 404;
      res.end();
    });
    let bytes = 0;
    stream.on("data", (chunk) => {
      bytes += chunk.length;
    });
    res.on("finish", () =>
      appendFileSync(
        log,
        JSON.stringify({
          at: Date.now(),
          transferComplete: url.pathname,
          bytes,
          size,
          start,
          end,
        }) + "\n",
      ),
    );
    stream.pipe(res);
    return;
  }
  res.writeHead(404);
  res.end();
});
server.on("secureConnection", (socket) => {
  appendFileSync(log, JSON.stringify({ at: Date.now(), tlsSni: socket.servername }) + "\n");
});
// macOS resolver sends every *.opensteer.com lookup here, including unknown subdomains.
const dns = createSocket("udp4");
dns.on("message", (message, peer) => {
  let offset = 12;
  const labels: string[] = [];
  while (offset < message.length && message[offset]) {
    const length = message[offset++]!;
    labels.push(message.subarray(offset, offset + length).toString());
    offset += length;
  }
  appendFileSync(log, JSON.stringify({ at: Date.now(), forbiddenDns: labels.join(".") }) + "\n");
  const reply = Buffer.from(message.subarray(0, offset + 5));
  reply.writeUInt16BE(0x8183, 2);
  reply.writeUInt16BE(1, 4);
  reply.writeUInt16BE(0, 6);
  reply.writeUInt16BE(0, 8);
  reply.writeUInt16BE(0, 10);
  dns.send(reply, peer.port, peer.address);
});
const test = process.env.OPENSTEER_MIRROR_TEST_PORT === "0";
const sinkholeTls = createServer(
  { cert: readFileSync(cert), key: readFileSync(key) },
  (_req, res) => res.end("sinkhole"),
);
const sinkholeHttp = createHttpServer((req, res) => {
  appendFileSync(log, JSON.stringify({ at: Date.now(), httpHost: req.headers.host }) + "\n");
  res.end("sinkhole");
});
for (const listener of [sinkholeTls, sinkholeHttp])
  listener.on("connection", () =>
    appendFileSync(log, JSON.stringify({ at: Date.now(), sinkholeConnection: true }) + "\n"),
  );
sinkholeTls.on("secureConnection", (socket) =>
  appendFileSync(log, JSON.stringify({ at: Date.now(), tlsSni: socket.servername }) + "\n"),
);
if (!test && !existsSync("/Volumes/My Shared Files/inputs")) throw new Error("Guest only");
await Promise.all([
  new Promise<void>((resolve) => server.listen(test ? 0 : 443, "127.0.0.1", resolve)),
  new Promise<void>((resolve) => dns.bind(test ? 0 : 53, "127.0.0.1", resolve)),
  new Promise<void>((resolve) =>
    sinkholeTls.listen(test ? 0 : 443, test ? "127.0.0.1" : "127.0.0.2", resolve),
  ),
  new Promise<void>((resolve) =>
    sinkholeHttp.listen(test ? 0 : 80, test ? "127.0.0.1" : "127.0.0.2", resolve),
  ),
]);
console.log(JSON.stringify({ https: server.address(), dns: dns.address() }));
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    server.close();
    dns.close();
    sinkholeTls.close();
    sinkholeHttp.close();
  });
