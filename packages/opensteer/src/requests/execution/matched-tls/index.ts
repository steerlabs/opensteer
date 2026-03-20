import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  createBodyPayload,
  type BodyPayload,
  type HeaderEntry,
  type SessionTransportResponse,
} from "@opensteer/browser-core";
import type { CookieRecord } from "@opensteer/protocol";

const MATCHED_TLS_BINARY_NAMES = [
  "curl-impersonate-chrome",
  "curl_chrome",
] as const;

export async function executeMatchedTlsTransportRequest(input: {
  readonly request: {
    readonly method: string;
    readonly url: string;
    readonly headers?: readonly HeaderEntry[];
    readonly body?: BodyPayload;
    readonly followRedirects?: boolean;
  };
  readonly cookies?: readonly CookieRecord[];
  readonly signal: AbortSignal;
}): Promise<SessionTransportResponse> {
  const binary = await resolveMatchedTlsBinary();
  const workingDirectory = await mkdtemp(path.join(tmpdir(), "opensteer-matched-tls-"));
  const headersPath = path.join(workingDirectory, "headers.txt");
  const bodyPath = path.join(workingDirectory, "body.bin");
  const cookiesPath = path.join(workingDirectory, "cookies.txt");
  const requestBodyPath = path.join(workingDirectory, "request-body.bin");

  try {
    await writeFile(cookiesPath, toNetscapeCookieJar(input.cookies ?? []), "utf8");
    if (input.request.body !== undefined) {
      await writeFile(requestBodyPath, input.request.body.bytes);
    }

    const args = [
      "--silent",
      "--show-error",
      "--compressed",
      "--request",
      input.request.method,
      "--url",
      input.request.url,
      "--dump-header",
      headersPath,
      "--output",
      bodyPath,
      "--cookie",
      cookiesPath,
      "--cookie-jar",
      cookiesPath,
      ...(input.request.followRedirects === false ? [] : ["--location"]),
      ...(input.request.body === undefined ? [] : ["--data-binary", `@${requestBodyPath}`]),
      ...flattenHeaders(input.request.headers ?? []),
      "--write-out",
      "%{url_effective}\n%{num_redirects}\n",
    ];

    const { stdout, stderr } = await spawnAndCollect(binary, args, input.signal);
    const metadata = stdout.trim().split("\n");
    const effectiveUrl = metadata[0] ?? input.request.url;
    const redirectCount = Number.parseInt(metadata[1] ?? "0", 10);
    const rawHeaders = await readFile(headersPath, "utf8");
    const parsedHeaders = parseCurlHeaderBlocks(rawHeaders);
    const responseBlock = parsedHeaders.at(-1);
    if (responseBlock === undefined) {
      throw new Error(`matched-tls transport did not emit response headers${stderr.length === 0 ? "" : `: ${stderr.trim()}`}`);
    }

    const bodyBytes = await readFile(bodyPath).catch(() => Buffer.alloc(0));
    const contentType = responseBlock.headers.find((header) => header.name.toLowerCase() === "content-type")?.value;

    return {
      url: effectiveUrl,
      status: responseBlock.status,
      statusText: responseBlock.statusText,
      headers: responseBlock.headers,
      ...(bodyBytes.byteLength === 0
        ? {}
        : { body: createBodyPayload(new Uint8Array(bodyBytes), parseContentType(contentType)) }),
      redirected: Number.isFinite(redirectCount) && redirectCount > 0,
    };
  } finally {
    await rm(workingDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function resolveMatchedTlsBinary(): Promise<string> {
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter((entry) => entry.length > 0);
  for (const directory of pathEntries) {
    for (const name of MATCHED_TLS_BINARY_NAMES) {
      const candidate = path.join(directory, name);
      if (await isExecutable(candidate)) {
        return candidate;
      }
    }

    const files = await readDirSafe(directory);
    const discovered = files.find((file) => file.startsWith("curl_chrome"));
    if (discovered !== undefined) {
      const candidate = path.join(directory, discovered);
      if (await isExecutable(candidate)) {
        return candidate;
      }
    }
  }

  throw new Error(
    'matched-tls transport requires a curl-impersonate Chrome binary in PATH (for example "curl-impersonate-chrome" or a "curl_chrome*" wrapper). Install curl-impersonate and retry.',
  );
}

async function spawnAndCollect(
  command: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<{
  readonly stdout: string;
  readonly stderr: string;
}> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const abort = () => {
      child.kill("SIGKILL");
      reject(new Error("matched-tls request aborted"));
    };

    signal.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (code !== 0) {
        reject(new Error(`matched-tls transport exited with code ${String(code)}${stderr.length === 0 ? "" : `: ${stderr.trim()}`}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function flattenHeaders(headers: readonly HeaderEntry[]): string[] {
  return headers.flatMap((header) => ["--header", `${header.name}: ${header.value}`]);
}

function toNetscapeCookieJar(cookies: readonly CookieRecord[]): string {
  const lines = [
    "# Netscape HTTP Cookie File",
    "# This file is generated by Opensteer matched-tls transport.",
  ];
  for (const cookie of cookies) {
    lines.push(
      [
        cookie.domain,
        cookie.domain.startsWith(".") ? "TRUE" : "FALSE",
        cookie.path,
        cookie.secure ? "TRUE" : "FALSE",
        cookie.expiresAt === undefined || cookie.expiresAt === null ? "0" : String(Math.floor(cookie.expiresAt / 1000)),
        cookie.name,
        cookie.value,
      ].join("\t"),
    );
  }
  return `${lines.join("\n")}\n`;
}

function parseCurlHeaderBlocks(raw: string): readonly {
  readonly status: number;
  readonly statusText: string;
  readonly headers: readonly HeaderEntry[];
}[] {
  return raw
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter((block) => block.startsWith("HTTP/"))
    .map((block) => {
      const [statusLine, ...headerLines] = block.split(/\r?\n/);
      const statusMatch = statusLine?.match(/^HTTP\/\d+(?:\.\d+)?\s+(\d{3})(?:\s+(.*))?$/);
      if (!statusMatch) {
        throw new Error(`invalid matched-tls status line: ${statusLine ?? "<missing>"}`);
      }
      return {
        status: Number.parseInt(statusMatch[1]!, 10),
        statusText: statusMatch[2] ?? "",
        headers: headerLines
          .map((line) => {
            const separator = line.indexOf(":");
            if (separator <= 0) {
              return undefined;
            }
            return {
              name: line.slice(0, separator).trim(),
              value: line.slice(separator + 1).trim(),
            } satisfies HeaderEntry;
          })
          .filter((header): header is HeaderEntry => header !== undefined),
      };
    });
}

function parseContentType(contentType: string | undefined): {
  readonly mimeType?: string;
  readonly charset?: string;
} {
  if (contentType === undefined) {
    return {};
  }
  const [mimeTypePart, ...parts] = contentType.split(";");
  const mimeType = mimeTypePart?.trim();
  const charsetPart = parts.find((part) => part.trim().toLowerCase().startsWith("charset="));
  const charset = charsetPart?.split("=")[1]?.trim();
  return {
    ...(mimeType === undefined || mimeType.length === 0 ? {} : { mimeType }),
    ...(charset === undefined || charset.length === 0 ? {} : { charset }),
  };
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    const { access, constants } = await import("node:fs/promises");
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function readDirSafe(directory: string): Promise<readonly string[]> {
  try {
    const { readdir } = await import("node:fs/promises");
    return await readdir(directory);
  } catch {
    return [];
  }
}
