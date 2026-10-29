import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { OpensteerError } from "@opensteer/core";
import {
  EgressRelayRequestSchema,
  EgressRelayResponseSchema,
  type EgressRelayResponse,
} from "@opensteer/protocol";
import { resolvePublicAddress, tlsServerName } from "./public-network.js";
import {
  noOpCredentialResponseRedactor,
  type CredentialResponseRedactor,
} from "./response-redactor.js";

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const handlePattern = /os_secret_[A-Za-z0-9_-]{20,}/;
const allowedMethods = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);
const maxRequestHeaderBytes = 256 * 1_024;

export class HostEgressGateway {
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;
  readonly #requestTimeoutMs: number;

  constructor(
    options: {
      readonly maxRequestBytes?: number;
      readonly maxResponseBytes?: number;
      readonly requestTimeoutMs?: number;
    } = {},
  ) {
    this.#maxRequestBytes = positiveInteger(options.maxRequestBytes ?? 8 * 1_024 * 1_024);
    this.#maxResponseBytes = positiveInteger(options.maxResponseBytes ?? 16 * 1_024 * 1_024);
    this.#requestTimeoutMs = positiveInteger(options.requestTimeoutMs ?? 60_000);
  }

  async forward(input: unknown): Promise<EgressRelayResponse> {
    const request = EgressRelayRequestSchema.parse(input);
    if (!allowedMethods.has(request.method)) throw denied("HTTP egress method is not supported");
    const body = decodeBase64(request.bodyBase64);
    if (body.byteLength > this.#maxRequestBytes) throw denied("Egress request body is too large");
    if (
      handlePattern.test(request.url) ||
      Object.keys(request.headers).some((name) => handlePattern.test(name)) ||
      Object.values(request.headers).some((value) =>
        (typeof value === "string" ? [value] : value).some((item) => handlePattern.test(item)),
      ) ||
      handlePattern.test(body.toString("latin1"))
    ) {
      throw denied("Legacy credential handles are not supported");
    }
    return EgressRelayResponseSchema.parse(
      await requestPublicHttp(
        {
          body,
          headers: request.headers,
          method: request.method,
          url: new URL(request.url),
        },
        {
          maxResponseBytes: this.#maxResponseBytes,
          responseRedactor: noOpCredentialResponseRedactor,
          timeoutMs: this.#requestTimeoutMs,
        },
      ),
    );
  }
}

async function requestPublicHttp(
  input: {
    readonly body: Buffer;
    readonly headers: Readonly<Record<string, string | readonly string[]>>;
    readonly method: string;
    readonly url: URL;
  },
  limits: {
    readonly maxResponseBytes: number;
    readonly responseRedactor: CredentialResponseRedactor;
    readonly timeoutMs: number;
  },
): Promise<EgressRelayResponse> {
  if (input.url.protocol !== "http:" && input.url.protocol !== "https:") {
    throw denied("Only HTTP(S) egress is supported");
  }
  if (input.url.username || input.url.password)
    throw denied("Credentials in egress URLs are forbidden");
  if (input.url.hash) throw denied("Egress URLs cannot contain fragments");
  const address = await resolvePublicAddress(input.url.hostname);
  const headers = sanitizeRequestHeaders(input.headers);
  headers.host = input.url.host;
  headers["accept-encoding"] = "identity";
  headers["content-length"] = String(input.body.byteLength);
  const servername =
    input.url.protocol === "https:" ? tlsServerName(input.url.hostname) : undefined;
  const requestOptions: RequestOptions = {
    headers,
    hostname: address.address,
    family: address.family,
    method: input.method,
    path: `${input.url.pathname}${input.url.search}`,
    port: input.url.port || (input.url.protocol === "https:" ? 443 : 80),
    ...(servername ? { servername } : {}),
  };
  return new Promise<EgressRelayResponse>((resolve, reject) => {
    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      callback();
    };
    const request = (input.url.protocol === "https:" ? httpsRequest : httpRequest)(
      requestOptions,
      (response) => {
        if (response.statusCode === 101) {
          response.destroy(denied("HTTP protocol upgrades are not supported"));
          return;
        }
        if (
          limits.responseRedactor.maxPatternBytes > 0 &&
          response.headers["content-encoding"] &&
          response.headers["content-encoding"] !== "identity"
        ) {
          response.destroy(
            denied("Compressed credential-bearing responses cannot be safely returned"),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > limits.maxResponseBytes) {
            response.destroy(denied("Upstream response exceeded the configured limit"));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.once("error", (error) => finish(() => reject(error)));
        response.once("end", () =>
          finish(() => {
            const body = limits.responseRedactor.redactBuffer(Buffer.concat(chunks));
            resolve({
              bodyBase64: body.toString("base64"),
              headers: sanitizeResponseHeaders(response.headers, limits.responseRedactor),
              status: response.statusCode ?? 502,
            });
          }),
        );
      },
    );
    deadline = setTimeout(
      () => request.destroy(new Error("Egress request timed out")),
      limits.timeoutMs,
    );
    deadline.unref();
    request.once("connect", (_response, socket) => {
      socket.destroy();
      finish(() => reject(denied("HTTP CONNECT tunnels are not supported")));
    });
    request.once("upgrade", (_response, socket) => {
      socket.destroy();
      finish(() => reject(denied("HTTP protocol upgrades are not supported")));
    });
    request.once("error", (error) => finish(() => reject(error)));
    request.end(input.body);
  });
}

function sanitizeRequestHeaders(
  headers: Readonly<Record<string, string | readonly string[]>>,
): Record<string, string | string[]> {
  const output: Record<string, string | string[]> = {};
  let bytes = 0;
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      hopByHopHeaders.has(lower) ||
      lower === "host" ||
      lower === "content-length" ||
      lower === "accept-encoding"
    )
      continue;
    const values = typeof value === "string" ? [value] : [...value];
    if (values.some((item) => /[\r\n\0]/u.test(item))) {
      throw denied("HTTP request header contained a forbidden control character");
    }
    bytes += Buffer.byteLength(lower, "utf8");
    bytes += values.reduce((total, item) => total + Buffer.byteLength(item, "utf8"), 0);
    if (bytes > maxRequestHeaderBytes) throw denied("HTTP request headers are too large");
    output[lower] = typeof value === "string" ? value : values;
  }
  return output;
}

function sanitizeResponseHeaders(
  headers: import("node:http").IncomingHttpHeaders,
  redactor: CredentialResponseRedactor,
): Record<string, string | string[]> {
  const output: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || hopByHopHeaders.has(name.toLowerCase())) continue;
    output[name] =
      typeof value === "string"
        ? redactor.redactText(value)
        : value.map((item) => redactor.redactText(String(item)));
  }
  return output;
}

function decodeBase64(value: string): Buffer {
  if (value === "") return Buffer.alloc(0);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw denied("Egress request body was not canonical base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    decoded.fill(0);
    throw denied("Egress request body was not canonical base64");
  }
  return decoded;
}

function positiveInteger(value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new TypeError("Expected a positive integer");
  return value;
}

function denied(message: string): OpensteerError {
  return new OpensteerError({ code: "forbidden", message });
}
