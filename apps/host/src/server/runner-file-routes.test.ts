import { generateKeyPairSync } from "node:crypto";
import { createId, OpensteerError } from "@opensteer/core";
import {
  hostApiCurrentHeader,
  hostApiVersionHeader,
  minimumHostApiVersion,
} from "@opensteer/deployment-authority";
import {
  runFileNameHeader,
  runFileTransferContentType,
  runFileTransferPath,
} from "@opensteer/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { RunFileRelay } from "../agents/run-file-relay.js";
import { signHostDiscovery } from "../identity/host-keys.js";
import { createHostServer, type HostServerDependencies } from "../server.js";
import { hostServerTestDependencies } from "./host-server-test-harness.js";

/** What a released Runner of the previous API epoch states on every request. */
const previousEpoch = {
  [hostApiVersionHeader]: String(minimumHostApiVersion - 1),
  [hostApiCurrentHeader]: String(minimumHostApiVersion - 1),
};
const runToken = "run-capability-token";
const attachmentId = "att_11111111-1111-4111-8111-111111111111";
const bytes = Buffer.from("the attachment's exact bytes");

/** Stands in for the run-token check the attachment service makes. */
const attachments = {
  listForRun: async (token: string) => {
    if (token !== runToken)
      throw new OpensteerError({ code: "unauthorized", message: "Run token is invalid" });
    return { attachments: [], nextCursor: null };
  },
  contentForRun: async (token: string) => {
    if (token !== runToken)
      throw new OpensteerError({ code: "unauthorized", message: "Run token is invalid" });
    return {
      bytes,
      metadata: { contentType: "text/plain", etag: '"a"' },
    };
  },
} as unknown as HostServerDependencies["attachments"];

describe("a Runner's file routes", () => {
  const closing: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    await Promise.all(closing.splice(0).map((close) => close()));
  });

  async function serve(relay: RunFileRelay): Promise<string> {
    const app = await createHostServer(
      hostServerTestDependencies({
        attachments,
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

  it("serves a Runner that states the previous API epoch with its run token", async () => {
    const relay = new RunFileRelay();
    const origin = await serve(relay);
    const authorization = { authorization: `Bearer ${runToken}` };

    const list = await fetch(new URL("/v1/runner/attachments", origin), {
      headers: { ...previousEpoch, ...authorization },
    });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ attachments: [], nextCursor: null });

    const content = await fetch(new URL(`/v1/runner/attachments/${attachmentId}/content`, origin), {
      headers: { ...previousEpoch, ...authorization },
    });
    expect(content.status).toBe(200);
    expect(await content.text()).toBe(bytes.toString());

    const handle = relay.open();
    const url = new URL(runFileTransferPath(handle.upload.id), origin);
    const download = fetch(url, {
      headers: { ...previousEpoch, authorization: `Bearer ${handle.download.token}` },
    });
    const upload = await fetch(url, {
      body: bytes,
      headers: {
        ...previousEpoch,
        authorization: `Bearer ${handle.upload.token}`,
        "content-type": runFileTransferContentType,
        [runFileNameHeader]: encodeURIComponent("photo.heic"),
      },
      method: "PUT",
    });
    const downloaded = await download;
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toBe(bytes.toString());
    expect(upload.status).toBe(204);
    handle.close();

    // The same epoch is still refused on a route that is not the Runner's own.
    const other = await fetch(new URL("/v1/auth/session", origin), { headers: previousEpoch });
    expect(other.status).toBe(400);
    expect(await other.json()).toMatchObject({ error: { reason: "unsupported-version" } });
  });

  it("still refuses each of them without the run token", async () => {
    const relay = new RunFileRelay();
    const origin = await serve(relay);
    const handle = relay.open();
    const refusals = await Promise.all([
      fetch(new URL("/v1/runner/attachments", origin), { headers: previousEpoch }),
      fetch(new URL(`/v1/runner/attachments/${attachmentId}/content`, origin), {
        headers: previousEpoch,
      }),
      fetch(new URL(runFileTransferPath(handle.upload.id), origin), {
        body: bytes,
        headers: {
          ...previousEpoch,
          "content-type": runFileTransferContentType,
          [runFileNameHeader]: encodeURIComponent("photo.heic"),
        },
        method: "PUT",
      }),
      fetch(new URL(runFileTransferPath(handle.download.id), origin), { headers: previousEpoch }),
      fetch(new URL("/v1/runner/attachments", origin), {
        headers: { ...previousEpoch, authorization: "Bearer someone-elses-token" },
      }),
    ]);
    expect(refusals.map(({ status }) => status)).toEqual([401, 401, 401, 401, 401]);
    handle.close();
  });
});
