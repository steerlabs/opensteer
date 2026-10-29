import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { Protocol } from "electron";

export const desktopAppScheme = "app";
export const desktopAppOrigin = "app://opensteer";
export const desktopAppEntryUrl = `${desktopAppOrigin}/`;

const maximumAssetBytes = 24 * 1_024 * 1_024;
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  // The HEIC photo decoder runs in a worker it creates from its own code; it
  // needs neither eval nor WebAssembly (see attachments/upload-file.ts).
  "worker-src blob:",
  "frame-ancestors 'none'",
].join("; ");

export interface DesktopProtocolRegistrar {
  handle(scheme: string, handler: (request: Request) => Response | Promise<Response>): void;
  registerSchemesAsPrivileged(
    schemes: Parameters<Protocol["registerSchemesAsPrivileged"]>[0],
  ): void;
  unhandle(scheme: string): void;
}

export function registerDesktopAppScheme(protocol: DesktopProtocolRegistrar): void {
  protocol.registerSchemesAsPrivileged([
    {
      privileges: {
        bypassCSP: false,
        codeCache: true,
        corsEnabled: false,
        secure: true,
        standard: true,
        supportFetchAPI: false,
      },
      scheme: desktopAppScheme,
    },
  ]);
}

export function installDesktopAppProtocol(
  protocol: DesktopProtocolRegistrar,
  webRoot: string,
): () => void {
  const handler = createDesktopAppProtocolHandler(webRoot);
  protocol.handle(desktopAppScheme, handler);
  return () => protocol.unhandle(desktopAppScheme);
}

export function createDesktopAppProtocolHandler(
  webRoot: string,
): (request: Request) => Promise<Response> {
  const root = path.resolve(webRoot);
  const verifiedRoot = realDirectory(root);
  return async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD")
      return response(405, "Method Not Allowed");
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return response(400, "Bad Request");
    }
    if (
      url.protocol !== `${desktopAppScheme}:` ||
      url.hostname !== "opensteer" ||
      url.port ||
      url.username ||
      url.password
    ) {
      return response(404, "Not Found");
    }
    const requested = safeAssetPath(url.pathname);
    if (requested === null) return response(404, "Not Found");
    const candidate = path.join(root, requested);
    const realRoot = await verifiedRoot;
    let asset = await regularAsset(candidate, root, realRoot);
    if (!asset && !path.extname(requested))
      asset = await regularAsset(path.join(root, "index.html"), root, realRoot);
    if (!asset) return response(404, "Not Found");
    const body = request.method === "HEAD" ? null : await readFile(asset.filePath);
    return new Response(body, {
      headers: securityHeaders(asset.contentType),
      status: 200,
    });
  };
}

async function regularAsset(
  filePath: string,
  root: string,
  realRoot: string,
): Promise<{ readonly contentType: string; readonly filePath: string } | null> {
  const resolved = path.resolve(filePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  try {
    const metadata = await lstat(resolved);
    const canonical = await realpath(resolved);
    const expectedCanonical = path.join(realRoot, relative);
    if (
      canonical !== expectedCanonical ||
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.size > maximumAssetBytes
    )
      return null;
  } catch {
    return null;
  }
  return { contentType: contentTypeFor(resolved), filePath: resolved };
}

async function realDirectory(directory: string): Promise<string> {
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Bundled Desktop web content must be a real directory.");
  }
  return realpath(directory);
}

function safeAssetPath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const segments = decoded.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  return segments.join("/") || "index.html";
}

function response(status: number, body: string): Response {
  return new Response(body, { headers: securityHeaders("text/plain; charset=utf-8"), status });
}

function securityHeaders(contentType: string): HeadersInit {
  return {
    "cache-control": "no-store",
    "content-security-policy": contentSecurityPolicy,
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    // WebUSB is the one device API the app uses — setting a phone up over its
    // ADB interface — and only its own top-level page may ask for it.
    "permissions-policy":
      "camera=(), microphone=(), geolocation=(), display-capture=(), usb=(self), serial=(), hid=(), bluetooth=(), payment=(), publickey-credentials-create=(), publickey-credentials-get=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-type": contentType,
  };
}

function contentTypeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}
