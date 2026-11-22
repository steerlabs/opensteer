import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { describe, expect, test } from "vitest";

const web = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

/** index.css with its `@import`s in place, as the build links it. */
function inlined(path: string): string {
  return readFileSync(web(path), "utf8").replace(/@import\s+"\.\/([\w-]+\.css)";/g, (_, file) =>
    inlined(`src/styles/${file}`),
  );
}

// As on a Mac whose settings allow transparency, where tokens.css turns glass on.
const shared = inlined("src/styles/index.css").replaceAll(
  "(prefers-reduced-transparency: no-preference)",
  "all",
);

/**
 * The desktop shows these documents in transparent windows over the page a
 * person watches; an opaque ground there hides the page. The build decides the
 * order of their stylesheets: Vite links a shared chunk holding only CSS after
 * an entry's own stylesheet (the menu-bar entry made `styles` such a chunk).
 * So each document must stay transparent with its own sheet on either side.
 */
const documents = [
  { html: "glass.html", own: "src/styles/glass.css" },
  { html: "autofill.html", own: "src/styles/autofill-popup.css" },
] as const;

function render(html: string, sheets: readonly string[]) {
  const window = new Window();
  const root = /<html[^>]*>/.exec(readFileSync(web(html), "utf8"))![0];
  window.document.write(
    `<!doctype html>${root}<head>${sheets.map((css) => `<style>${css}</style>`).join("")}</head><body><div id="root"></div></body></html>`,
  );
  return window;
}

describe("transparent desktop documents", () => {
  for (const { html, own } of documents)
    for (const order of ["own sheet first", "own sheet last"] as const)
      test(`${html} paints no ground with its ${order}`, async () => {
        const css = readFileSync(web(own), "utf8");
        const window = render(html, order === "own sheet first" ? [css, shared] : [shared, css]);
        const { document } = window;
        for (const element of [
          document.documentElement,
          document.body,
          document.getElementById("root")!,
        ]) {
          const style = window.getComputedStyle(element);
          expect(style.backgroundImage, element.tagName).toMatch(/^(none|initial)$/);
          expect(style.backgroundColor, element.tagName).toBe("transparent");
        }
        if (html === "autofill.html") {
          const root = window.getComputedStyle(document.documentElement);
          // An empty transparent window gives a blur nothing to blur.
          expect(root.getPropertyValue("--blur-glass").trim()).toBe("none");
          expect(root.getPropertyValue("--fill-glass").trim()).toBe(
            root.getPropertyValue("--fill-float").trim(),
          );
        }
        await window.happyDOM.close();
      });
});
