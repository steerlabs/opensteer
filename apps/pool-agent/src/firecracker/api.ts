/** Firecracker's REST API over its jailed Unix socket. */
import { request } from "node:http";

export class FirecrackerApiError extends Error {
  override readonly name = "FirecrackerApiError";
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function firecrackerApi(
  socketPath: string,
  method: "GET" | "PUT" | "PATCH",
  path: string,
  body?: unknown,
  timeoutMs = 10_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const outgoing = request(
      {
        socketPath,
        method,
        path,
        headers: {
          accept: "application/json",
          ...(payload
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
            : {}),
        },
        timeout: timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          // Firecracker's answers are small; a large one is not read.
          if (size <= 64 * 1024) chunks.push(chunk);
        });
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            let fault = text;
            try {
              fault = (JSON.parse(text) as { fault_message?: string }).fault_message ?? text;
            } catch {
              // The fault text is kept as it is.
            }
            reject(
              new FirecrackerApiError(
                status,
                `${method} ${path}: ${status} ${fault.slice(0, 500)}`,
              ),
            );
            return;
          }
          if (!text) return resolve(undefined);
          try {
            resolve(JSON.parse(text));
          } catch {
            resolve(undefined);
          }
        });
        response.on("error", reject);
      },
    );
    outgoing.on("timeout", () =>
      outgoing.destroy(new Error(`${method} ${path}: no answer in ${timeoutMs} ms`)),
    );
    outgoing.on("error", reject);
    outgoing.end(payload);
  });
}
