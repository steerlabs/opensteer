import { DeploymentCatalogSchema } from "@opensteer/client/connections";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { app, BrowserWindow, protocol } from "electron";
import { createId, type HostInstanceId } from "@opensteer/core";
import { DeploymentConnectionSchema } from "@opensteer/client/connections";
import { testDiscoveryEnvelope } from "@opensteer/client/test-support";
import { hostApiVersion } from "@opensteer/deployment-authority";
import { hostApiVersionHeader } from "@opensteer/protocol";
import { desktopHostRequestIdHeader } from "@opensteer/protocol/desktop";
import { desktopWebPreferences } from "../src/app/electron-window.js";
import { registerDesktopAppScheme } from "../src/app/app-protocol.js";
import { ElectronHostNetwork } from "../src/app/electron-host-network.js";
import { forwardHostRoute } from "../src/app/host-route.js";
import { DesktopHostTransport } from "../src/connections/host-transport.js";
import { installSmokeGuard } from "./test-support/smoke-guard.js";

installSmokeGuard("attachment", 180000);

const profile = mkdtempSync(path.join(tmpdir(), "opensteer-attachment-electron-"));
app.setPath("userData", profile);
registerDesktopAppScheme(protocol);
app.on("window-all-closed", () => undefined);
const watchdog = setTimeout(() => {
  process.stderr.write("Electron attachment smoke timed out.\n");
  app.exit(1);
}, 90_000);

void run().then(
  (artifact) => finish(0, artifact),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    finish(1, null);
  },
);

