import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runFileNameHeader, runFileTransferContentType } from "@opensteer/protocol";
import { RunFiles } from "./run-files.js";

it("streams uploads and downloads with transfer authority, name and declared size", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-transfer-"));
  const received: Buffer[] = [];
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    expect(request.headers.authorization).toBe("Bearer transfer-token");
    if (request.method === "PUT") {
      expect(request.headers["content-type"]).toBe(runFileTransferContentType);
      expect(request.headers[runFileNameHeader]).toBe(encodeURIComponent("photo 雪.jpg"));
      for await (const chunk of request) received.push(Buffer.from(chunk));
      response.writeHead(204);
      response.end();
    } else {
      response.writeHead(200, {
        "content-length": 4,
        [runFileNameHeader]: encodeURIComponent("../photo.jpg"),
      });
      response.end("data");
    }
  };
  const server = createServer((request, response) => void handle(request, response));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  const files = new RunFiles({
    dataDirectory: root,
    helperBinary: process.execPath,
    transport: { mode: "development", hostOrigin: new URL(`http://127.0.0.1:${address.port}`) },
  });
  const transfer = { id: "one", token: "transfer-token" };
  const controller = new AbortController();
  try {
    await files.upload(
      transfer,
      {
        body: Readable.from([Buffer.from("da"), Buffer.from("ta")]),
        size: 4,
        name: "photo 雪.jpg",
      },
      controller.signal,
    );
    expect(Buffer.concat(received).toString()).toBe("data");
    const download = await files.download(transfer, controller.signal);
    expect(download.name).toBe(".._photo.jpg");
    const path = await files.install(download, join(root, "exports"), controller.signal);
    expect(await readFile(path, "utf8")).toBe("data");
    controller.abort();
    await expect(files.download(transfer, controller.signal)).rejects.toThrow();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
