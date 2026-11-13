import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type HtmlTagDescriptor, type Plugin } from "vite";

const origin = "https://opensteer.com";
// Shipped phone apps and the App Store listing open /privacy, /support and /download; keep those URLs.
const pages = ["index", "download", "support", "privacy", "terms", "404"];
// GitHub Latest is the newest Stable desktop release; Beta builds are prereleases and never take it.
const latest = "https://github.com/steerlabs/opensteer/releases/latest/download";
const tokens: Record<string, string> = {
  "{{macDownload}}": `${latest}/Opensteer-mac-arm64.zip`,
  "{{macInstall}}": `curl -fsSL ${latest}/install.sh | sh`,
};

const partial = (name: string): string =>
  readFileSync(resolve(import.meta.dirname, `src/partials/${name}.html`), "utf8").trim();

const meta = (attr: "name" | "property", key: string, content: string): HtmlTagDescriptor => ({
  tag: "meta",
  attrs: { [attr]: key, content },
  injectTo: "head",
});

/** Gives every page the same nav, footer and link-preview tags, derived from its own title and description. */
function siteShell(): Plugin {
  return {
    name: "opensteer-site-shell",
    transformIndexHtml: {
      order: "pre",
      handler(source, { path }) {
        const route = path.replace(/(index)?\.html$/, "") || "/";
        const title = /<title>([^<]+)<\/title>/.exec(source)?.[1] ?? "Opensteer";
        const description = /name="description"\s+content="([^"]+)"/.exec(source)?.[1] ?? "";
        const footer = partial("footer").replace(
          `<li><a href="${route}">`,
          `<li><a href="${route}" aria-current="page">`,
        );
        let html = source
          .replace("<!-- site:nav -->", partial("nav"))
          .replace("<!-- site:footer -->", footer);
        for (const [token, value] of Object.entries(tokens)) html = html.replaceAll(token, value);

        const tags: HtmlTagDescriptor[] = [
          {
            tag: "link",
            attrs: { rel: "icon", type: "image/png", href: "/opensteer.png" },
            injectTo: "head",
          },
          {
            tag: "link",
            attrs: { rel: "apple-touch-icon", href: "/opensteer.png" },
            injectTo: "head",
          },
          meta("name", "theme-color", "#080808"),
        ];
        if (route === "/404") {
          tags.push(meta("name", "robots", "noindex"));
          return { html, tags };
        }
        const url = `${origin}${route}`;
        tags.push(
          { tag: "link", attrs: { rel: "canonical", href: url }, injectTo: "head" },
          meta("property", "og:type", "website"),
          meta("property", "og:site_name", "Opensteer"),
          meta("property", "og:url", url),
          meta("property", "og:title", title),
          meta("property", "og:description", description),
          meta("property", "og:image", `${origin}/og.png`),
          meta("property", "og:image:width", "1200"),
          meta("property", "og:image:height", "630"),
          meta("property", "og:image:alt", "Opensteer: turn your computer into an AI computer"),
          meta("name", "twitter:card", "summary_large_image"),
        );
        return { html, tags };
      },
    },
  };
}

export default defineConfig({
  appType: "mpa",
  plugins: [siteShell()],
  build: {
    target: "es2022",
    rolldownOptions: {
      input: Object.fromEntries(
        pages.map((page) => [page, resolve(import.meta.dirname, `${page}.html`)]),
      ),
    },
  },
  server: { port: Number(process.env.PORT ?? 4174) },
});
