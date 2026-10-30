import { phoneUpdateRelease, type AgentPhoneUpdateRelease } from "../agent-phone/update-release.js";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { opensteerChromeExtensionId } from "@opensteer/protocol/browser-sources";

const maximumStaticFileBytes = 64 * 1_024 * 1_024;
const maximumStaticDistributionBytes = 256 * 1_024 * 1_024;
const maximumStaticFiles = 8_192;

const StaticPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !path.posix.isAbsolute(value) && !value.includes("\\"))
  .refine((value) =>
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
  );

export const HostStaticDistributionManifestSchema = z.strictObject({
  buildId: z.string().trim().min(1).max(120),
  files: z
    .array(
      z.strictObject({
        path: StaticPathSchema,
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      }),
    )
    .min(1)
    .max(maximumStaticFiles),
  hostVersion: z.string().trim().min(1).max(120),
  schemaVersion: z.literal(1),
});

interface HostStaticDistributionConfig {
  readonly directory: string;
  readonly expectedHostVersion: string;
  readonly expectedBuildId: string;
  readonly manifestPath: string;
}

export class HostStaticDistributionVersionMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostStaticDistributionVersionMismatchError";
  }
}

export class HostStaticDistribution {
  readonly #files: ReadonlyMap<string, Buffer>;

  readonly agentPhoneRelease: AgentPhoneUpdateRelease | null;

  private constructor(
    files: ReadonlyMap<string, Buffer>,
    agentPhoneRelease: AgentPhoneUpdateRelease | null,
  ) {
    this.#files = files;
    this.agentPhoneRelease = agentPhoneRelease;
  }

  static async load(config: HostStaticDistributionConfig): Promise<HostStaticDistribution> {
    const directory = path.resolve(config.directory);
    const manifestPath = path.resolve(config.manifestPath);
    const [directoryMetadata, manifestMetadata] = await Promise.all([
      lstat(directory),
      lstat(manifestPath),
    ]);
    if (
      directoryMetadata.isSymbolicLink() ||
      !directoryMetadata.isDirectory() ||
      manifestMetadata.isSymbolicLink() ||
      !manifestMetadata.isFile()
    ) {
      throw new Error("Host Web distribution must use real files inside a real directory");
    }
    const [realDirectory, realManifest] = await Promise.all([
      realpath(directory),
      realpath(manifestPath),
    ]);
    if (!realManifest.startsWith(`${realDirectory}${path.sep}`)) {
      throw new Error("Host Web distribution manifest escapes its directory");
    }
    const manifestBytes = await readFile(manifestPath);
    if (manifestBytes.byteLength < 1 || manifestBytes.byteLength > 512 * 1_024) {
      throw new Error("Host Web distribution manifest has an invalid size");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
    } catch (error) {
      throw new Error("Host Web distribution manifest is invalid", { cause: error });
    }
    const manifest = HostStaticDistributionManifestSchema.parse(decoded);
    if (
      manifest.hostVersion !== config.expectedHostVersion ||
      manifest.buildId !== config.expectedBuildId
    ) {
      throw new HostStaticDistributionVersionMismatchError(
        `Web distribution ${manifest.buildId}/${manifest.hostVersion} does not match Host ${config.expectedBuildId}/${config.expectedHostVersion}`,
      );
    }
    const declared = new Set<string>();
    const files = new Map<string, Buffer>();
    let totalBytes = 0;
    for (const file of manifest.files) {
      if (declared.has(file.path)) throw new Error("Host Web distribution repeats a file");
      declared.add(file.path);
      const candidate = path.resolve(directory, ...file.path.split("/"));
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error(`Host Web distribution file ${file.path} is not a regular file`);
      }
      const realCandidate = await realpath(candidate);
      if (!realCandidate.startsWith(`${realDirectory}${path.sep}`)) {
        throw new Error(`Host Web distribution file ${file.path} escapes its directory`);
      }
      if (metadata.size < 1 || metadata.size > maximumStaticFileBytes) {
        throw new Error(`Host Web distribution file ${file.path} has an invalid size`);
      }
      totalBytes += metadata.size;
      if (totalBytes > maximumStaticDistributionBytes) {
        throw new Error("Host Web distribution is too large");
      }
      const bytes = await readFile(candidate);
      if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
        throw new Error(`Host Web distribution file ${file.path} failed verification`);
      }
      files.set(file.path, bytes);
    }
    if (!files.has("index.html")) {
      throw new Error("Host Web distribution does not declare index.html");
    }
    if (
      ![...files]
        .filter(([filePath]) => filePath.endsWith(".js"))
        .some(([, bytes]) => bytes.includes(Buffer.from(manifest.buildId, "utf8")))
    ) {
      throw new HostStaticDistributionVersionMismatchError(
        "Host Web distribution does not embed its declared build identity",
      );
    }
    return new HostStaticDistribution(files, phoneUpdateRelease(files, config.expectedHostVersion));
  }

  register(app: FastifyInstance): void {
    app.get("/*", async (request, reply) => {
      applyStaticSecurityHeaders(reply);
      const requested = boundedStaticPath(request.raw.url ?? request.url);
      if (requested === null || reservedApiPath(requested)) return reply.code(404).send();
      const file = this.#files.get(requested);
      if (file) return sendStaticFile(reply, requested, file);
      if (requested.startsWith("assets/")) return reply.code(404).send();
      return sendStaticFile(reply, "index.html", this.#files.get("index.html")!);
    });
  }
}

const staticContentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".woff2", "font/woff2"],
  [".zip", "application/zip"],
]);

function sendStaticFile(reply: FastifyReply, filePath: string, bytes: Buffer) {
  const immutable =
    filePath.startsWith("assets/") && /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/u.test(filePath);
  return reply
    .header("cache-control", immutable ? "public, max-age=31536000, immutable" : "no-store")
    .type(
      staticContentTypes.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream",
    )
    .send(bytes);
}

/**
 * The page learns whether the Opensteer extension is installed by loading one
 * image the extension exposes; only that extension's origin is allowed. The
 * HEIC photo decoder runs in a worker it creates from its own code, so blob
 * workers are allowed; it needs neither eval nor WebAssembly.
 */
const staticContentSecurityPolicy = `default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob: chrome-extension://${opensteerChromeExtensionId}; style-src 'self'; script-src 'self'; worker-src blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`;

function applyStaticSecurityHeaders(reply: FastifyReply): void {
  void reply
    .header("strict-transport-security", "max-age=31536000; includeSubDomains")
    .header("content-security-policy", staticContentSecurityPolicy)
    .header("permissions-policy", "camera=(), microphone=(self), geolocation=(), payment=()")
    .header("referrer-policy", "no-referrer")
    .header("x-content-type-options", "nosniff")
    .header("x-frame-options", "DENY");
}

function boundedStaticPath(rawUrl: string): string | null {
  const rawPath = rawUrl.split("?", 1)[0] ?? "";
  if (rawPath.length > 2_048 || rawPath.includes("\\") || /%2f|%5c/iu.test(rawPath)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  const segments = decoded.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === ".." || segment.includes("\0"))) {
    return null;
  }
  return segments.length === 0 ? "index.html" : segments.join("/");
}

function reservedApiPath(filePath: string): boolean {
  const first = filePath.split("/", 1)[0];
  return first === "v1" || first === "internal" || first === ".well-known" || first === "healthz";
}
