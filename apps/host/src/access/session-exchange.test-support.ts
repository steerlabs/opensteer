import { request as httpRequest } from "node:http";

/**
 * Sends a request with the `Host` and forwarded-protocol headers a reverse
 * proxy would set, which `fetch` refuses to let a caller write. The Host
 * derives a session exchange's route origin from exactly those, so the ingress
 * a test claims to arrive on has to be stated the way real ingress states it.
 */
export function fetchWithExplicitHost(url: string, init: RequestInit): Promise<Response> {
  const body =
    init.body instanceof URLSearchParams
      ? Buffer.from(init.body.toString())
      : typeof init.body === "string"
        ? Buffer.from(init.body)
        : undefined;
  const headers = Object.fromEntries(new Headers(init.headers));
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers, method: init.method }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) responseHeaders.append(name, item);
          } else if (value !== undefined) {
            responseHeaders.set(name, value);
          }
        }
        resolve(
          new Response(Buffer.concat(chunks), {
            headers: responseHeaders,
            status: response.statusCode ?? 500,
          }),
        );
      });
    });
    request.once("error", reject);
    if (body) request.write(body);
    request.end();
  });
}
