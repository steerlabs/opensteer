import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createId } from "../packages/core/src/index.js";
import { afterEach, expect, it } from "vitest";
import { signHostDiscovery } from "../apps/host/src/identity/host-keys.js";
import { RunFileRelay } from "../apps/host/src/integrations/run-file-relay.js";
import { hostServerTestDependencies } from "../apps/host/src/server/host-server-test-harness.js";
import { createHostServer } from "../apps/host/src/server.js";
import { RunFiles } from "../apps/runner/src/attachments/run-files.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function deployment() {
  const relay = new RunFileRelay();
  const app = await createHostServer(
    hostServerTestDependencies({
      discovery: signHostDiscovery(generateKeyPairSync("ed25519"), {
        canonicalOrigin: "https://opensteer.example",
        deploymentId: createId("deployment"),
        hostInstanceId: createId("hostInstance"),
        hostKey: { algorithm: "Ed25519" },
        deploymentShape: { defaultWorkspaceBacking: "local-directory", kind: "server" },
      }),
      runFiles: relay,
    }),
  );
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  cleanups.push(() => app.close());
  const root = await mkdtemp(join(tmpdir(), "run-file-transfer-"));
  cleanups.push(() => rm(root, { force: true, recursive: true }));
  const runner = (name: string) =>
    new RunFiles({
      dataDirectory: join(root, name),
      helperBinary: process.execPath,
      transport: { hostOrigin: new URL(origin), mode: "development" },
    });
  return { exports: join(root, "exports"), relay, source: runner("source"), target: runner("target") };
}

it("moves a file larger than any frame between two Runners through the Host, byte for byte", async () => {
  const { exports, relay, source, target } = await deployment();
  const handle = relay.open();
  const bytes = randomBytes(24 * 1_024 * 1_024);
  const signal = new AbortController().signal;
  const uploaded = source.upload(
    handle.upload,
    { body: Readable.from([bytes]), name: "어머니 문서.heic", size: bytes.byteLength },
    signal,
  );
  const received = await target.download(handle.download, signal);
  const path = await target.install(received, exports, signal);
  await uploaded;
  expect(path.endsWith("어머니 문서.heic")).toBe(true);
  expect(sha(await readFile(path))).toBe(sha(bytes));
});

it("publishes nothing when the sender dies partway", async () => {
  const { exports, relay, source, target } = await deployment();
  const handle = relay.open();
  const stop = new AbortController();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const body = (async function* () {
    yield Buffer.alloc(64 * 1_024, 1);
    await hold;
    yield Buffer.alloc(1_024, 2);
  })();
  const uploaded = source
    .upload(handle.upload, { body, name: "partial.bin", size: 1_024 * 1_024 }, stop.signal)
    .catch((error: unknown) => error);
  const received = await target.download(handle.download, new AbortController().signal);
  stop.abort();
  release();
  await expect(target.install(received, exports, new AbortController().signal)).rejects.toThrow();
  await uploaded;
  await expect(readdir(exports)).resolves.toEqual([]);
});
