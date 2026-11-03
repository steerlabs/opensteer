import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { BrowserPageFonts } from "@opensteer/shared/browserPage";
import type { FastifyInstance } from "fastify";

/**
 * The app's two typefaces, served by this process so its pages need no third
 * party and no second origin. Each file's name carries its digest, so a
 * browser keeps it until the bytes change. They are read from the declared
 * dependencies (`pnpm deploy --prod` installs them beside the bundle).
 */
const fontSources = {
  display: "@fontsource-variable/fraunces/files/fraunces-latin-wght-normal.woff2",
  sans: "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
} as const satisfies Record<keyof BrowserPageFonts, string>;

export const pageFontsPath = "/fonts";

export interface PageFonts {
  readonly hrefs: BrowserPageFonts;
  register(app: FastifyInstance): void;
}

export function loadPageFonts(): PageFonts {
  const require = createRequire(import.meta.url);
  const files = new Map<string, Buffer>();
  const href = (source: string, role: string) => {
    const bytes = readFileSync(require.resolve(source));
    const name = `${role}-${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.woff2`;
    files.set(name, bytes);
    return `${pageFontsPath}/${name}`;
  };
  const hrefs: BrowserPageFonts = {
    display: href(fontSources.display, "display"),
    sans: href(fontSources.sans, "sans"),
  };
  return {
    hrefs,
    register(app) {
      app.get<{ Params: { file: string } }>(`${pageFontsPath}/:file`, async (request, reply) => {
        const bytes = files.get(request.params.file);
        if (!bytes) return reply.code(404).header("cache-control", "no-store").send();
        return reply
          .header("cache-control", "public, max-age=31536000, immutable")
          .header("content-type", "font/woff2")
          .header("cross-origin-resource-policy", "same-origin")
          .header("x-content-type-options", "nosniff")
          .send(bytes);
      });
    },
  };
}
