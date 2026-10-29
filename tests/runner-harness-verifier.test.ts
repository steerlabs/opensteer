import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { runnerExternals } from "../scripts/runner-build-options.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const entry = fileURLToPath(
  new URL("../apps/runner/src/verify-harness-runtimes-main.ts", import.meta.url),
);
let bundleRoot: string;
let bundle: string;
beforeAll(async () => {
  bundleRoot = await realpath(await mkdtemp(join(tmpdir(), "runner-verifier-bundle-")));
  bundle = join(bundleRoot, "verify-harness-runtimes-main.mjs");
  await symlink(
    fileURLToPath(new URL("../apps/runner/node_modules", import.meta.url)),
    join(bundleRoot, "node_modules"),
    "junction",
  );
  await build({
    entryPoints: [entry],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
    external: [...runnerExternals],
    // These cases exercise CLI control flow and real Claude inspection. Other
    // engines have their own executable qualification; do not start them four
    // times just to check the Claude flag. Assert this call still happens.
    plugins: [
      {
        name: "shipped-version-probe-fixture",
        setup(builder) {
          builder.onResolve({ filter: /\/verify-harness-runtimes\.js$/ }, () => ({
            path: "shipped-version-probe",
            namespace: "fixture",
          }));
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: `import { writeFileSync } from "node:fs";
export async function harnessRuntimeVersionMismatches() {
  writeFileSync(process.env.OPENSTEER_TEST_SHIPPED_VERSION_PROBE, "called");
  return [];
}`,
          }));
        },
      },
    ],
    banner: {
      js: "import{createRequire as __opensteerCreateRequire}from'node:module';const require=__opensteerCreateRequire(import.meta.url);",
    },
  });
});
afterAll(async () => {
  if (bundleRoot) await rm(bundleRoot, { recursive: true, force: true });
});
const roots: string[] = [];
const children = new Set<ChildProcess>();
afterEach(async () => {
  await Promise.all(
    [...children].map(
      (child) =>
        new Promise<void>((resolve, reject) => {
          child.once("close", () => resolve());
          try {
            if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
              reject(error);
          }
        }),
    ),
  );
  children.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(version?: string) {
  const root = await mkdtemp(join(tmpdir(), "runner-claude-verifier-"));
  roots.push(root);
  const executable = join(root, "claude.js");
  if (version)
    await writeFile(executable, `console.log(${JSON.stringify(`${version} (Claude Code)`)});`);
  return { root, executable };
}
async function verify(root: string, executable: string | undefined, required: boolean) {
  const environment: NodeJS.ProcessEnv = { ...process.env, PATH: root };
  delete environment.OPENSTEER_CLAUDE_EXECUTABLE;
  if (executable) environment.OPENSTEER_CLAUDE_EXECUTABLE = executable;
  environment.OPENSTEER_TEST_SHIPPED_VERSION_PROBE = join(root, "shipped-version-probe");
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      [bundle, ...(required ? ["--require-installed-claude"] : [])],
      {
        env: environment,
        timeout: 30_000,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      stderr += error.message;
    });
    child.on("close", (code) => {
      children.delete(child);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    children.add(child);
  });
  expect(await readFile(environment.OPENSTEER_TEST_SHIPPED_VERSION_PROBE, "utf8")).toBe("called");
  return result;
}
describe("shipped Runner verifier CLI", () => {
  it("requires installed Claude and reports the Runner-resolved executable/version as JSON", async () => {
    const { root, executable } = await fixture("2.1.295");
    const result = await verify(root, executable, true);
    expect(result, result.stderr).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual({
      status: "available",
      executable,
      version: "2.1.295",
    });
  });
  it("fails when required Claude is missing", async () => {
    const { root } = await fixture();
    const result = await verify(root, undefined, true);
    expect(result.code, result.stderr).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "unavailable" });
  });
  it("fails when required Claude has an unsupported version", async () => {
    const { root, executable } = await fixture("1.0.0");
    const result = await verify(root, executable, true);
    expect(result.code, result.stderr).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "unsupported" });
  });
  it("keeps public qualification successful and silent when optional Claude is absent", async () => {
    const { root } = await fixture();
    const result = await verify(root, undefined, false);
    expect(result, result.stderr).toEqual({ code: 0, stdout: "", stderr: "" });
  });
});
