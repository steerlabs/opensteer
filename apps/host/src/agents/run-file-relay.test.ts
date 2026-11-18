import { hostApiVersion, hostApiVersionHeader } from "@opensteer/deployment-authority";
import { Readable } from "node:stream";
import { createId } from "@opensteer/core";
import { generateKeyPairSync } from "node:crypto";
import {
  runFileNameHeader,
  runFileTransferContentType,
  runFileTransferPath,
} from "@opensteer/protocol";
import { afterEach, describe, expect, it } from "vitest";
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
