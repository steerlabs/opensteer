import type { IncomingMessage, ServerResponse } from "node:http";

export const pageDownloadName = "native-page-download.txt";
export const pageDownloadBytes = Buffer.from(
  "Opensteer native page download\nUnicode: café 日本語\n",
);
export const slowDownloadName = "native-cancelled-download.bin";
export const attachmentDownloadName = "conversation-attachment.txt";
export const attachmentDownloadBytes = Buffer.from(
  "Real conversation attachment download\n\0Binary tail: \xff",
  "utf8",
);

/** Own only fixture inputs and the slow response's timer, never download behavior. */
export function serveDownloadFixture(request: IncomingMessage, response: ServerResponse): boolean {
  if (request.url === "/downloads") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html>
      <meta charset="utf-8"><title>Native download fixture</title>
      <style>body{margin:0;background:#124c78;color:white;font:18px system-ui}a{display:block;margin:24px;padding:16px;background:white;color:#124c78;width:240px}</style>
      <a id="download" href="/downloads/file">Download fixture file</a>
      <a id="slow" href="/downloads/slow">Download slow fixture</a>
      <script>window.fixture={clicks:0};addEventListener('mousedown',()=>fixture.clicks++)</script>`);
    return true;
  }
  if (request.url === "/downloads/file") {
    response
      .writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${pageDownloadName}"`,
        "content-length": pageDownloadBytes.length,
      })
      .end(pageDownloadBytes);
    return true;
  }
  if (request.url === "/downloads/slow") {
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${slowDownloadName}"`,
      "content-length": 64 * 1024 * 1024,
    });
    const chunk = Buffer.alloc(32 * 1024, 0x5a);
    response.write(chunk);
    const timer = setInterval(() => response.write(chunk), 100);
    response.once("close", () => clearInterval(timer));
    return true;
  }
  return false;
}
