import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve, join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  packageScope,
  renames,
  databaseDirectory,
  compatibility,
  noticeHeading,
} from "./renames.mjs";
import { checkNames } from "./names.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const upstream = resolve(
  process.argv[2] ??
    (() => {
      throw new Error("Usage: node scripts/plugin-engine/import.mjs <upstream-checkout>");
    })(),
);
const target = join(root, "vendor/plugin-engine");
const seeds = ["sdk", "apps", "mcp", "catalog", "app-templates", "app-source", "authorization"];
const manifests = new Map();
for (const dir of await readdir(join(upstream, "packages"))) {
  const manifest = JSON.parse(
    await readFile(join(upstream, "packages", dir, "package.json"), "utf8"),
  );
  manifests.set(manifest.name, { dir, manifest });
}
const closure = new Set();
function visit(dir) {
  if (closure.has(dir)) return;
  closure.add(dir);
  if (dir === "telemetry") return;
  const entry = [...manifests.values()].find((entry) => entry.dir === dir);
  if (!entry) throw new Error(`Missing package: ${dir}`);
  for (const name of Object.keys(entry.manifest.dependencies ?? {})) {
    if (name.startsWith(packageScope) || name === databaseDirectory) {
      const dependency = manifests.get(name);
      if (!dependency) throw new Error(`Unresolved workspace dependency: ${name}`);
      visit(dependency.dir);
    }
  }
}
seeds.forEach(visit);
const excluded = new Set([
  "ui",
  "dashboard-start",
  "devtools",
  "app-registry",
  "mcp-auth",
  "app-management",
]);
for (const dir of closure)
  if (excluded.has(dir)) throw new Error(`Unexpected product dependency: ${dir}`);
