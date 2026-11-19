import { createHash } from "node:crypto";
import { z } from "zod";

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

/** An inline icon's bytes, or undefined for an address the Host must read. */
export function inlineIconBytes(src: string): Uint8Array | undefined {
  const data = inline.exec(src);
  return data ? Buffer.from(data[1]!, "base64") : undefined;
}
