import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

// TypeScript 7 takes its working directory from $PWD, which keeps a symlinked
// path such as macOS /tmp, yet resolves workspace packages through their real
// path. A test importing one module both relatively and by package name would
// then hold two copies of the same class.
it("type-checks the tests from a checkout reached through a symlink", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "typecheck-tests-")));
  roots.push(root);
  const real = path.join(root, "real");
  const alias = path.join(root, "alias");
  const write = (file: string, content: string) => {
    mkdirSync(path.dirname(path.join(real, file)), { recursive: true });
    writeFileSync(path.join(real, file), content);
  };
  write(
    "pkg/package.json",
    JSON.stringify({ name: "dep", type: "module", exports: "./src/value.ts" }),
  );
  write(
    "pkg/src/value.ts",
    "export class Value {\n  #secret = 1;\n  read() {\n    return this.#secret;\n  }\n}\n",
  );
  write(
    "tests/use.ts",
    'import { Value as Relative } from "../pkg/src/value.js";\nimport { Value as Named } from "dep";\n\nexport const value: Named = new Relative();\n',
  );
  write(
    "tsconfig.tests.json",
    JSON.stringify({
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        noEmit: true,
        strict: true,
        types: [],
      },
      include: ["tests/**/*.ts"],
    }),
  );
  mkdirSync(path.join(real, "node_modules"));
  symlinkSync("../pkg", path.join(real, "node_modules", "dep"));
  symlinkSync(real, alias);

  const script = (
    JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }
  ).scripts["typecheck:tests"]!;
  const result = spawnSync("sh", ["-c", script], {
    cwd: alias,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${path.resolve("node_modules/.bin")}${path.delimiter}${process.env.PATH ?? ""}`,
      PWD: alias,
    },
  });

  expect(result.stdout + result.stderr).toBe("");
  expect(result.status).toBe(0);
});
