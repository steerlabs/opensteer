import { expect, test } from "vitest";
import { rewriteUpstreamPackage, rewriteUpstreamSource } from "@opensteer/plugin-engine-catalog";
import names from "../packages/plugin-engine/upstream-names.json" with { type: "json" };

// Every old string comes from the rules data; this file names none itself.
const rule = (scope: string, index = 0) => {
  const found = names.rules.filter((candidate) => candidate.scope === scope)[index];
  if (found === undefined) throw new Error(`No ${scope} rule`);
  return found;
};
const [bare] = names.identity.pluginCode as [string];
const pkg = rule("package");
const key = rule("manifest-key");
const table = rule("reserved-table", 3);

const manifest = `{
  "name": "${pkg.from}demo",
  "type": "module",
  "${key.from}": { "title": "Demo" },
  "dependencies": { "apps": "0.0.1-beta.140" }
}
`;
const source = () => [
  { path: "package.json", content: manifest },
  {
    path: "index.ts",
    content: [
      `// ${bare} comments and prose are not the rewriter's: they change nothing a build reads.`,
      `const route = "${rule("route-path").from}api/query";`,
      `const header = "${rule("header").from.toUpperCase()}";`,
      `const element = "${rule("element-id").from}";`,
      `const event = "${rule("event").from}";`,
      `const marker = "${rule("ui-marker").from}";`,
      `const code = "${rule("error-code").from}";`,
      `const table = "SELECT * FROM ${rule("reserved-table").from.toUpperCase()}";`,
      `const setup = { signingSecret: "${rule("signing-secret").from}" };`,
      `const label = "Task ${bare}"; const url = "https://example.invalid//${bare}";`,
    ].join("\n"),
  },
  {
    path: "migrations/0001_init.sql",
    content: `-- ${bare} comment stays\nINSERT INTO notes SELECT '${table.from}', id FROM ${table.from};\n`,
  },
  { path: "README.md", content: `${bare} discovers it.\n` },
  { path: "data.json", content: JSON.stringify({ description: bare }) },
  { path: "ui/public/logo.png", content: "iVBORw0KGgo=", encoding: "base64" as const },
];

test("rewrites plugin source within each rule's scope and nowhere else", () => {
  const original = source();
  const { files, changed, problems } = rewriteUpstreamSource(original);
  expect(changed).toBe(true);
  expect(problems).toEqual([]);
  const text = (path: string) => {
    const file = files.find((candidate) => candidate.path === path);
    if (file === undefined || !("content" in file)) throw new Error(path);
    return file.content;
  };
  // package.json is edited in place: its name's scope and the key, every other byte kept.
  expect(text("package.json")).toBe(
    manifest
      .replace(`"${pkg.from}demo"`, `"${pkg.to}demo"`)
      .replace(`"${key.from}"`, `"${key.to}"`),
  );
  expect(pkg.to).toBe("@opensteer-plugins/");
  expect(key.to).toBe("pluginEngine");
  expect(text("index.ts").split("\n")).toEqual([
    `// ${bare} comments and prose are not the rewriter's: they change nothing a build reads.`,
    `const route = "${rule("route-path").to}api/query";`,
    `const header = "${rule("header").to}";`,
    `const element = "${rule("element-id").to}";`,
    `const event = "${rule("event").to}";`,
    `const marker = "${rule("ui-marker").to}";`,
    `const code = "${rule("error-code").to}";`,
    `const table = "SELECT * FROM ${rule("reserved-table").to}";`,
    `const setup = { signingSecret: "${rule("signing-secret").to}" };`,
    `const label = "Task ${bare}"; const url = "https://example.invalid//${bare}";`,
  ]);
  // A migration's identifiers change; its comments and the data it writes do not.
  expect(text("migrations/0001_init.sql")).toBe(
    `-- ${bare} comment stays\nINSERT INTO notes SELECT '${table.from}', id FROM ${table.to};\n`,
  );
  // No rule covers prose, other JSON files or binary files: they keep their bytes.
  for (const index of [3, 4, 5]) expect(files[index]).toBe(original[index]);
});

test("rewritten source rewrites to itself", () => {
  const once = rewriteUpstreamSource(source()).files;
  const twice = rewriteUpstreamSource(once);
  expect(twice.changed).toBe(false);
  expect(twice.files).toEqual(once);
});

test("refuses a package.json that has the key under both names", () => {
  const both = JSON.stringify({ name: "demo", [key.from]: {}, [key.to]: {} });
  const { files, problems } = rewriteUpstreamSource([{ path: "package.json", content: both }]);
  expect(problems).toEqual([expect.stringContaining("package.json")]);
  expect(files).toEqual([{ path: "package.json", content: both }]);
});

test("package names change only by the scope's prefix", () => {
  expect(rewriteUpstreamPackage(`${pkg.from}gmail`)).toBe(`${pkg.to}gmail`);
  expect(rewriteUpstreamPackage("@acme/notes")).toBe("@acme/notes");
});
