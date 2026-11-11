import { createId } from "@opensteer/core";
import {
  teamApiVersion,
  teamApiVersionHeader,
  hostApiVersionHeader,
} from "@opensteer/deployment-authority";
import { TeamFileSchema } from "@opensteer/protocol";
import type { HostTransport, HostTransportRequest } from "../connections/host-transport.js";
import { expect, it } from "vitest";
import { teamFileTransport } from "./files.js";
import { mockTeamId, mockTeamUserId, mockTeamChannelId } from "./mock-team-host.js";

it("carries preview and original bytes through the pinned session with the team version", async () => {
  const file = TeamFileSchema.parse({
    id: createId("teamBlob"),
    channelId: mockTeamChannelId,
    filename: "hello.txt",
    mediaType: "text/plain",
    sizeBytes: 8,
    sha256: "a".repeat(64),
    preview: { mediaType: "image/png", sizeBytes: 7 },
  });
  const requests: HostTransportRequest[] = [];
  const transport: Pick<HostTransport, "exchange"> = {
    exchange: async (request, read) => {
      requests.push(request);
      const upload = request.method === "POST";
      const response = upload
        ? Response.json(file)
        : new Response(request.path.endsWith("preview") ? "PREVIEW" : "ORIGINAL", {
            headers: {
              "content-type": request.path.endsWith("preview")
                ? "image/png"
                : "application/octet-stream",
            },
          });
      return read(response, { signal: new AbortController().signal, onProgress: () => {} });
    },
  };
  const files = teamFileTransport(transport, {
    teamDeploymentId: mockTeamId,
    userId: mockTeamUserId,
  });
  expect(await (await files.readFile(file, "preview")).text()).toBe("PREVIEW");
  expect(await (await files.readFile(file, "original")).text()).toBe("ORIGINAL");
  const metadata = {
    clientUploadId: crypto.randomUUID(),
    filename: file.filename,
    mediaType: file.mediaType,
    sizeBytes: 8,
    sha256: file.sha256,
    previewSizeBytes: 7,
  };
  expect(
    await files.uploadFile({
      channelId: mockTeamChannelId,
      original: new Blob(["ORIGINAL"]),
      preview: new Blob(["PREVIEW"]),
      metadata,
    }),
  ).toEqual(file);
  const upload = requests[2]!;
  expect(upload.path).toBe(`/v1/team/files/upload/${mockTeamChannelId}`);
  expect(upload.headers.contentType).toBe("application/octet-stream");
  expect(upload.headers.additional?.["x-opensteer-team-upload"]).toBe(JSON.stringify(metadata));
  expect(upload.body).toBeInstanceOf(Blob);
  expect(await (upload.body as Blob).text()).toBe("ORIGINALPREVIEW");
  for (const request of requests) {
    expect(request.expectedDeploymentId).toBe(mockTeamId);
    expect(request.headers.additional?.[teamApiVersionHeader]).toBe(String(teamApiVersion));
    expect(request.headers.additional).not.toHaveProperty(hostApiVersionHeader);
    expect(request.path).not.toContain("token");
  }
});
it("rejects a changed file size and refuses an upload with missing preview bytes before sending", async () => {
  let reads = 0;
  const transport: Pick<HostTransport, "exchange"> = {
    exchange: async (_, read) => {
      reads++;
      return read(new Response("bad", { headers: { "content-type": "image/png" } }), {
        signal: new AbortController().signal,
        onProgress: () => {},
      });
    },
  };
  const files = teamFileTransport(transport, {
    teamDeploymentId: mockTeamId,
    userId: mockTeamUserId,
  });
  const file = TeamFileSchema.parse({
    id: createId("teamBlob"),
    channelId: mockTeamChannelId,
    filename: "photo.png",
    mediaType: "image/png",
    sizeBytes: 5,
    sha256: "a".repeat(64),
    preview: { mediaType: "image/png", sizeBytes: 5 },
  });
  await expect(files.readFile(file, "preview")).rejects.toThrow("size changed");
  await expect(
    files.uploadFile({
      channelId: mockTeamChannelId,
      original: new Blob(["photo"]),
      preview: null,
      metadata: {
        clientUploadId: crypto.randomUUID(),
        filename: file.filename,
        mediaType: file.mediaType,
        sizeBytes: 5,
        sha256: file.sha256,
        previewSizeBytes: 5,
      },
    }),
  ).rejects.toThrow("sizes do not match");
  expect(reads).toBe(1);
});