const rename = (value) => renames.reduce((value, [from, to]) => value.replaceAll(from, to), value);
const directoryName = (dir) => (dir === databaseDirectory ? "database" : dir);
await mkdir(target, { recursive: true });
// Remove only generated source; installed dependencies and build outputs remain caller-owned.
for (const entry of await readdir(target, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  for (const name of await readdir(join(target, entry.name))) {
    if (name !== "node_modules" && name !== "dist")
      await rm(join(target, entry.name, name), { recursive: true, force: true });
  }
}
for (const dir of closure) {
  if (dir === "telemetry") {
    const dest = join(target, "telemetry/src");
    await mkdir(dest, { recursive: true });
    for (const file of [
      "context",
      "ownership",
      "pending-span",
      "failed-span",
      "recorded-failure",
      "schema-issue",
      "request-rejection",
      "trace-context",
    ]) {
      await writeFile(
        join(dest, file + ".ts"),
        rename(await readFile(join(upstream, "packages/telemetry/src", file + ".ts"), "utf8")),
      );
    }
    continue;
  }
  const from = join(upstream, "packages", dir),
    dest = join(target, directoryName(dir));
  const used = new Map();
  async function copy(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name),
        local = relative(from, file);
      if (
        ["node_modules", "dist", ".git"].includes(entry.name) ||
        /^(README|CHANGELOG|LICENSE)/.test(entry.name)
      )
        continue;
      if (dir !== "apps" && local.startsWith("scripts")) continue;
      if (
        dir === "apps" &&
        local.startsWith("scripts") &&
        !["scripts", "scripts/build.mjs", "scripts/reference.mjs"].includes(local)
      )
        continue;
      if (entry.isDirectory()) {
        await copy(file);
        continue;
      }
      const out = join(dest, rename(local));
      let source = await readFile(file, "utf8");
      if (local === "package.json" || local === "tsconfig.json") continue;
      if (local === "src/implementation/browser-scripts.gen.ts") {
        const keys = [
          "contextElement",
          "accountNoticeElement",
          "deploymentEvent",
          "versionPath",
          "assetsPath",
          "browserTracePath",
        ];
        source = source
          .split("\n")
          .map((line) => {
            if (!line.startsWith("export const ")) return line;
            let result = line;
            const replacements = [];
            for (const key of keys) {
              const value = compatibility.apps[key];
              if (!result.includes(value)) continue;
              const token = "OPENSTEER_PUBLISHED_" + key;
              result = result.replaceAll(value, token);
              replacements.push(`.replaceAll(${JSON.stringify(token)}, __published.${key})`);
            }
            if (replacements.length) {
              used.set(out, true);
              result = result.slice(0, -1) + replacements.join("") + ";";
            }
            return result;
          })
          .join("\n");
      }
      const htmlFields = {
        contextElement: compatibility.apps.contextElement,
        accountNoticeElement: compatibility.apps.accountNoticeElement,
      };
      for (const [key, value] of Object.entries(htmlFields)) {
        if (source.includes(`id="${value}"`)) {
          source = source.replaceAll(`id="${value}"`, 'id="${__published.' + key + '}"');
          used.set(out, true);
        }
      }
      const assetTemplate = "`" + compatibility.apps.assetsPath;
      if (source.includes(assetTemplate)) {
        source = source.replaceAll(assetTemplate, "`" + "${__published.assetsPath}");
        used.set(out, true);
      }
      const internalRoute = `/^\\/(?:${compatibility.apps.internalSegment}|dashboard|auth|v1|mcp)(?:\\/|$)/`;
      if (source.includes(internalRoute)) {
        source = source.replaceAll(
          internalRoute,
          'new RegExp("^/(?:" + __published.internalSegment + "|dashboard|auth|v1|mcp)(?:/|$)")',
        );
        used.set(out, true);
      }
      if (/\.[cm]?[jt]sx?$/.test(local)) {
        const values =
          dir === "catalog"
            ? compatibility.catalog
            : { ...compatibility.apps, ...compatibility.sdk };
        for (const [key, value] of Object.entries(values)) {
          if (
            key === "signingSecretSource" &&
            ![
              "src/contracts/webhook-protocol.ts",
              "src/contracts/webhook-setup.ts",
              "src/implementation/webhooks.ts",
            ].includes(local)
          )
            continue;
          for (const quote of ['"', "'"]) {
            if (!source.includes(quote + value + quote)) continue;
            source = source.replaceAll(quote + value + quote, `__published.${key}`);
            used.set(out, true);
          }
        }
      }
      source = rename(source);
      if (used.has(out)) {
        const module = dir === "apps" ? "./published-compat.ts" : "apps/published-compat";
        const specifier =
          dir === "apps"
            ? relative(dirname(out), join(dest, "src/published-compat.ts")).replaceAll("\\", "/")
            : module;
        source =
          `import * as __published from ${JSON.stringify(specifier.startsWith(".") || dir !== "apps" ? specifier : "./" + specifier)};\n` +
          source;
      }
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, source);
    }
  }
  await copy(from);
  const original = JSON.parse(await readFile(join(from, "package.json"), "utf8"));
  const manifest = JSON.parse(rename(JSON.stringify(original)));
  delete manifest.author;
  delete manifest.repository;
  delete manifest.homepage;
  delete manifest.bugs;
  delete manifest.keywords;
  manifest.name = dir === databaseDirectory ? "@opensteer/plugin-engine-database" : manifest.name;
  manifest.scripts = {
    typecheck: "tsc --noEmit -p tsconfig.json",
    build:
      dir === "apps" ? "node scripts/build.mjs" : "node ../../../scripts/plugin-engine/build.mjs",
  };
  manifest.devDependencies = {
    ...manifest.devDependencies,
    typescript: "catalog:",
    "@types/node": "catalog:",
  };
  // PostgreSQL is the Node embedding adapter; alternative SQL backends are optional source entry points.
  if (dir === databaseDirectory) {
    for (const name of ["@effect/sql-mssql", "@effect/sql-mysql2", "@effect/sql-sqlite-node"])
      delete manifest.devDependencies[name];
  }
  if (dir === "sdk") manifest.dependencies["@effect/sql-pg"] = "4.1.4";
  if (dir === "apps") {
    manifest.exports["./published-compat"] = "./src/published-compat.ts";
    manifest.devDependencies["react-dom"] = "catalog:";
    manifest.devDependencies["@types/react-dom"] = "19.3.0";
  }
  await writeFile(join(dest, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(
    join(dest, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          lib: ["ES2023", "DOM"],
          types: ["node"],
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          noFallthroughCasesInSwitch: true,
          verbatimModuleSyntax: true,
          allowImportingTsExtensions: true,
          noEmit: true,
          skipLibCheck: true,
          jsx: "react-jsx",
          resolveJsonModule: true,
        },
        include: ["src/**/*.ts", "src/**/*.tsx"],
        exclude: ["**/node_modules", "dist"],
      },
      null,
      2,
    ) + "\n",
  );
}
await writeFile(
  join(target, "apps/src/published-compat.ts"),
  "// Published framework protocol and reserved route literals.\n" +
    Object.entries({ ...compatibility.apps, ...compatibility.sdk })
      .map(([key, value]) => `export const ${key} = ${JSON.stringify(value)};`)
      .join("\n") +
    "\n",
);
await mkdir(join(target, "catalog/src"), { recursive: true });
await writeFile(
  join(target, "catalog/src/published-compat.ts"),
  `// Public catalog feed location.\nexport const feed = ${JSON.stringify(compatibility.catalog.feed)};\n`,
);
// The feed belongs to the catalog package; protocol literals belong to the framework.
const catalogFile = join(target, "catalog/src/contracts/catalog.ts");
await writeFile(
  catalogFile,
  (await readFile(catalogFile, "utf8")).replace(
    '"apps/published-compat"',
    '"../published-compat.ts"',
  ),
);
const example = join(upstream, "playground/demo-apps/live-inbox");
for (const file of await readdir(example, { recursive: true, withFileTypes: true })) {
  if (!file.isFile()) continue;
  const source = join(file.parentPath, file.name);
  const out = join(target, "apps/reference-example", relative(example, source));
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, rename(await readFile(source, "utf8")));
}
await cp(join(root, "scripts/plugin-engine/overlay"), target, { recursive: true });
for (const patch of (await readdir(join(root, "scripts/plugin-engine/patches")))
  .filter((file) => file.endsWith(".patch"))
  .sort()) {
  execFileSync(
    "git",
    [
      "apply",
      "--directory=vendor/plugin-engine",
      join(root, "scripts/plugin-engine/patches", patch),
    ],
    { cwd: root, stdio: "inherit" },
  );
}
const upstreamManifest = JSON.parse(await readFile(join(upstream, "package.json"), "utf8"));
const patchNames = [
  "effect@4.1.4",
  "@opencode-ai/codemode@0.0.0-dev-19272",
  "@alchemy.run/cloudflare-runtime@2.0.0-beta.80",
  "@cloudflare/worker-bundler@0.2.4",
  "@cfworker/json-schema@4.1.1",
  "@swagger-api/apidom-ns-openapi-3-1@1.11.6",
  "tailwindcss-iso@1.0.7",
];
for (const name of patchNames) {
  const source = await readFile(join(upstream, upstreamManifest.patchedDependencies[name]), "utf8");
  const parts = source
    .split(/(?=^diff --git )/m)
    .filter(
      (part) =>
        !/diff --git a\/(?:dist|src)\/(observability|reactivity)\//.test(part) &&
        !/diff --git a\/(?:dist|src)\/sql\/Statement\./.test(part) &&
        !part.startsWith("diff --git a/src/rolldown/test/"),
    );
  // Hunk labels are informational. Keep original removed/context lines so patches still apply.
  const renamed = parts
    .join("")
    .split("\n")
    .map((line) =>
      line.startsWith("+")
        ? rename(line)
        : line.startsWith("@@")
          ? line.replace(/(@@.*?@@).*/, "$1")
          : line,
    )
    .join("\n");
  await writeFile(
    join(root, "patches", "plugin-engine-" + name.replaceAll("/", "__") + ".patch"),
    renamed,
  );
}
const snapshot = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: upstream,
  encoding: "utf8",
}).trim();
let notices = await readFile(join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
const duplicate = notices.indexOf("\n## Plugin engine\n");
if (duplicate !== -1) notices = notices.slice(0, duplicate);
const at = notices.indexOf(noticeHeading + "\n");
if (at === -1) throw new Error("Missing third-party attribution section");
const next = notices.indexOf("\n## ", at + noticeHeading.length);
const end = next === -1 ? notices.length : next;
let section = notices.slice(at, end);
section = section.replace(/\nThe vendored source in `vendor\/plugin-engine`[^\n]*\n/g, "\n");
const licenseAt = section.indexOf("MIT License");
if (licenseAt === -1) throw new Error("Missing third-party license");
section =
  section.slice(0, licenseAt).trimEnd() +
  "\n\nThe vendored source in `vendor/plugin-engine` is imported from snapshot `" +
  snapshot +
  "`.\n\n" +
  (await readFile(join(upstream, "LICENSE"), "utf8"));
await writeFile(
  join(root, "THIRD_PARTY_NOTICES.md"),
  notices.slice(0, at) + section.trimEnd() + "\n" + notices.slice(end),
);
await checkNames(root);
console.log("Imported packages: " + [...closure].map(directoryName).sort().join(", "));
