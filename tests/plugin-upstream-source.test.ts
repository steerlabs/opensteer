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
const prose = rule("readme-prose", 1);

const source = () => [
  {
    path: "package.json",
    content:
      JSON.stringify(
        {
          name: `${rule("manifest-name").from}demo`,
          [rule("manifest-key").from]: { title: "Demo" },
          dependencies: { apps: "0.0.1-beta.140" },
        },
        null,
        2,
      ) + "\n",
  },
  {
    path: "index.ts",
    content: [
      `// ${prose.from} reads this file; "${bare}" in a comment is a name.`,
      `/* ${bare} */`,
      `const route = "${rule("route-path").from}api/query";`,
      `const header = "${rule("header").from.toUpperCase()}";`,
      `const element = "${rule("element-id").from}";`,
      `const event = "${rule("event").from}";`,
      `const marker = "${rule("ui-marker").from}";`,
      `const code = "${rule("error-code").from}";`,
      `const table = "SELECT * FROM ${rule("reserved-table").from}";`,
      `const setup = { signingSecret: "${rule("signing-secret").from}" };`,
      // Outside every scope: an ordinary string with the word, and a URL that is not a comment.
      `const label = "Task ${bare}"; const url = "https://example.invalid//${bare}";`,
    ].join("\n"),
  },
  {
    path: "migrations/0001_init.sql",
    content: `-- ${bare} comment stays: only reserved tables change here\nINSERT INTO notes SELECT * FROM ${rule("reserved-table", 3).from};\n`,
  },
  { path: "README.md", content: `${prose.from} discovers it. Set ${rule("readme-prose").from}.\n` },
  { path: "data.json", content: JSON.stringify({ description: `${prose.from}` }) },
  { path: "ui/public/logo.png", content: "iVBORw0KGgo=", encoding: "base64" as const },
];

test("rewrites plugin source within each rule's scope and nowhere else", () => {
  const original = source();
  const { files, changed } = rewriteUpstreamSource(original);
  expect(changed).toBe(true);
  const text = (path: string) => {
    const file = files.find((candidate) => candidate.path === path);
    if (file === undefined || !("content" in file)) throw new Error(path);
    return file.content;
  };
  expect(JSON.parse(text("package.json"))).toEqual({
    name: `${rule("manifest-name").to}demo`,
    [rule("manifest-key").to]: { title: "Demo" },
    dependencies: { apps: "0.0.1-beta.140" },
  });
  expect(text("index.ts").split("\n")).toEqual([
    `// ${rule("code-comment").to} reads this file; "${rule("code-comment", 1).to}" in a comment is a name.`,
    `/* ${rule("code-comment", 1).to} */`,
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
  expect(text("migrations/0001_init.sql")).toBe(
    `-- ${bare} comment stays: only reserved tables change here\nINSERT INTO notes SELECT * FROM ${rule("reserved-table", 3).to};\n`,
  );
  expect(text("README.md")).toBe(`${prose.to} discovers it. Set ${rule("readme-prose").to}.\n`);
  // No rule covers other JSON files or binary files: they keep their bytes.
  expect(files[4]).toBe(original[4]);
  expect(files[5]).toBe(original[5]);
});

test("rewritten source rewrites to itself", () => {
  const once = rewriteUpstreamSource(source()).files;
  const twice = rewriteUpstreamSource(once);
  expect(twice.changed).toBe(false);
  expect(twice.files).toEqual(once);
});

test("package names change only by their scope's prefix", () => {
  const from = rule("index-package").from;
  expect(rewriteUpstreamPackage("index-package", `${from}gmail`)).toBe(
    `${rule("index-package").to}gmail`,
  );
  expect(rewriteUpstreamPackage("document-package", "@acme/notes")).toBe("@acme/notes");
});
