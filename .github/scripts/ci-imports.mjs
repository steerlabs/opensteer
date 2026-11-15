import { dirname, join, normalize } from "node:path";
// Static import edges between tracked files, dependency-free so `changes` can run before
// install. Relative specifiers resolve to files; bare ones are kept as package names for
// the caller to match against workspace names.
const code = /\.[cm]?[jt]sx?$/;
const specifier =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bvi\.mock\s*\(\s*)["']([^"'\n]+)["']/g;
// Vitest configs name setup files, runners and reporters as plain "./" strings.
const configString = /["'](\.\/[^"'\n]+\.[cm]?[jt]sx?)["']/g;
const candidates = (path) => {
  const stem = path.replace(/\.[cm]?jsx?$/, "");
  return [
    path,
    `${stem}.ts`,
    `${stem}.tsx`,
    `${stem}.mts`,
    `${stem}.cts`,
    `${path}.ts`,
    `${path}.tsx`,
    `${path}.js`,
    `${path}.mjs`,
    join(path, "index.ts"),
    join(path, "index.tsx"),
    join(path, "index.js"),
  ];
};
export function importEdges(files, read) {
  const tracked = new Set(files);
  const edges = { files: new Map(), packages: new Map() };
  for (const file of files) {
    if (!code.test(file)) continue;
    const text = read(file);
    if (text === undefined) continue;
    const targets = new Set();
    const packages = new Set();
    const found = [...text.matchAll(specifier)].map((m) => m[1]);
    if (/(?:^|\/)vitest[^/]*\.config\.[cm]?[jt]s$/.test(file))
      found.push(...[...text.matchAll(configString)].map((m) => m[1]));
    for (const name of found) {
      if (name.startsWith(".")) {
        const base = normalize(join(dirname(file), name));
        const hit = candidates(base).find((candidate) => tracked.has(candidate));
        if (hit && hit !== file) targets.add(hit);
      } else {
        const parts = name.split("/");
        packages.add(name.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]);
      }
    }
    edges.files.set(file, [...targets]);
    edges.packages.set(file, [...packages]);
  }
  return edges;
}
/** Every file `roots` reach through relative imports, roots included. */
export function importClosure(roots, files) {
  const seen = new Set();
  const pending = [...roots];
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    pending.push(...(files.get(file) ?? []));
  }
  return seen;
}
/** Every file that reaches `file` through relative imports, excluding itself. */
export function importers(file, reverse) {
  const seen = importClosure([file], reverse);
  seen.delete(file);
  return seen;
}
export function reverseEdges(files) {
  const reverse = new Map();
  for (const [from, targets] of files)
    for (const to of targets) reverse.set(to, [...(reverse.get(to) ?? []), from]);
  return reverse;
}
