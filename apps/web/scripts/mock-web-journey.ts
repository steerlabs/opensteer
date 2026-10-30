/**
 * What every web journey stands on: the production web build against the mock
 * Host, served the way a Host serves it, driven in headless Chromium, and
 * checks that keep what they observed for `result.json`. Chromium is
 * Playwright's (`playwright-core install chromium`) unless
 * OPENSTEER_CHROMIUM_EXECUTABLE names another.
 */
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright-core";
import { build } from "vite";

const webRoot = path.resolve(import.meta.dirname, "..");

export interface MockWeb {
  readonly browser: Browser;
  readonly origin: string;
  /** Closes the browser and the server, and removes the build. */
  close(): Promise<void>;
}

/**
 * Builds the web app against the mock Host into a temporary `name-*` directory,
 * serves it and starts Chromium.
 */
export async function openMockWeb(name: string): Promise<MockWeb> {
  const buildDirectory = await mkdtemp(path.join(tmpdir(), `${name}-`));
  const server = createServer((request, response) => {
    void serve(buildDirectory, request, response);
  });
  try {
    await buildMockWeb(buildDirectory);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("The web server has no port.");
    const executablePath = process.env.OPENSTEER_CHROMIUM_EXECUTABLE;
    const browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    return {
      browser,
      origin: `http://127.0.0.1:${address.port}`,
      async close() {
        await browser.close();
        server.close();
        await rm(buildDirectory, { force: true, recursive: true });
      },
    };
  } catch (error) {
    server.close();
    await rm(buildDirectory, { force: true, recursive: true });
    throw error;
  }
}

export interface CheckRecord {
  readonly name: string;
  readonly status: "passed" | "failed";
  readonly observed: Record<string, unknown>;
  readonly error?: string;
}

/** A failed expectation, carrying what the journey saw. */
export class JourneyFailure extends Error {
  readonly observed: Record<string, unknown>;

  constructor(message: string, observed: Record<string, unknown>) {
    super(message);
    this.observed = observed;
  }
}

export function expectThat(observed: Record<string, unknown>, condition: boolean, failure: string) {
  if (!condition) throw new JourneyFailure(failure, observed);
}

/** A journey's checks: each runs once and is kept, passed or failed, with what it observed. */
export function journeyChecks() {
  const checks: CheckRecord[] = [];
  return {
    checks,
    async check(name: string, run: () => Promise<Record<string, unknown>>): Promise<void> {
      try {
        checks.push({ name, observed: await run(), status: "passed" });
      } catch (error) {
        const observed = error instanceof JourneyFailure ? error.observed : {};
        checks.push({ error: errorText(error), name, observed, status: "failed" });
      }
    },
    /** The journey itself stopped: kept as one more failed check. */
    abort(error: unknown): void {
      checks.push({ error: errorText(error), name: "journey", observed: {}, status: "failed" });
    },
  };
}

/** Writes `result.json` beside the journey's other evidence, prints each check and sets the exit code. */
export async function finishJourney(
  artifactDirectory: string,
  checks: readonly CheckRecord[],
  extra: Record<string, unknown> = {},
): Promise<void> {
  const passed = checks.every(({ status }) => status === "passed");
  await writeFile(
    path.join(artifactDirectory, "result.json"),
    `${JSON.stringify({ checks, ...extra, passed, finishedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  for (const { name, status, error } of checks)
    process.stdout.write(
      `${status === "passed" ? "ok  " : "FAIL"} ${name}${error ? `: ${error}` : ""}\n`,
    );
  process.stdout.write(`${JSON.stringify({ artifactDirectory, passed })}\n`);
  process.exitCode = passed ? 0 : 1;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function buildMockWeb(outDir: string): Promise<void> {
  process.env.VITE_OPENSTEER_USE_MOCK = "true";
  await build({
    build: {
      emptyOutDir: true,
      outDir,
      sourcemap: false,
      rollupOptions: {
        input: {
          main: path.join(webRoot, "index.html"),
          composer: path.join(webRoot, "composer-visual.html"),
          dictation: path.join(webRoot, "dictation-visual.html"),
        },
      },
    },
    configFile: path.join(webRoot, "vite.config.ts"),
    logLevel: "error",
    mode: "production",
    root: webRoot,
  });
}

/** Files from the build, and the app for any route; as a Host serves its web app. */
async function serve(root: string, request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const relative = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/u, "");
  const candidate = path.join(root, relative);
  const inside = candidate === root || candidate.startsWith(`${root}${path.sep}`);
  const file = inside && (await isFile(candidate)) ? candidate : null;
  const target = file ?? (path.extname(relative) ? null : path.join(root, "index.html"));
  if (!target) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not Found");
    return;
  }
  response.writeHead(200, { "content-type": contentType(target) });
  response.end(await readFile(target));
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

function contentType(file: string): string {
  switch (path.extname(file)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".woff2":
      return "font/woff2";
    case ".json":
      return "application/json";
    default:
      return "application/octet-stream";
  }
}
