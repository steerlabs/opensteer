import { hostApiVersion, hostApiVersionHeader } from "@opensteer/deployment-authority";
import { Readable } from "node:stream";
import { createId } from "@opensteer/core";
import { generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import {
  runFileNameHeader,
  runFileProofHeader,
  runFileTransferProofPayload,
  RunnerConnectionFenceSchema,
  runFileTransferContentType,
  runFileTransferPath,
} from "@opensteer/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signHostDiscovery } from "../identity/host-keys.js";
import { createHostServer } from "../server.js";
import { hostServerTestDependencies } from "../server/host-server-test-harness.js";
import { RunFileRelay } from "./run-file-relay.js";

const bytes = Buffer.from("the photo's exact bytes");

async function text(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString();
}

describe("RunFileRelay", () => {
  it("hands the upload to the download and holds the uploader until it is done", async () => {
    const relay = new RunFileRelay();
    const handle = relay.open();
    let uploaded = false;
    const upload = relay
      .upload(handle.upload.id, handle.upload.token, {
        name: "IMG_1.HEIC",
        sizeBytes: bytes.byteLength,
        stream: Readable.from([bytes]),
      })
      .then(() => {
        uploaded = true;
      });
    const file = await relay.download(handle.download.id, handle.download.token);
    expect(file).toMatchObject({ name: "IMG_1.HEIC", sizeBytes: bytes.byteLength });
    expect(await text(file.stream)).toBe(bytes.toString());
    expect(uploaded).toBe(false);
    file.settled();
    await upload;
    expect(uploaded).toBe(true);
  });

  it("refuses the wrong direction's token, a second use, and an ended transfer", async () => {
    const relay = new RunFileRelay();
    const handle = relay.open();
    const file = { name: "a", sizeBytes: 1, stream: Readable.from([Buffer.from("a")]) };
    await expect(relay.upload(handle.upload.id, handle.download.token, file)).rejects.toThrow(
      "not available",
    );
    await expect(relay.download(handle.download.id, handle.upload.token)).rejects.toThrow(
      "not available",
    );
    void relay.upload(handle.upload.id, handle.upload.token, file).catch(() => undefined);
    await expect(relay.upload(handle.upload.id, handle.upload.token, file)).rejects.toThrow(
      "not available",
    );
    handle.close();
    await expect(relay.download(handle.download.id, handle.download.token)).rejects.toThrow(
      "not available",
    );
  });

  it("refuses oversized uploads and settles when the uploader disconnects", async () => {
    const relay = new RunFileRelay();
    const handle = relay.open(1);
    const stream = new Readable({ read() {} });
    try {
      await expect(
        relay.upload(handle.upload.id, handle.upload.token, {
          name: "a",
          sizeBytes: 2,
          stream,
        }),
      ).rejects.toMatchObject({ code: "bad_request" });
      const upload = relay.upload(handle.upload.id, handle.upload.token, {
        name: "a",
        sizeBytes: 1,
        stream,
      });
      await relay.download(handle.download.id, handle.download.token);
      stream.destroy();
      await expect(upload).rejects.toThrow("The upload stopped");
    } finally {
      handle.close();
    }
  });

  it("releases both sides when the call ends before they meet", async () => {
    const relay = new RunFileRelay();
    const waiting = relay.open();
    const download = relay.download(waiting.download.id, waiting.download.token);
    waiting.close(new Error("The source refused."));
    await expect(download).rejects.toThrow("The source refused.");

    const abandoned = relay.open();
    const stream = Readable.from([bytes]);
    const upload = relay.upload(abandoned.upload.id, abandoned.upload.token, {
      name: "a",
      sizeBytes: bytes.byteLength,
      stream,
    });
    abandoned.close();
    await expect(upload).rejects.toThrow("ended");
    await expect.poll(() => stream.destroyed).toBe(true);
  });
});

describe("the transfer route", () => {
  const closing: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    await Promise.all(closing.splice(0).map((close) => close()));
  });

  async function serve(relay: RunFileRelay): Promise<string> {
    const app = await createHostServer(
      hostServerTestDependencies({
        discovery: signHostDiscovery(generateKeyPairSync("ed25519"), {
          canonicalOrigin: "https://opensteer.example",
          deploymentId: createId("deployment"),
          hostInstanceId: createId("hostInstance"),
          hostKey: { algorithm: "Ed25519" },
          deploymentShape: { kind: "personal" },
        }),
        runFiles: relay,
      }),
    );
    closing.push(() => app.close());
    return app.listen({ host: "127.0.0.1", port: 0 });
  }

  it("streams one file between two Runners and keeps its name", async () => {
    const relay = new RunFileRelay();
    const handle = relay.open();
    const origin = await serve(relay);
    const url = new URL(runFileTransferPath(handle.upload.id), origin);
    const download = fetch(url, {
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        authorization: `Bearer ${handle.download.token}`,
      },
    });
    const upload = await fetch(url, {
      body: bytes,
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        authorization: `Bearer ${handle.upload.token}`,
        "content-type": runFileTransferContentType,
        [runFileNameHeader]: encodeURIComponent("어머니 사진.heic"),
      },
      method: "PUT",
    });
    const response = await download;
    expect(response.status).toBe(200);
    expect(decodeURIComponent(response.headers.get(runFileNameHeader)!)).toBe("어머니 사진.heic");
    expect(await response.text()).toBe(bytes.toString());
    expect(upload.status).toBe(204);
  });

  it("requires the Runner signature for this connection, request and HTTP direction, then cancels an abandoned GET", async () => {
    const runner = generateKeyPairSync("ed25519");
    const stranger = generateKeyPairSync("ed25519");
    const relay = new RunFileRelay(async (_scope, payload, signature) =>
      verify(null, Buffer.from(payload), runner.publicKey, Buffer.from(signature, "base64url")),
    );
    const binding = {
      ...RunnerConnectionFenceSchema.parse({
        runnerId: createId("runner"),
        bootId: `rbt_${randomUUID()}`,
        connectionId: `rcn_${randomUUID()}`,
        connectionLeaseId: `rls_${randomUUID()}`,
        connectionGeneration: 1,
      }),
      requestId: randomUUID(),
    };
    const connection = new AbortController();
    const handle = relay.open();
    relay.bind(handle.download, "GET", binding, connection.signal);
    const origin = await serve(relay);
    const url = new URL(runFileTransferPath(handle.download.id), origin);
    const proof = (
      scope = binding,
      privateKey = runner.privateKey,
      method: "GET" | "PUT" = "GET",
    ) =>
      sign(
        null,
        Buffer.from(runFileTransferProofPayload(scope, handle.download.id, method)),
        privateKey,
      ).toString("base64url");
    const headers = {
      [hostApiVersionHeader]: String(hostApiVersion),
      authorization: `Bearer ${handle.download.token}`,
    };
    const received = Promise.withResolvers<void>();
    const original = relay.download.bind(relay);
    const canceled = Promise.withResolvers<void>();
    vi.spyOn(relay, "download").mockImplementation(async (...args) => {
      received.resolve();
      try {
        return await original(...args);
      } finally {
        canceled.resolve();
      }
    });
    const httpPeer = new AbortController();
    try {
      for (const signature of [
        "",
        proof(binding, stranger.privateKey),
        proof({ ...binding, requestId: randomUUID() }),
        proof({ ...binding, connectionGeneration: 2 }),
        proof(binding, runner.privateKey, "PUT"),
      ]) {
        const denied = await fetch(url, {
          headers: { ...headers, [runFileProofHeader]: signature },
        });
        expect(denied.status).toBe(403);
      }
      const request = fetch(url, {
        headers: { ...headers, [runFileProofHeader]: proof() },
        signal: httpPeer.signal,
      });
      const failure = expect(request).rejects.toThrow();
      await received.promise;
      httpPeer.abort();
      await failure;
      await canceled.promise;
      const replay = await fetch(url, { headers: { ...headers, [runFileProofHeader]: proof() } });
      expect(replay.status).toBe(403);
    } finally {
      httpPeer.abort();
      connection.abort();
      handle.close();
    }
  });

  it("refuses a token that is not this transfer's", async () => {
    const relay = new RunFileRelay();
    const handle = relay.open();
    const origin = await serve(relay);
    const response = await fetch(new URL(runFileTransferPath(handle.upload.id), origin), {
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        authorization: `Bearer ${"x".repeat(43)}`,
      },
    });
    expect(response.status).toBe(403);
    handle.close();
  });
});
