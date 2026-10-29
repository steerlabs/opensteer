import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ignoreForeignTestRequest,
  probeTestServer,
} from "@opensteer/shared/test-support/serverProbes";
interface UpstreamRequest {
  readonly body: string;
  readonly contentType: string | null;
  readonly method: string;
  readonly url: string;
}

/**
 * The API's own server: it serves the document, refuses an invalid assistant
 * as the real service does, and reads an assistant back. The Host's provider
 * fetch lands here for the API's public origin and nowhere else.
 */
export async function startUpstream(document: string, upstreamOrigin: string, refusalBody: string) {
  const received: UpstreamRequest[] = [];
  const server = createServer((request, response) => {
    if (
      ignoreForeignTestRequest(
        request,
        response,
        (path) =>
          path === "/openapi.json" || path === "/assistant" || path.startsWith("/assistant/"),
      )
    )
      return;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const url = request.url ?? "/";
      const json = (status: number, body: string) =>
        response.writeHead(status, { "content-type": "application/json" }).end(body);
      if (url === "/openapi.json") {
        json(200, document);
        return;
      }
      received.push({
        body: Buffer.concat(chunks).toString("utf8"),
        contentType: request.headers["content-type"] ?? null,
        method: request.method ?? "",
        url,
      });
      if (request.method === "POST" && url === "/assistant") json(422, refusalBody);
      else if (request.method === "GET" && url.startsWith("/assistant/")) {
        json(
          200,
          JSON.stringify({
            id: decodeURIComponent(url.slice("/assistant/".length)),
            name: "Riley",
          }),
        );
      } else json(404, '{"message":"Not found"}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await probeTestServer(server);
  const fetchUpstream: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== upstreamOrigin) {
      throw new Error(`A provider request left for ${url.origin}`);
    }
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer();
    return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
      ...(body === undefined ? {} : { body }),
      headers: request.headers,
      method: request.method,
      redirect: "manual",
      signal: request.signal,
    });
  };
  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    fetch: fetchUpstream,
    received,
  };
}
