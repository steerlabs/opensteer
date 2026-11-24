import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { chromium, type Page } from "playwright-core";
import { build, type Plugin } from "vite";

const root = resolve(import.meta.dirname, "../..");
const webRoot = join(root, "apps/web");
const run = promisify(execFile);

export const fixtureWebVersion = "0.0.0-task-switch-benchmark";

export async function buildSwitchWeb(outDir: string) {
  // Vite in the test worker can inherit Vitest's module runner. Keep the production build in
  // its own process, as the browser source journey does.
  await run(process.execPath, ["--import", "tsx", import.meta.filename, outDir], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "production", VITE_OPENSTEER_USE_MOCK: "false" },
  });
}

async function buildWeb(outDir: string) {
  const virtualId = "\0task-switch:browser-host-client";
  const unifiedPrefix = "\0task-switch:unified:";
  const probe = join(import.meta.dirname, "browser-probe.ts");
  const instrument: Plugin = {
    name: "task-switch-browser-probe",
    enforce: "pre",
    async resolveId(id, importer) {
      if (id === "./host/browser-host-client.js" && importer === join(webRoot, "src/main.tsx"))
        return virtualId;
      if (id !== "unified" || !importer?.endsWith("/react-markdown/lib/index.js")) return;
      const resolved = await this.resolve(id, importer, { skipSelf: true });
      if (!resolved) throw new Error("Could not resolve react-markdown's parser.");
      return unifiedPrefix + resolved.id;
    },
    load(id) {
      if (id.startsWith(unifiedPrefix)) {
        const source = JSON.stringify(id.slice(unifiedPrefix.length));
        return `
          import { unified as original } from ${source};
          import { enableReactMarkdownProbe, recordReactMarkdownParse } from ${JSON.stringify(probe)};
          export * from ${source};
          enableReactMarkdownProbe();
          export function unified() {
            const processor = original();
            const parse = processor.parse;
            processor.parse = function (file) {
              recordReactMarkdownParse();
              return parse.call(this, file);
            };
            return processor;
          }
        `;
      }
      if (id !== virtualId) return;
      return `
        import { createBrowserHostClient as create } from "/src/host/browser-host-client.ts";
        import { installTaskSwitchProbe } from ${JSON.stringify(probe)};
        export function createBrowserHostClient(options) {
          const client = create(options);
          installTaskSwitchProbe(client);
          return client;
        }
      `;
    },
  };
  await build({
    root: webRoot,
    configFile: join(webRoot, "vite.config.ts"),
    mode: "production",
    logLevel: "error",
    plugins: [instrument],
    build: {
      outDir,
      emptyOutDir: true,
      sourcemap: false,
      rollupOptions: { input: { main: join(webRoot, "index.html") } },
    },
  });
  await run(
    process.execPath,
    [
      "--import",
      "tsx",
      join(root, "scripts/write-web-distribution-manifest.mjs"),
      outDir,
      fixtureWebVersion,
    ],
    { cwd: root },
  );
}

if (process.argv[1] === import.meta.filename) await buildWeb(process.argv[2]!);

export async function openSwitchBrowser() {
  const executablePath = process.env.OPENSTEER_CHROMIUM_EXECUTABLE;
  return chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
}

interface Frame {
  direction: "sent" | "received";
  payload: string | Buffer;
}
interface Payload {
  type?: string;
  scope?: { kind: string; threadId?: string };
  cursor?: unknown;
  anchorItemId?: string;
}

export function trackTransport(page: Page) {
  let frames: Frame[] = [];
  const trackFrame =
    (direction: Frame["direction"]) =>
    ({ payload }: { payload: string | Buffer }) =>
      frames.push({ direction, payload });
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname !== "/v1/realtime") return;
    socket.on("framereceived", trackFrame("received"));
    socket.on("framesent", trackFrame("sent"));
  });
  let requests: import("playwright-core").Request[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/v1/rpc/")) requests.push(request);
  });
  return {
    reset() {
      frames = [];
      requests = [];
    },
    async read(clickAt: number, endAt: number, threadId: string) {
      const websocket: Record<string, { count: number; payloadBytes: number }> = {};
      const selectedSubscriptions: { hadResumeCursor: boolean; hadAnchor: boolean }[] = [];
      let receivedDetailSync = false;
      let detailChangesThroughFirstSync = 0;
      for (const { direction, payload } of frames) {
        const { type, scope, cursor, anchorItemId } = JSON.parse(payload.toString()) as Payload;
        const area = scope?.threadId === threadId ? "selected" : (scope?.kind ?? "control");
        if (direction === "sent" && area === "selected" && type === "client.subscribe")
          selectedSubscriptions.push({
            hadResumeCursor: cursor !== undefined,
            hadAnchor: anchorItemId !== undefined,
          });
        if (direction === "received" && area === "selected" && !receivedDetailSync) {
          if (type === "host.changes") detailChangesThroughFirstSync++;
          if (type === "host.synchronized") receivedDetailSync = true;
        }
        const key = `${direction} ${area} ${type ?? "unknown"}`;
        const bucket = (websocket[key] ??= { count: 0, payloadBytes: 0 });
        bucket.count++;
        bucket.payloadBytes += Buffer.byteLength(payload);
      }
      const rpc: Record<
        string,
        {
          requests: number;
          requestBodyBytes: number;
          requestQueryBytes: number;
          responseBodyBytes: number;
          unfinished: number;
        }
      > = {};
      // Copy the lists before awaiting sizes. Don't let requests from a later interval in.
      await Promise.all(
        requests
          .filter((request) => {
            const { startTime } = request.timing();
            return startTime >= clickAt - 0.5 && startTime <= endAt;
          })
          .map(async (request) => {
            const url = new URL(request.url());
            const method = url.pathname.slice("/v1/rpc/".length);
            const bucket = (rpc[method] ??= {
              requests: 0,
              requestBodyBytes: 0,
              requestQueryBytes: 0,
              responseBodyBytes: 0,
              unfinished: 0,
            });
            bucket.requests++;
            bucket.requestBodyBytes += request.postDataBuffer()?.length ?? 0;
            bucket.requestQueryBytes += Buffer.byteLength(url.search.slice(1));
            if (request.timing().responseEnd < 0) {
              bucket.unfinished++;
              return;
            }
            const sizes = await request.sizes();
            bucket.responseBodyBytes += sizes.responseBodySize;
          }),
      );
      return {
        websocket,
        selectedSubscriptions,
        detailChangesThroughFirstSync: receivedDetailSync ? detailChangesThroughFirstSync : null,
        rpc,
      };
    },
  };
}