function finish(code: number, artifact: object | null): void {
  try {
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    // Chromium can finish a profile write after the renderer is destroyed.
    // Retry that filesystem race, and always exit even if cleanup still fails.
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (artifact) {
      const directory = process.env.OPENSTEER_ATTACHMENTS_E2E_ARTIFACT_DIR ?? tmpdir();
      mkdirSync(directory, { recursive: true });
      const artifactPath = path.join(directory, "electron-attachment-e2e.json");
      writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify({ ...artifact, artifactPath })}\n`);
    }
  } catch (error) {
    code = 1;
    process.stderr.write(`Attachment fixture cleanup failed: ${String(error)}\n`);
  } finally {
    clearTimeout(watchdog);
    app.exit(code);
  }
}

async function run(): Promise<object> {
  await app.whenReady();
  // Every byte value, so a UTF-8 decode anywhere on the path would change it.
  const source = Uint8Array.from(
    { length: 2 * 1_024 * 1_024 + 17 },
    (_, index) => (index * 37 + 13) & 255,
  );
  const sourceHash = createHash("sha256").update(source).digest("hex");
  let upload: Uint8Array | null = null;
  let observedHeaders: Record<string, string | undefined> = {};
  const closed = new Set<string>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    response.once("close", () => {
      if (!response.writableEnded) closed.add(url.searchParams.get("case") ?? url.pathname);
    });
    if (url.pathname === "/v1/rpc/attachment.upload" && request.method === "POST") {
      observedHeaders = {
        authorization: request.headers.authorization,
        contentType: request.headers["content-type"],
        cookie: request.headers.cookie,
        origin: request.headers.origin,
        version: request.headers[hostApiVersionHeader] as string | undefined,
      };
      const parts: Uint8Array[] = [];
      request.on("data", (chunk: Buffer) => parts.push(chunk));
      request.on("end", () => {
        upload = Buffer.concat(parts);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, data: { id: "att_smoke" } }));
      });
      return;
    }
    if (url.pathname === "/v1/rpc/file.content") {
      const stall = url.searchParams.get("case");
      response.writeHead(200, {
        "content-type": "image/png",
        etag: '"smoke"',
        "last-modified": "Tue, 17 Nov 2026 10:00:00 GMT",
        "set-cookie": "host-session=secret; HttpOnly",
        "x-opensteer-file-size": String(source.byteLength),
      });
      if (stall === "mid-body") {
        response.write(source.subarray(0, 256 * 1_024));
        return;
      }
      response.end(source);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const deploymentId = createId("deployment");
    const now = "2026-08-11T10:00:00.000Z";
    const connection = DeploymentConnectionSchema.parse({
      authority: testDiscoveryEnvelope({
        canonicalOrigin: origin,
        deploymentId,
        hostInstanceId: createId("hostInstance") as HostInstanceId,
        hostKey: { algorithm: "Ed25519" },
        deploymentShape: { kind: "personal" },
      }),
      bootstrapMethods: ["password"],
      createdAt: now,
      endpoints: [{ kind: "canonical", origin, verifiedAt: now }],
      kind: "personal",
      lastUsedAt: null,
      name: "Attachment smoke",
      reachability: "canonical",
      source: { kind: "manual" },
      updatedAt: now,
    });
    // The catalog as the transport reads it: choosing a place or an endpoint answers with it.
    const listed = async () => ({
      deployments: [connection],
      revision: 1,
      schemaVersion: DeploymentCatalogSchema.shape.schemaVersion.value,
      selectedDeploymentId: deploymentId,
      updatedAt: now,
    });
    const catalog = {
      load: listed,
      select: listed,
      setPreferredEndpoint: listed,
      subscribe: () => () => undefined,
    };
    const transport = new DesktopHostTransport({
      catalog: catalog as ConstructorParameters<typeof DesktopHostTransport>[0]["catalog"],
      credentials: { authorizationHeader: async () => "Bearer smoke" },
      localRuntime: { current: async () => null },
      network: new ElectronHostNetwork(),
      projection: {
        read: async () => ({ deployments: [], revision: 1, selectedDeploymentId: deploymentId }),
      },
    });
    protocol.handle("app", (request) =>
      new URL(request.url).pathname.startsWith("/host/")
        ? forwardHostRoute(request, transport)
        : new Response("<!doctype html><title>Attachment smoke</title>", {
            headers: { "content-type": "text/html" },
          }),
    );
    const window = new BrowserWindow({
      show: false,
      webPreferences: desktopWebPreferences(
        { mode: "production" },
        randomBytes(32).toString("base64url"),
        path.resolve("dist/preload.cjs"),
      ),
    });
    try {
      await window.loadURL("app://opensteer/");
      // Main admits a request by the id the bundled app's adapter gives it. Cancelling one
      // before headers is the adapter's own, proved by electron-host-transport-smoke.
      await window.webContents.executeJavaScript(`window.hostFetch = (url, init = {}) => {
        const headers = new Headers(init.headers);
        headers.set("${desktopHostRequestIdHeader}", crypto.randomUUID());
        return fetch(url, { ...init, headers });
      }; undefined`);
      const route = `app://opensteer/host/${deploymentId}`;
      const result: {
        uploadStatus: number;
        downloadHash: string;
        downloadedBytes: number;
        headers: Record<string, string | null>;
        staleStatus: number;
      } = await window.webContents.executeJavaScript(`(async () => {
        const input = encodeURIComponent(JSON.stringify({ attachmentId: "att_smoke" }));
        const source = Uint8Array.from({ length: ${source.byteLength} }, (_, i) => (i * 37 + 13) & 255);
        const uploaded = await hostFetch("${route}/v1/rpc/attachment.upload?input=" + input, {
          method: "POST",
          body: new Blob([source]),
          headers: { "content-type": "application/octet-stream", "${hostApiVersionHeader}": "${hostApiVersion}", authorization: "Bearer renderer" },
        });
        await uploaded.arrayBuffer();
        const download = await hostFetch("${route}/v1/rpc/file.content?input=" + input);
        const bytes = new Uint8Array(await download.arrayBuffer());
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
        const headers = Object.fromEntries(["content-type", "etag", "last-modified", "set-cookie", "x-opensteer-file-size"].map((name) => [name, download.headers.get(name)]));
        const stale = await hostFetch("app://opensteer/host/${createId("deployment")}/v1/rpc/file.content?input=" + input);
        return { uploadStatus: uploaded.status, downloadHash: hash, downloadedBytes: bytes.length, headers, staleStatus: stale.status };
      })()`);
      assert.equal(result.uploadStatus, 200);
      assert(upload);
      assert.equal(createHash("sha256").update(upload).digest("hex"), sourceHash);
      assert.deepEqual(observedHeaders, {
        authorization: "Bearer smoke",
        contentType: "application/octet-stream",
        cookie: undefined,
        origin,
        version: String(hostApiVersion),
      });
      assert.equal(result.downloadHash, sourceHash);
      assert.equal(result.downloadedBytes, source.byteLength);
      assert.deepEqual(result.headers, {
        "content-type": "image/png",
        etag: '"smoke"',
        "last-modified": "Tue, 17 Nov 2026 10:00:00 GMT",
        "set-cookie": null,
        "x-opensteer-file-size": String(source.byteLength),
      });
      assert.equal(result.staleStatus, 502);
      // Once headers arrive, Chromium's own cancellation of the body reaches the Host.
      await window.webContents.executeJavaScript(`(async () => {
        const controller = new AbortController();
        const pending = hostFetch("${route}/v1/rpc/file.content?case=mid-body", { signal: controller.signal });
        try {
          for await (const _chunk of (await pending).body) controller.abort();
        } catch {}
      })()`);
      await waitUntil(() => closed.has("mid-body"), "the mid-body Host request was not cancelled");
      return {
        event: "electron-attachment-smoke.passed",
        bytes: source.byteLength,
        sha256: sourceHash,
        headers: result.headers,
        cancelled: [...closed],
      };
    } finally {
      if (!window.isDestroyed()) window.destroy();
      protocol.unhandle("app");
      transport.dispose();
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function waitUntil(predicate: () => boolean, failure: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(failure);
}
