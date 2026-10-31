import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

/**
 * A custom property that resolves to nothing makes its whole declaration
 * invalid, so a mistyped or deleted token silently drops a background, a rim
 * or a size. Every `var()` without a fallback must name a property that some
 * stylesheet declares or that the components set at runtime (`style` objects
 * and `setProperty`). Where a declaration applies is a question of the DOM,
 * which this cannot see; it catches the names that exist nowhere.
 */
test("web CSS only references custom properties that exist", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const sources = readdirSync(root, { recursive: true, encoding: "utf8" }).map((file) => ({
    path: relative(root, join(root, file)),
    text:
      file.endsWith(".css") || /\.tsx?$/.test(file) ? readFileSync(join(root, file), "utf8") : "",
  }));
  const stylesheets = sources
    .filter(({ path }) => path.endsWith(".css"))
    .map(({ path, text }) => ({ path, css: text.replace(/\/\*[\s\S]*?\*\//g, "") }));

  const declared = new Set([
    ...stylesheets.flatMap(({ css }) => [...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1])),
    ...sources
      .filter(({ path }) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path))
      .flatMap(({ text }) => [...text.matchAll(/["'`](--[\w-]+)["'`]/g)].map((m) => m[1])),
  ]);

  const missing = stylesheets.flatMap(({ path, css }) =>
    [...css.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)]
      .filter(([, name, fallback]) => fallback === undefined && !declared.has(name))
      .map(([, name]) => `${path}: ${name}`),
  );

  expect([...new Set(missing)].sort()).toEqual([]);
});
