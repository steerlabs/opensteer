import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { UserIdSchema, ThreadIdSchema, type DeploymentId } from "@opensteer/core";
import {
  FileResourceSchema,
  type AssetUrl,
  type AssetVariant,
  type AssetUrlsInput,
  transcriptFileContentMaxBytes,
} from "@opensteer/protocol";
import { noFollowFlag, readBounded } from "@opensteer/shared/privateFiles";
import type { FastifyInstance } from "fastify";
import { rpcSuccess, AssetUrlsSchema, type HostApiServerContext } from "@opensteer/protocol";
import { requireSession } from "../integrations/integration-rpc-context.js";
import {
  TranscriptFileAccess,
  type FileActor,
  type FileContext,
  type ResolvedTranscriptFile,
} from "../threads/transcript-file-access.js";
import { fileUnavailable } from "../threads/rooted-file-reader.js";

const Claims = z.strictObject({
  v: z.literal(2),
  deploymentId: z.string().min(1),
  sessionId: z.string().min(1).max(512),
  userId: UserIdSchema,
  threadId: ThreadIdSchema.nullable(),
  resource: FileResourceSchema,
  variant: z.enum(["preview", "original"]),
  exp: z.number().int(),
});
type Claims = z.infer<typeof Claims>;
const bucket = 5 * 60 * 1000;
const previewMaxBytes = 512 * 1024;
const unavailable = (): AssetUrl => ({ status: "unavailable", reason: "missing" });
const rasterTypes: Readonly<Record<string, string>> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  svg: "image/svg+xml",
};
export class AssetService {
  readonly #key: Buffer;
  readonly #pending = new Map<string, Promise<Buffer>>();
  #active = 0;
  readonly #waiting: (() => void)[] = [];
  readonly options: {
    authSecret: string;
    dataDirectory: string;
    deploymentId: DeploymentId;
    access: TranscriptFileAccess;
    authorizeMedia: (input: FileContext & { sessionId: string }) => Promise<boolean>;
    now?: () => number;
  };
  constructor(options: AssetService["options"]) {
    this.options = options;
    this.#key = createHmac("sha256", options.authSecret)
      .update("opensteer-local-media-v2")
      .digest();
  }
  #now() {
    return (this.options.now ?? Date.now)();
  }
  async #slot<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.#active >= 2) await new Promise<void>((resolve) => this.#waiting.push(resolve));
    else this.#active++;
    try {
      signal?.throwIfAborted();
      return await run();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#active--;
    }
  }
  async urls(input: AssetUrlsInput, actor: FileActor, signal?: AbortSignal) {
    const context = { userId: actor.userId, threadId: input.threadId ?? null };
    await this.options.access.admit(context);
    if (!(await this.options.authorizeMedia({ ...context, sessionId: actor.sessionId })))
      throw fileUnavailable();
    const sources = await Promise.all(
      input.assets.map(async (item) => {
        try {
          return await this.options.access.normalizeImageSource(
            item.source ?? { kind: "path", path: item.path! },
          );
        } catch {
          return null;
        }
      }),
    );
    const valid = sources.flatMap((s) => (s ? [s] : []));
    const resolved = await this.options.access.resolveMany(valid, context, signal);
    let index = 0;
    const ordered = sources.map((s) => (s ? (resolved[index++] ?? null) : null));
    return {
      assets: await Promise.all(
        ordered.map((f, i) =>
          f
            ? this.urlForResource(f, input.assets[i]!.variant, actor, context.threadId, signal)
            : unavailable(),
        ),
      ),
    };
  }
  async urlForResource(
    file: ResolvedTranscriptFile,
    variant: AssetVariant,
    actor: FileActor,
    threadId: FileContext["threadId"],
    signal?: AbortSignal,
  ): Promise<AssetUrl> {
    const context = { userId: actor.userId, threadId };
    try {
      if (!(await this.options.authorizeMedia({ ...context, sessionId: actor.sessionId })))
        return unavailable();
      const metadata = await this.#slot(async () => {
        const result = await this.options.access.read(
          file.resource,
          context,
          { maxBytes: transcriptFileContentMaxBytes, full: true },
          signal,
        );
        return this.#metadata(result.bytes, result.mediaType, variant);
      }, signal);
      if (!metadata) return { status: "unavailable", reason: "unsupported" };
      const exp = Math.floor(this.#now() / bucket) * bucket + 2 * bucket;
      const claims: Claims = {
        v: 2,
        deploymentId: this.options.deploymentId,
        sessionId: actor.sessionId,
        ...context,
        resource: file.resource,
        variant,
        exp,
      };
      const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
      const token = `${payload}.${this.#sign(payload)}`;
      const url = `/media/${token}/${encodeURIComponent(file.name)}`;
      if (url.length > 8192) return unavailable();
      return {
        status: "ok",
        url,
        expiresAt: new Date(exp).toISOString(),
        revision: file.resource.revision,
        mediaType: variant === "preview" ? "image/webp" : metadata.type,
        width: metadata.width,
        height: metadata.height,
      };
    } catch {
      signal?.throwIfAborted();
      return unavailable();
    }
  }
  #sign(payload: string) {
    return createHmac("sha256", this.#key).update(payload).digest("base64url");
  }
  #verify(token: string): Claims | null {
    try {
      if (token.length > 8192) return null;
      const [payload, signature, extra] = token.split(".");
      if (!payload || !signature || extra !== undefined) return null;
      const expected = Buffer.from(this.#sign(payload)),
        supplied = Buffer.from(signature);
      if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
      const c = Claims.parse(JSON.parse(Buffer.from(payload, "base64url").toString()));
      return c.deploymentId === this.options.deploymentId &&
        c.exp > this.#now() &&
        c.exp <= this.#now() + 2 * bucket
        ? c
        : null;
    } catch {
      return null;
    }
  }
  async #metadata(bytes: Buffer, expectedType: string, variant: AssetVariant) {
    // SVG originals are downloads. They never enter a decoder or an active preview.
    if (expectedType === "image/svg+xml")
      return variant === "original" &&
        /^(?:\uFEFF)?\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/iu.test(bytes.subarray(0, 1024).toString())
        ? { type: "image/svg+xml" as const, width: null, height: null }
        : null;
    const m = await sharp(bytes, { limitInputPixels: 40_000_000, pages: 1 }).metadata();
    const type =
      m.format === "heif" && m.compression === "av1" ? "image/avif" : rasterTypes[m.format ?? ""];
    if (
      !type ||
      type !== expectedType ||
      type === "image/svg+xml" ||
      !m.width ||
      !m.height ||
      m.width * m.height > 40_000_000
    )
      return null;
    const width = m.autoOrient.width,
      height = m.autoOrient.height;
    const scale = variant === "preview" ? Math.min(1, 1280 / Math.max(width, height)) : 1;
    return {
      type: type as "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "image/avif",
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    };
  }
  async #preview(c: Claims, bytes: Buffer) {
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          c.deploymentId,
          c.sessionId,
          c.userId,
          c.threadId,
          c.resource,
          "webp-1280-v2",
        ]),
      )
      .digest("hex");
    const pending = this.#pending.get(key);
    if (pending) return pending;
    const job = (async () => {
      const directory = path.join(this.options.dataDirectory, "media-previews");
      const target = path.join(directory, `${key}.webp`);
      const cached = await open(
        target,
        constants.O_RDONLY | constants.O_NONBLOCK | noFollowFlag(),
      ).catch(() => null);
      if (cached) {
        try {
          const info = await cached.stat();
          if (info.isFile() && info.size <= previewMaxBytes)
            return await readBounded(cached, previewMaxBytes, fileUnavailable);
        } finally {
          await cached.close();
        }
      }
      let output = Buffer.alloc(0);
      for (const quality of [80, 60, 40, 20, 10, 1]) {
        output = await sharp(bytes, { limitInputPixels: 40_000_000, pages: 1 })
          .rotate()
          .resize({ width: 1280, height: 1280, fit: "inside", withoutEnlargement: true })
          .webp({ quality })
          .toBuffer();
        if (output.length <= previewMaxBytes) break;
      }
      if (output.length > previewMaxBytes) throw fileUnavailable();
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(output);
        } finally {
          await file.close();
        }
        await rename(temporary, target);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
      const entries = await Promise.all(
        (await readdir(directory))
          .filter((n) => /^[a-f0-9]{64}\.webp$/u.test(n))
          .map(async (name) => ({
            name,
            s: await stat(path.join(directory, name)).catch(() => null),
          })),
      );
      let total = entries.reduce((n, e) => n + (e.s?.size ?? 0), 0);
      for (const entry of entries.sort((a, b) => (a.s?.mtimeMs ?? 0) - (b.s?.mtimeMs ?? 0))) {
        if (total <= 256 * 1024 * 1024) break;
        if (entry.name === `${key}.webp`) continue;
        await unlink(path.join(directory, entry.name)).catch(() => undefined);
        total -= entry.s?.size ?? 0;
      }
      return output;
    })();
    this.#pending.set(key, job);
    try {
      return await job;
    } finally {
      this.#pending.delete(key);
    }
  }
  register(app: FastifyInstance) {
    app.get<{ Params: { token: string; name: string } }>(
      "/media/:token/:name",
      { logLevel: "silent" },
      async (request, reply) => {
        const abort = new AbortController();
        const disconnected = () => abort.abort();
        request.raw.once("aborted", disconnected);
        try {
          const c = this.#verify(request.params.token);
          if (!c || !(await this.options.authorizeMedia(c))) return reply.code(404).send();
          const result = await this.#slot(async () => {
            if (!(await this.options.authorizeMedia(c))) throw fileUnavailable();
            const file = await this.options.access.read(
              c.resource,
              c,
              { maxBytes: transcriptFileContentMaxBytes, full: true },
              abort.signal,
            );
            if (request.params.name !== file.name) throw fileUnavailable();
            if (!(await this.#metadata(file.bytes, file.mediaType, c.variant)))
              throw fileUnavailable();
            const bytes = c.variant === "preview" ? await this.#preview(c, file.bytes) : file.bytes;
            return { bytes, type: c.variant === "preview" ? "image/webp" : file.mediaType };
          }, abort.signal);
          reply.headers({
            "content-type": result.type,
            "content-length": result.bytes.length,
            "x-content-type-options": "nosniff",
            "cache-control": `private, max-age=${Math.max(0, Math.floor((c.exp - this.#now()) / 1000))}, immutable`,
            etag: `"${c.resource.revision}-${c.variant}"`,
            "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
            "cross-origin-resource-policy": "cross-origin",
            ...(result.type === "image/svg+xml" ? { "content-disposition": "attachment" } : {}),
          });
          return reply.send(result.bytes);
        } catch {
          return reply.code(404).send();
        } finally {
          request.raw.removeListener("aborted", disconnected);
        }
      },
    );
  }
}
export function createAssetUrlHandlers(assets: AssetService | undefined) {
  return {
    "asset.urls": async (input: AssetUrlsInput, context: HostApiServerContext) => {
      const session = requireSession(context);
      if (!assets) throw fileUnavailable();
      return rpcSuccess(
        AssetUrlsSchema.parse(
          await assets.urls(
            input,
            { userId: session.user.id, sessionId: session.id },
            context.signal,
          ),
        ),
      );
    },
  };
}
