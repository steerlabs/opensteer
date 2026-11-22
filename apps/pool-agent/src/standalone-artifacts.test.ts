/**
 * E1: Every single-file artifact `enroll-host.sh` delivers onto a pool host (`egress-main.js`,
 * `main.js`, `relay.mjs`) must be completely self-contained: built fresh from current source into
 * a temporary output directory (never reading or writing the checkout's `dist`), then copied alone
 * into an empty directory outside the repository (no sibling chunks, no `node_modules`), bare
 * `node` must load and start it without `ERR_MODULE_NOT_FOUND`.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort } from "@opensteer/shared/test-support/loopbackPort";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const browserRuntimeDir = join(repoRoot, "apps/browser-runtime");
const poolAgentDir = join(repoRoot, "apps/pool-agent");

const dirs: string[] = [];
const children: ChildProcess[] = [];
let buildRoot = "";
let egressArtifact = "";
let agentArtifact = "";
let relayArtifact = "";

function isolatedDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function waitForOutput(
  child: ChildProcess,
  predicate: (stdout: string, stderr: string) => boolean,
  timeoutMs = 10_000,
): Promise<{ readonly stdout: string; readonly stderr: string; readonly code: number | null }> {
  return new Promise((resolveWait, rejectWait) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (code: number | null, error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) rejectWait(error);
      else resolveWait({ stdout, stderr, code });
    };
    const check = () => {
      if (predicate(stdout, stderr)) finish(null);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      check();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      check();
    });
    child.once("error", (error) => finish(null, error));
    child.once("exit", (code) => finish(code));
    const timer = setTimeout(
      () =>
        finish(
          null,
          new Error(`Timed out after ${timeoutMs}ms. stdout=${stdout} stderr=${stderr}`),
        ),
      timeoutMs,
    );
  });
}

function relayBuildArgs(outFile: string): readonly string[] {
  const manifest = JSON.parse(readFileSync(join(poolAgentDir, "package.json"), "utf8")) as {
    readonly scripts?: Readonly<Record<string, string>>;
  };
  const buildScript = manifest.scripts?.build ?? "";
  const relayStep = buildScript
    .split("&&")
    .map((part) => part.trim())
    .find((part) => part.startsWith("esbuild src/relay-main.ts "));
  if (!relayStep) {
    throw new Error("apps/pool-agent/package.json build script is missing the relay-main.ts step.");
  }
  const tokens = relayStep.split(/\s+/u);
  const replaced = tokens.map((token) =>
    token === "--outfile=dist/relay.mjs" ? `--outfile=${outFile}` : token,
  );
  if (!replaced.includes(`--outfile=${outFile}`)) {
    throw new Error(
      "apps/pool-agent/package.json relay-main.ts step did not target dist/relay.mjs.",
    );
  }
  return replaced;
}

beforeAll(() => {
  buildRoot = mkdtempSync(join(tmpdir(), "opensteer-standalone-build-"));
  const browserRuntimeOut = join(buildRoot, "browser-runtime");
  const poolAgentOut = join(buildRoot, "pool-agent");

  execFileSync(
    "pnpm",
    ["exec", "tsup", "--config", "tsup.config.ts", "--out-dir", browserRuntimeOut],
    {
      cwd: browserRuntimeDir,
      stdio: "pipe",
    },
  );
  execFileSync("pnpm", ["exec", "tsup", "--out-dir", poolAgentOut], {
    cwd: poolAgentDir,
    stdio: "pipe",
  });
  const relayOut = join(poolAgentOut, "relay.mjs");
  execFileSync("pnpm", ["exec", ...relayBuildArgs(relayOut)], {
    cwd: poolAgentDir,
    stdio: "pipe",
  });

  egressArtifact = join(browserRuntimeOut, "egress-main.js");
  agentArtifact = join(poolAgentOut, "main.js");
  relayArtifact = relayOut;
}, 60_000);

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolveExit) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolveExit();
        }, 3_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolveExit();
        });
      });
    }
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

afterAll(() => {
  if (buildRoot) rmSync(buildRoot, { recursive: true, force: true });
});

describe("enrolled pool host single-file artifacts run standalone with bare node", () => {
  it("starts egress-main.js alone in an empty directory without node_modules and answers /health", async () => {
    const dir = isolatedDir("opensteer-egress-standalone-");
    const target = join(dir, "egress-main.js");
    copyFileSync(egressArtifact, target);

    const port = await freePort();
    const child = spawn(process.execPath, [target], {
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "",
        NODE_ENV: "production",
        OPENSTEER_BROWSER_EGRESS_HOST: "127.0.0.1",
        OPENSTEER_BROWSER_EGRESS_PORT: String(port),
        OPENSTEER_BROWSER_EGRESS_UPSTREAM_REQUIRED: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);

    const result = await waitForOutput(child, (out) => out.includes('"browser-egress.ready"'));
    expect(result.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND/u);
    expect(result.stdout).toContain('"browser-egress.ready"');
    const readyLine = result.stdout
      .trim()
      .split("\n")
      .find((line) => line.includes('"browser-egress.ready"'));
    const ready = JSON.parse(readyLine!) as { host: string; port: number };
    expect(ready.port).toBeGreaterThan(0);

    const health = await fetch(`http://127.0.0.1:${ready.port}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
  });

  it("starts relay.mjs alone in an empty directory without node_modules and reaches relay.ready", async () => {
    const dir = isolatedDir("opensteer-relay-standalone-");
    const target = join(dir, "relay.mjs");
    copyFileSync(relayArtifact, target);

    const { privateKey } = generateKeyPairSync("ed25519");
    const keyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const keyPath = join(dir, "relay-key.pem");
    const certPath = join(dir, "relay.crt");
    writeFileSync(keyPath, keyPem, { mode: 0o600 });
    execFileSync(
      "openssl",
      [
        "req",
        "-new",
        "-x509",
        "-key",
        keyPath,
        "-days",
        "1",
        "-subj",
        "/CN=relay-test",
        "-out",
        certPath,
      ],
      { stdio: "pipe" },
    );
    const credDir = isolatedDir("opensteer-relay-creds-");
    writeFileSync(join(credDir, "relay-key"), keyPem, { mode: 0o600 });

    const port = await freePort();
    const configPath = join(dir, "relay.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        listen: { host: "127.0.0.1", port },
        certificate: certPath,
        authSocket: join(dir, "auth.sock"),
      }),
    );

    const child = spawn(process.execPath, [target, configPath], {
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "",
        CREDENTIALS_DIRECTORY: credDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);

    const result = await waitForOutput(child, (out) => out.includes('"relay.ready"'));
    expect(result.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND/u);
    expect(result.stdout).toContain('"relay.ready"');
  });

  it("loads pool-agent main.js alone in an empty directory without node_modules", async () => {
    const dir = isolatedDir("opensteer-agent-standalone-");
    const target = join(dir, "main.js");
    copyFileSync(agentArtifact, target);

    const child = spawn(process.execPath, [target, join(dir, "missing-agent.json")], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);

    const result = await waitForOutput(child, (out) => out.includes('"agent.failed"'));
    expect(result.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND/u);
    expect(result.stdout).toContain('"agent.failed"');
    expect(result.stdout).toMatch(/There is no configuration at/u);
  });
});
