import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  realpath,
  readdir,
  rename,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp, { type Metadata } from "sharp";
import { z } from "zod";
import { OpensteerError, type UserId } from "@opensteer/core";
import type { AssetUrl, AssetUrlsInput } from "@opensteer/protocol";
import type { FastifyInstance } from "fastify";

const types = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
} as const;
const Claims = z.strictObject({
  v: z.literal(1),
  path: z.string().max(4096),
  dev: z.number(),
  ino: z.number(),
  size: z.number().nonnegative(),
  mtimeMs: z.number(),
  variant: z.enum(["preview", "original"]),
  exp: z.number().int(),
});
type Claims = z.infer<typeof Claims>;
const bucket = 4 * 60 * 60 * 1000;
const within = (file: string, root: string) => file === root || file.startsWith(root + path.sep);
const revision = (s: Pick<Claims, "dev" | "ino" | "size" | "mtimeMs">) =>
  `${s.dev}-${s.ino}-${s.size}-${s.mtimeMs}`;
const mediaType = (file: string) => types[path.extname(file).toLowerCase() as keyof typeof types];

export class AssetService {
  readonly #key: Buffer;
  readonly #pending = new Map<string, Promise<string>>();
  #active = 0;
  readonly #waiting: (() => void)[] = [];
  readonly options: {
    authSecret: string;
    dataDirectory: string;
    runnerDataDirectory: string;
    agentHome: () => Promise<string>;
    owns: (threadId: AssetUrlsInput["threadId"], ownerId: UserId) => Promise<boolean>;
    homeDirectory?: string;
    now?: () => number;
  };
  constructor(options: AssetService["options"]) {
    this.options = options;
    this.#key = createHmac("sha256", options.authSecret)
      .update("opensteer-local-media-v1")
      .digest();
  }
  #now() {
    return (this.options.now ?? Date.now)();
  }
  async urls(input: AssetUrlsInput, ownerId: UserId) {
    if (!(await this.options.owns(input.threadId, ownerId)))
      throw new OpensteerError({ code: "not_found", message: "Thread not found" });
    const assets: AssetUrl[] = await Promise.all(
      input.assets.map((item) => this.#mint(item.path, item.variant)),
    );
    return { assets };
  }
  async #resolve(source: string): Promise<string | null> {
    if (source.startsWith("\\\\") || source.startsWith("//")) return null;
    if (/^file:/iu.test(source)) {
      const url = new URL(source);
      if (url.hostname && url.hostname !== "localhost") return null;
      source = fileURLToPath(url);
      if (source.startsWith("//") || source.startsWith("\\\\")) return null;
    } else if (/^[a-z][a-z\d+.-]*:/iu.test(source) && !/^[a-z]:[\\/]/iu.test(source)) return null;
    const home = this.options.homeDirectory ?? homedir();
    if (source.startsWith("~/")) source = path.join(home, source.slice(2));
    return path.resolve(await this.options.agentHome(), source);
  }
  async #denied(file: string) {
    const canonical = async (root: string) => realpath(root).catch(() => path.resolve(root));
    const host = await canonical(this.options.dataDirectory);
    const runner = await canonical(this.options.runnerDataDirectory);
    const images = path.join(runner, "images");
    const validImage =
      path.dirname(file) === images &&
      /^[a-f0-9]{64}\.(png|jpg|jpeg|webp|gif|avif|svg)$/u.test(path.basename(file));
    if (within(file, runner)) return !validImage;
    const home = this.options.homeDirectory ?? homedir();
    const roots = [
      host,
      ...["postgres", "runtime", "logs"].map((name) => path.join(path.dirname(host), name)),
      path.join(path.dirname(host), "deployment.v1.json"),
      "/dev",
      "/proc",
      path.join(home, ".opensteer"),
      path.join(home, ".config/opensteer"),
      path.join(home, "Library/Application Support/Opensteer"),
      path.join(home, "Library/Application Support/Opensteer Beta"),
    ];
    for (const root of roots) if (within(file, path.resolve(root))) return true;
    return false;
  }
  async #mint(source: string, variant: Claims["variant"]): Promise<AssetUrl> {
    try {
      const resolved = await this.#resolve(source);
      if (!resolved) return { status: "unavailable", reason: "denied" };
      if (await this.#denied(resolved)) return { status: "unavailable", reason: "denied" };
      const file = await realpath(resolved);
      if (await this.#denied(file)) return { status: "unavailable", reason: "denied" };
      const type = mediaType(file);
      if (!type) return { status: "unavailable", reason: "unsupported" };
      const handle = await open(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const s = await handle.stat();
        if (!s.isFile()) return { status: "unavailable", reason: "unsupported" };
        const metadata = await this.#metadata(file);
        const preview = variant === "preview" && this.#resize(type, s.size, metadata);
        const width = metadata.autoOrient?.width ?? metadata.width ?? null;
        const height = metadata.autoOrient?.height ?? metadata.height ?? null;
        const scale = preview && width && height ? Math.min(1, 1280 / Math.max(width, height)) : 1;
        const exp = Math.floor(this.#now() / bucket) * bucket + 2 * bucket;
        const claims: Claims = {
          v: 1,
          path: file,
          dev: s.dev,
          ino: s.ino,
          size: s.size,
          mtimeMs: s.mtimeMs,
          // A preview that would equal the original is the original's URL, so
          // both share one cache entry and serving never inspects the image.
          variant: preview ? "preview" : "original",
          exp,
        };
        const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
        const token = `${payload}.${this.#sign(payload)}`;
        return {
          status: "ok",
          url: `/media/${token}/${encodeURIComponent(path.basename(file))}`,
          expiresAt: new Date(exp).toISOString(),
          revision: revision(claims),
          mediaType: preview ? "image/webp" : type,
          width: width ? Math.round(width * scale) : null,
          height: height ? Math.round(height * scale) : null,
        };
      } finally {
        await handle.close();
      }
    } catch (error) {
      return {
        status: "unavailable",
        reason:
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "missing"
            : ["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")
              ? "denied"
              : "unsupported",
      };
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
      const expected = Buffer.from(this.#sign(payload));
      const supplied = Buffer.from(signature);
      if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
      const c = Claims.parse(JSON.parse(Buffer.from(payload, "base64url").toString()));
      return c.exp > this.#now() && c.exp <= this.#now() + 2 * bucket ? c : null;
    } catch {
      return null;
    }
  }
  async #metadata(file: string) {
    return sharp(file, { limitInputPixels: 100_000_000 }).metadata();
  }
  #resize(type: string, size: number, m: Metadata) {
    return (
      type !== "image/svg+xml" &&
      (m.pages ?? 1) <= 1 &&
      (Math.max(m.width ?? 0, m.height ?? 0) > 1280 || size > 512 * 1024)
    );
  }
  async #preview(c: Claims, handle: FileHandle) {
    const key = createHash("sha256")
      .update(`${c.path}:${revision(c)}:1280:webp:80:v1`)
      .digest("hex");
    const directory = path.join(this.options.dataDirectory, "media-previews");
    const target = path.join(directory, `${key}.webp`);
    const pending = this.#pending.get(key);
    if (pending) return pending;
    const job = (async () => {
      if (
        await stat(target).then(
          (s) => s.isFile(),
          () => false,
        )
      )
        return target;
      if (this.#active >= 2) await new Promise<void>((resolve) => this.#waiting.push(resolve));
      else this.#active++;
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const transform = sharp({ limitInputPixels: 100_000_000 })
          .rotate()
          .resize({ width: 1280, height: 1280, fit: "inside", withoutEnlargement: true })
          .webp({ quality: 80 });
        const { pipeline } = await import("node:stream/promises");
        const output = transform.toFile(temporary);
        await Promise.all([
          pipeline(handle.createReadStream({ autoClose: false, start: 0 }), transform),
          output,
        ]);
        await rename(temporary, target);
        const entries = await Promise.all(
          (await readdir(directory))
            .filter((n) => n.endsWith(".webp"))
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
        return target;
      } finally {
        await unlink(temporary).catch(() => undefined);
        const next = this.#waiting.shift();
        if (next) next();
        else this.#active--;
      }
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
        let handle: FileHandle | undefined;
        try {
          const c = this.#verify(request.params.token);
          if (!c || request.params.name !== path.basename(c.path) || (await this.#denied(c.path)))
            return reply.code(404).send();
          handle = await open(
            c.path,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          const s = await handle.stat();
          const type = mediaType(c.path);
          if (!s.isFile() || !type || revision(s) !== revision(c)) return reply.code(404).send();
          const preview = c.variant === "preview";
          if (preview) {
            const cached = await this.#preview(c, handle);
            await handle.close();
            handle = undefined;
            handle = await open(
              cached,
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
          }
          const length = (await handle.stat()).size;
          reply.headers({
            "content-type": preview ? "image/webp" : type,
            "content-length": length,
            "x-content-type-options": "nosniff",
            "cache-control": `private, max-age=${Math.max(0, Math.floor((c.exp - this.#now()) / 1000))}, immutable`,
            etag: `"${revision(c)}-${c.variant}"`,
            "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
            "cross-origin-resource-policy": "cross-origin",
          });
          const stream = handle.createReadStream({ start: 0 });
          handle = undefined;
          return reply.send(stream);
        } catch {
          return reply.code(404).send();
        } finally {
          await handle?.close();
        }
      },
    );
  }
}
