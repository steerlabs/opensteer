import { createHash } from "node:crypto";
import { Cache, Duration, Effect, Exit, Semaphore, Stream } from "effect";
import { HttpClient } from "effect/http";
import sharp from "sharp";
import { z } from "zod";
import { parseDestination, type HostEgress } from "@opensteer/plugin-engine-utils/url-policy";
import { pluginIconImageMaxBytes, pluginIconMaxBytes } from "@opensteer/protocol";
import { iconImageType } from "@opensteer/shared/imageType";

const declaredIcon = z.object({ src: z.string(), theme: z.string().optional() });
const inline = /^data:image\/(?:svg\+xml|png|webp|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/u;
const remote = /^https?:\/\/\S+$/u;

/**
 * Who declared an icon, which decides where the Host may read it from: a catalog icon from the
 * operator's feed under the engine's policy, a plugin's own only from public HTTPS addresses.
 */
export type PluginIconOrigin = "catalog" | "plugin";
export interface PluginIconSource {
  readonly src: string;
  readonly origin: PluginIconOrigin;
}

/**
 * The icon a plugin is drawn with, from the icons it or its catalog entry declares. Clients draw
 * plugin icons on a light tile in both themes, so a `light` variant wins, then one without a
 * theme. A `dark` variant alone is drawn for a dark ground and would vanish there, so it is unused.
 */
export function pluginIconSource(icons: unknown): string | null {
  const usable = (Array.isArray(icons) ? icons : []).flatMap((icon) => {
    const parsed = declaredIcon.safeParse(icon);
    return parsed.success && (inline.test(parsed.data.src) || remote.test(parsed.data.src))
      ? [parsed.data]
      : [];
  });
  return (
    (usable.find(({ theme }) => theme === "light") ?? usable.find(({ theme }) => !theme))?.src ??
    null
  );
}

/** What clients read an icon by: one declared source, with who declared it. */
export const pluginIconRef = ({ src, origin }: PluginIconSource) =>
  createHash("sha256").update(`${origin}\n${src}`).digest("base64url");

export function pluginIconRefOf(icons: unknown, origin: PluginIconOrigin): string | null {
  const src = pluginIconSource(icons);
  return src === null ? null : pluginIconRef({ src, origin });
}

/** Which of `refs` these declarations name, and where each is read from. */
export function pluginIconSources(
  refs: Iterable<string>,
  declarations: Iterable<unknown>,
  origin: PluginIconOrigin,
  found = new Map<string, PluginIconSource>(),
): Map<string, PluginIconSource> {
  const wanted = new Set(refs);
  for (const icons of declarations) {
    const src = pluginIconSource(icons);
    if (src === null) continue;
    const ref = pluginIconRef({ src, origin });
    if (wanted.has(ref)) found.set(ref, { src, origin });
  }
  return found;
}

/** Every icon is served at this size, a tile's largest at three device pixels per point. */
const side = 128;
const largestRaster = 4_096;
/** An SVG too wide to draw at density 1 within this is refused, so every render stays small. */
const largestSvgRender = 1_024;

/**
 * Icon bytes as the one small image every client draws: a `side`-pixel WebP, decoded and
 * rendered here so no client ever parses a plugin's SVG or a raster of unbounded size. An SVG is
 * rendered at the density that draws it at that size; librsvg reads nothing outside the bytes.
 */
async function normalize(bytes: Uint8Array): Promise<string | null> {
  if (bytes.byteLength === 0 || bytes.byteLength > pluginIconMaxBytes) return null;
  const type = iconImageType(bytes);
  if (!type) return null;
  const svg = type === "image/svg+xml";
  const limitInputPixels = svg ? false : largestRaster * largestRaster;
  const { width = 0, height = 0 } = await sharp(bytes, { limitInputPixels }).metadata();
  const longest = Math.max(width, height);
  if (!longest) return null;
  const density = svg ? Math.min(Math.max((72 * side) / longest, 1), 100_000) : undefined;
  if (density !== undefined && (longest * density) / 72 > largestSvgRender) return null;
  const image = await sharp(bytes, { limitInputPixels, ...(density ? { density } : {}) })
    // WebP keeps no EXIF, so a JPEG's orientation is applied to its pixels first.
    .rotate()
    .resize(side, side, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 90, alphaQuality: 100 })
    .toBuffer();
  return image.byteLength > pluginIconImageMaxBytes
    ? null
    : `data:image/webp;base64,${image.toString("base64")}`;
}

/**
 * One read of an icon address: 200 only (redirects are not followed), at most
 * `pluginIconMaxBytes`. The scope releases the response however the read ends.
 */
const fetchIcon = (egress: HostEgress, src: string) =>
  Effect.gen(function* () {
    // The client checks resolved names when it connects; an address written as an IP skips that.
    const url = parseDestination(src, egress.policy);
    if (!url) return null;
    const response = yield* HttpClient.withScope(egress.client).get(url, {
      headers: { accept: "image/svg+xml,image/png,image/webp,image/jpeg" },
    });
    if (response.status !== 200) return null;
    if (Number(response.headers["content-length"] ?? 0) > pluginIconMaxBytes) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    yield* Stream.runForEach(response.stream, (chunk) => {
      total += chunk.byteLength;
      if (total > pluginIconMaxBytes) return Effect.fail(new Error("Icon too large"));
      chunks.push(chunk);
      return Effect.void;
    });
    return Buffer.concat(chunks);
  }).pipe(Effect.scoped);

const inlineBytes = (src: string) => {
  const data = inline.exec(src);
  return data ? Buffer.from(data[1]!, "base64") : undefined;
};

/**
 * Reads plugin icons as small WebP data URIs. Each source is read once, at most eight at a time
 * across every request, and kept; one that gave no image is tried again after five minutes.
 * Only the fetch is timed: drawing can't be cancelled, so it keeps its permit until it settles,
 * and the size limits above are what bound it.
 */
export const pluginIconReader = (egress: Readonly<Record<PluginIconOrigin, HostEgress>>) =>
  Effect.gen(function* () {
    const permits = yield* Semaphore.make(8);
    const read = (key: string) => {
      const [origin, src] = JSON.parse(key) as [PluginIconOrigin, string];
      const bytes = inlineBytes(src);
      const fetched = bytes
        ? Effect.succeed(bytes)
        : fetchIcon(egress[origin], src).pipe(Effect.timeout("10 seconds"));
      return fetched.pipe(
        Effect.flatMap((found) =>
          found === null ? Effect.succeed(null) : Effect.tryPromise(() => normalize(found)),
        ),
        Effect.catch(() => Effect.succeed(null)),
        permits.withPermits(1),
      );
    };
    const images = yield* Cache.makeWith(read, {
      capacity: 512,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && exit.value !== null ? Duration.infinity : Duration.minutes(5),
    });
    return ({ src, origin }: PluginIconSource): Effect.Effect<string | null> =>
      Cache.get(images, JSON.stringify([origin, src]));
  });

export type PluginIconReader = Effect.Success<ReturnType<typeof pluginIconReader>>;

/** The images for these sources; a source with no image is left out. */
export const readPluginIcons = (
  read: PluginIconReader,
  sources: ReadonlyMap<string, PluginIconSource>,
) =>
  Effect.forEach(
    sources,
    ([ref, source]) =>
      Effect.map(read(source), (image) => (image === null ? [] : [{ ref, image }])),
    { concurrency: "unbounded" },
  ).pipe(Effect.map((icons) => icons.flat()));
