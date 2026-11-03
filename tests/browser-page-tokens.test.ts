import { readFileSync } from "node:fs";
import path from "node:path";
import { renderBrowserPage } from "@opensteer/shared/browserPage";
import { expect, it } from "vitest";

/**
 * Server-rendered pages cannot load the app's stylesheet, so they restate its
 * palette and materials. Every token both declare must say the same thing, or
 * the front doors drift from the app they lead into.
 */
const deliberatelyDifferent: Readonly<Record<string, string>> = {
  // Pages a Host renders carry no bundled fonts, so their fallbacks lead with
  // each platform's own UI faces.
  "--font-display": "fallback stack",
  "--font-sans": "fallback stack",
};

it("restates the app's design tokens exactly", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const app = firstDeclarations(
    readFileSync(path.join(root, "apps/web/src/styles/tokens.css"), "utf8"),
  );
  const page = renderBrowserPage({ body: "", layout: "card", title: "t" });
  const shell = firstDeclarations(page.match(/<style>([\s\S]*)<\/style>/u)?.[1] ?? "");
  const shared = [...shell.keys()].filter(
    (name) => app.has(name) && !(name in deliberatelyDifferent),
  );
  expect(shared.length).toBeGreaterThan(20);
  const drifted = shared
    .filter((name) => app.get(name) !== shell.get(name))
    .map((name) => `${name}: app ${app.get(name)} / page ${shell.get(name)}`);
  expect(drifted).toEqual([]);
});

/** Each custom property's first declaration, whitespace removed. */
function firstDeclarations(css: string): Map<string, string> {
  const declarations = new Map<string, string>();
  const body = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)[;}]/gu)) {
    const [, name, value] = match;
    if (name && value && !declarations.has(name)) {
      declarations.set(name, value.replace(/\s+/gu, ""));
    }
  }
  return declarations;
}
