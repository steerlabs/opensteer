import { build } from "esbuild";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  integrationBundleEntry,
  prepareIntegrationBundle,
  type IntegrationBundleKind,
} from "../scripts/integration-runner-build.js";

// Failures: missing/malformed evidence; changed transitive or resolution inputs;
// missing/changed entry or shared chunk; edits during preparation; a failed
// rebuild leaving an earlier receipt usable. No database or process journey.
describe("integration Runner build freshness", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture(kind: IntegrationBundleKind = "recovery") {
    const root = await mkdtemp(join(tmpdir(), "opensteer-integration-bundle-"));
    roots.push(root);
    const app = join(root, "apps", kind === "recovery" ? "runner" : "desktop");
    const out = join(app, kind === "recovery" ? "dist-integration" : "dist");
    const entry =
      kind === "recovery"
        ? "src/test-fixtures/recovery-runner.test-support.ts"
        : "src/runner-worker.ts";
    const files: Record<string, string> = {
      "package.json": '{"type":"module"}\n',
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "pnpm-workspace.yaml": "packages: [apps/*, packages/*]\n",
      "tsconfig.base.json": '{"compilerOptions":{"target":"ES2024"}}\n',
      "scripts/tsup-node-app.ts": "export const nodeApp = (value: object) => value;\n",
      "scripts/runner-build-options.ts": "export const runnerExternals = [];\n",
      "packages/fixture/package.json": '{"name":"fixture","type":"module"}\n',
      "packages/fixture/src/dependency.ts": 'export { value } from "./transitive.js";\n',
      "packages/fixture/src/transitive.ts": 'export { value } from "dual-entry";\n',
      "node_modules/dual-entry/package.json":
        '{"type":"module","main":"main.cjs","module":"module.js"}\n',
      "node_modules/dual-entry/main.cjs": "exports.value = 41;\n",
      "node_modules/dual-entry/module.js": "export const value = 42;\n",
    };
    for (const [file, contents] of Object.entries(files)) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), contents);
    }
    await mkdir(dirname(join(app, entry)), { recursive: true });
    await writeFile(join(app, "package.json"), '{"type":"module"}\n');
    await writeFile(
      join(app, "tsconfig.json"),
      JSON.stringify({
        extends: "../../tsconfig.base.json",
        compilerOptions: {
          baseUrl: ".",
          paths: { "@fixture/*": ["../../packages/fixture/src/*"] },
        },
      }),
    );
    await writeFile(join(app, "tsup.config.ts"), "export default {};\n");
    if (kind === "recovery")
      await writeFile(join(app, "tsup.integration.config.ts"), "export default {};\n");
    await writeFile(
      join(app, entry),
      'import { value } from "@fixture/dependency"; console.log(value);\n',
    );
    if (kind === "desktop")
      await writeFile(
        join(app, "src/main.ts"),
        'import { value } from "@fixture/dependency"; console.log(value + 1);\n',
      );
    const compile = async () => {
      await mkdir(out, { recursive: true });
      const result = await build({
        absWorkingDir: app,
        entryPoints: kind === "desktop" ? ["src/main.ts", entry] : [entry],
        bundle: true,
        format: "esm",
        platform: "node",
        mainFields: ["module", "main"],
        splitting: true,
        outdir: out,
        metafile: true,
        logLevel: "silent",
      });
      await writeFile(join(out, "metafile-esm.json"), JSON.stringify(result.metafile));
    };
    const certify = async () => {
      const pending = await prepareIntegrationBundle(root, kind);
      await compile();
      await pending.publish();
    };
    return {
      root,
      app,
      out,
      compile,
      certify,
      kind,
      manifest: join(out, "integration-build.json"),
    };
  }

  it.each(["recovery", "desktop"] as const)(
    "accepts only the actual %s entry and its build",
    async (kind) => {
      const f = await fixture(kind);
      await f.certify();
      const entry = await integrationBundleEntry(f.root, kind);
      expect(relative(f.out, entry)).toBe(
        kind === "recovery" ? "recovery-runner.test-support.js" : "runner-worker.js",
      );
    },
  );

  it.each(["missing", "malformed"])(
    "refuses a %s manifest with the exact rebuild command",
    async (failure) => {
      const f = await fixture();
      if (failure === "malformed") {
        await mkdir(f.out, { recursive: true });
        await writeFile(f.manifest, '{"version":999}');
      }
      await expect(integrationBundleEntry(f.root, f.kind)).rejects.toThrow(
        "pnpm test:integration apps/host/src/agents/runner-readiness.integration.test.ts",
      );
    },
  );

  it.each([
    "packages/fixture/src/transitive.ts",
    "packages/fixture/package.json",
    "apps/runner/tsconfig.json",
    "apps/runner/tsup.integration.config.ts",
    "scripts/tsup-node-app.ts",
    "pnpm-lock.yaml",
    "apps/runner/dist-integration/recovery-runner.test-support.js",
  ])("refuses changed build input/output %s", async (file) => {
    const f = await fixture();
    await f.certify();
    await writeFile(join(f.root, file), (await readFile(join(f.root, file), "utf8")) + "\n");
    await expect(integrationBundleEntry(f.root, f.kind)).rejects.toThrow(
      /stale.*pnpm test:integration/su,
    );
  });

  it.each(["missing", "changed"])(
    "validates the dynamically imported worker's %s shared chunk",
    async (failure) => {
      const f = await fixture("desktop");
      await f.certify();
      const metadata: { outputs: Record<string, object> } = JSON.parse(
        await readFile(join(f.out, "metafile-esm.json"), "utf8"),
      );
      const chunk = Object.keys(metadata.outputs).find((file) => /chunk-.*\.js$/u.test(file));
      expect(chunk).toBeDefined();
      if (failure === "missing") await rm(join(f.app, chunk!));
      else await writeFile(join(f.app, chunk!), "changed\n");
      await expect(integrationBundleEntry(f.root, f.kind)).rejects.toThrow(
        /pnpm test:integration/u,
      );
    },
  );

  it("rejects an input edit during preparation and publishes no manifest", async () => {
    const f = await fixture();
    const pending = await prepareIntegrationBundle(f.root, f.kind);
    await writeFile(
      join(f.root, "packages/fixture/src/transitive.ts"),
      "export const value = 43;\n",
    );
    await f.compile();
    await expect(pending.publish()).rejects.toThrow(/changed.*build.*pnpm test:integration/su);
    await expect(readFile(f.manifest)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("invalidates earlier evidence before a rebuild can fail or be canceled", async () => {
    const f = await fixture();
    await f.certify();
    await prepareIntegrationBundle(f.root, f.kind);
    await expect(integrationBundleEntry(f.root, f.kind)).rejects.toThrow(/pnpm test:integration/u);
  });
});
