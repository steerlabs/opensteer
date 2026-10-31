import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("web CSS only references defined custom properties", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const files = readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".css"))
    .map((file) => ({
      path: relative(root, join(root, file)),
      css: readFileSync(join(root, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""),
    }));
  const defined = new Set(
    files.flatMap(({ css }) => [...css.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1])),
  );
  const missing = files.flatMap(({ path, css }) =>
    [...css.matchAll(/var\(\s*(--[\w-]+)/g)]
      .filter((match) => !defined.has(match[1]))
      .map((match) => `${path}: ${match[1]}`),
  );

  expect([...new Set(missing)].sort()).toEqual([]);
});
