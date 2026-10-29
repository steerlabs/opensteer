import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { app, BrowserWindow, ipcMain, protocol } from "electron";
import { createId, type HostInstanceId } from "@opensteer/core";
import { DeploymentConnectionSchema } from "@opensteer/client/connections";
import { testDiscoveryEnvelope } from "@opensteer/client/test-support";
import { hostApiVersion } from "@opensteer/deployment-authority";
import { hostApiVersionHeader } from "@opensteer/protocol";
import { desktopWebPreferences } from "../src/app/electron-window.js";
import { registerDesktopAppScheme } from "../src/app/app-protocol.js";
import { ElectronHostNetwork } from "../src/app/electron-host-network.js";
import { desktopBridgeChannels } from "../src/bridge/desktop-bridge-channels.js";
import type { DesktopBridgeContext } from "../src/bridge/context.js";
import {
  handleHostBinaryClose,
  handleHostBinaryFinish,
  handleHostBinaryOpen,
  handleHostBinaryRead,
  handleHostBinaryWrite,
} from "../src/bridge/methods/host.js";
import { DesktopHostTransport } from "../src/connections/host-transport.js";

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
  const source = Uint8Array.from(
    { length: 2 * 1_024 * 1_024 + 17 },
    (_, index) => (index * 37 + 13) & 255,
  );
  const sourceHash = createHash("sha256").update(source).digest("hex");
  let upload: Uint8Array | null = null;
  let requestCount = 0;
  let slowStarted = false;
  let abortedDownload = false;
  let observedHeaders: Record<string, string | undefined> = {};
  const server = createServer((request, response) => {
    requestCount += 1;
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.searchParams.get("input") !== JSON.stringify({ attachmentId: "att_smoke" })) {
      response.writeHead(400).end("Missing attachment metadata");
      return;
    }
    if (url.pathname === "/v1/rpc/attachment.upload" && request.method === "POST") {
      observedHeaders = {
        authorization: request.headers.authorization,
        contentType: request.headers["content-type"],
        origin: request.headers.origin,
        version: request.headers[hostApiVersionHeader],
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
    if (url.pathname === "/v1/rpc/attachment.content" && request.method === "GET") {
      if (url.searchParams.get("slow") === "1") {
        slowStarted = true;
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.write(source.subarray(0, 256 * 1_024));
        const end = setTimeout(() => response.end(source), 10_000);
        response.once("close", () => {
          clearTimeout(end);
          abortedDownload = !response.writableEnded;
        });
        return;
      }
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        etag: '"smoke"',
        "x-opensteer-file-size": String(source.byteLength),
      });
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
        deploymentShape: { defaultWorkspaceBacking: "portablefs", kind: "server" },
      }),
      bootstrapMethods: ["password"],
      createdAt: now,
      endpoints: [{ kind: "canonical", origin, verifiedAt: now }],
      kind: "self-hosted",
      lastUsedAt: null,
      name: "Attachment smoke",
      reachability: "canonical",
      source: { kind: "manual" },
      updatedAt: now,
    });
    const catalog = {
      load: async () => ({
        deployments: [connection],
        revision: 1,
        schemaVersion: 4 as const,
        selectedDeploymentId: deploymentId,
        updatedAt: now,
      }),
      select: async () => undefined,
      setPreferredEndpoint: async () => undefined,
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
    const bridgeToken = randomBytes(32).toString("base64url");
    const context = {
      options: { bridgeToken, hostTransport: transport },
      trackedHostSenders: new Set<number>(),
    } as unknown as DesktopBridgeContext;
    const handlers = [
      [desktopBridgeChannels.hostBinaryOpen, handleHostBinaryOpen(context)],
      [desktopBridgeChannels.hostBinaryWrite, handleHostBinaryWrite(context)],
      [desktopBridgeChannels.hostBinaryFinish, handleHostBinaryFinish(context)],
      [desktopBridgeChannels.hostBinaryRead, handleHostBinaryRead(context)],
      [desktopBridgeChannels.hostBinaryClose, handleHostBinaryClose(context)],
    ] as const;
    for (const [channel, handler] of handlers) ipcMain.handle(channel, handler);
    protocol.handle(
      "app",
      () =>
        new Response("<!doctype html><title>Attachment smoke</title>", {
          headers: { "content-type": "text/html" },
        }),
    );
    const before = attachmentSpools();
    const window = new BrowserWindow({
      show: false,
      webPreferences: desktopWebPreferences(
        { mode: "production" },
        bridgeToken,
        path.resolve("dist/preload.cjs"),
      ),
    });
    try {
      await window.loadURL("app://opensteer/");
      await window.webContents.executeJavaScript(`
        window.attachmentSmokeBridge = Object.fromEntries(
          ["hostBinaryOpen", "hostBinaryWrite", "hostBinaryFinish", "hostBinaryRead", "hostBinaryClose"].map((name) => [name, async (input) => {
            const result = await window.opensteerDesktop[name](input);
            if (!result.ok) throw new Error(result.error.code);
            return result.data;
          }]),
        );
        void 0;
      `);
      const result: {
        uploadStatus: number;
        downloadHash: string;
        downloadedBytes: number;
        originRejected: boolean;
      } = await window.webContents.executeJavaScript(`(async () => {
        const bridge = window.attachmentSmokeBridge;
        const input = encodeURIComponent(JSON.stringify({ attachmentId: "att_smoke" }));
        const source = Uint8Array.from({ length: ${source.byteLength} }, (_, i) => (i * 37 + 13) & 255);
        const upload = await bridge.hostBinaryOpen({
          headers: { contentType: "application/octet-stream", apiVersion: "${hostApiVersion}" },
          method: "POST", path: "/v1/rpc/attachment.upload?input=" + input,
        });
        for (let offset = 0; offset < source.length; offset += 256 * 1024) {
          await bridge.hostBinaryWrite({ transferId: upload.transferId, bytes: source.subarray(offset, offset + 256 * 1024) });
        }
        const uploaded = await bridge.hostBinaryFinish(upload);
        const download = await bridge.hostBinaryOpen({
          headers: { apiVersion: "${hostApiVersion}" },
          method: "GET", path: "/v1/rpc/attachment.content?input=" + input,
        });
        const chunks = [];
        let count = 0;
        while (true) {
          const part = await bridge.hostBinaryRead(download);
          chunks.push(part.bytes);
          count += part.bytes.length;
          if (part.done) break;
        }
        await bridge.hostBinaryClose(download);
        const bytes = new Uint8Array(count);
        let offset = 0;
        for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
        let originRejected = false;
        try {
          await bridge.hostBinaryOpen({ headers: {}, method: "GET", path: "https://evil.test/v1/rpc/attachment.content?input=" + input });
        } catch { originRejected = true; }
        return { uploadStatus: uploaded.status, downloadHash: hash, downloadedBytes: count, originRejected };
      })()`);
      assert.equal(result.uploadStatus, 200);
      assert.equal(result.downloadHash, sourceHash);
      assert.equal(result.downloadedBytes, source.byteLength);
      assert(result.originRejected);
      assert(upload);
      assert.equal(createHash("sha256").update(upload).digest("hex"), sourceHash);
      assert.deepEqual(observedHeaders, {
        authorization: "Bearer smoke",
        contentType: "application/octet-stream",
        origin,
        version: String(hostApiVersion),
      });
      assert.equal(requestCount, 2);
      const slow: { transferId: string } = await window.webContents.executeJavaScript(`
        window.attachmentSmokeBridge.hostBinaryOpen({
          headers: {}, method: "GET",
          path: "/v1/rpc/attachment.content?input=" + encodeURIComponent(JSON.stringify({ attachmentId: "att_smoke" })) + "&slow=1",
        })`);
      await waitUntil(() => slowStarted);
      await window.webContents.executeJavaScript(`
        window.attachmentSmokeBridge.hostBinaryClose({ transferId: "${slow.transferId}" })`);
      const oversizedRejected: boolean = await window.webContents.executeJavaScript(`(async () => {
          const bridge = window.attachmentSmokeBridge;
          const input = encodeURIComponent(JSON.stringify({ attachmentId: "att_smoke" }));
          const large = await bridge.hostBinaryOpen({
            headers: { contentType: "application/octet-stream" }, method: "POST",
            path: "/v1/rpc/attachment.upload?input=" + input,
          });
          const chunk = new Uint8Array(256 * 1024);
          for (let index = 0; index < 100; index += 1) {
            await bridge.hostBinaryWrite({ transferId: large.transferId, bytes: chunk });
          }
          let oversizedRejected = false;
          try {
            await bridge.hostBinaryWrite({ transferId: large.transferId, bytes: new Uint8Array(1) });
          } catch { oversizedRejected = true; }
          await bridge.hostBinaryClose(large);
          return oversizedRejected;
        })()`);
      assert(oversizedRejected);
      await waitUntil(() => abortedDownload);
      await waitUntil(() => sameSpools(before, attachmentSpools()));
      const concurrent: { opened: number; rejected: number } = await window.webContents
        .executeJavaScript(`(async () => {
          const input = encodeURIComponent(JSON.stringify({ attachmentId: "att_smoke" }));
          const results = await Promise.allSettled(Array.from({ length: 9 }, () =>
            window.attachmentSmokeBridge.hostBinaryOpen({
              headers: { contentType: "application/octet-stream" }, method: "POST",
              path: "/v1/rpc/attachment.upload?input=" + input,
            })));
          const opened = results.filter((result) => result.status === "fulfilled");
          await Promise.all(opened.map((result) => window.attachmentSmokeBridge.hostBinaryClose(result.value)));
          return { opened: opened.length, rejected: results.length - opened.length };
        })()`);
      assert.equal(concurrent.opened, 8);
      assert.equal(concurrent.rejected, 1);
      await waitUntil(() => sameSpools(before, attachmentSpools()));
      const unfinished: { transferId: string } = await window.webContents.executeJavaScript(`
        window.attachmentSmokeBridge.hostBinaryOpen({
          headers: { contentType: "application/octet-stream" },
          method: "POST", path: "/v1/rpc/attachment.upload?input=" + encodeURIComponent(JSON.stringify({ attachmentId: "att_smoke" })),
        })`);
      assert(unfinished.transferId);
      window.destroy();
      await waitUntil(() => sameSpools(before, attachmentSpools()));
      return {
        event: "electron-attachment-smoke.passed",
        bytes: source.byteLength,
        sha256: sourceHash,
        requestCount,
        originFence: result.originRejected,
        abortedDownload,
        oversizedRejected,
        concurrentBound: concurrent.opened,
        destroyedRendererCleanup: true,
      };
    } finally {
      if (!window.isDestroyed()) window.destroy();
      for (const [channel] of handlers) ipcMain.removeHandler(channel);
      protocol.unhandle("app");
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function attachmentSpools(): Set<string> {
  return new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("opensteer-attachment-")));
}

function sameSpools(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((name) => right.has(name));
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Binary spool was not cleaned after its renderer was destroyed.");
}
