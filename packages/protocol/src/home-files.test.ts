import { randomUUID } from "node:crypto";
import { createId } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import {
  HostHomeFileRequestSchema,
  HostOutputImageUploadSchema,
  RunnerAgentHomeReportSchema,
  RunnerHomeFileResultSchema,
  RunnerOutputImagePublishSchema,
  decodeHomeFileExportBundle,
  encodeHomeFileExportBundle,
} from "./home-files.js";
import { HostToRunnerMessageSchema, RunnerOperationalMessageSchema } from "./runner.js";

const fence = {
  bootId: `rbt_${randomUUID()}`,
  connectionGeneration: 1,
  connectionId: `rcn_${randomUUID()}`,
  connectionLeaseId: `rls_${randomUUID()}`,
  runnerId: createId("runner"),
};
const revision = "a".repeat(43);

describe("home-files protocol", () => {
  it("validates fenced agent-home report and home-file requests through the runner union", () => {
    const report = RunnerOperationalMessageSchema.parse({
      ...fence,
      environmentId: createId("environment"),
      path: "/Users/alice/Opensteer",
      rootIdentity: { fileId: "42", kind: "posix", volumeId: "1" },
      type: "runner.agent-home.report",
    });
    expect(RunnerAgentHomeReportSchema.parse(report).path).toBe("/Users/alice/Opensteer");

    const requests = [
      {
        ...fence,
        limit: 500,
        offset: 0,
        pathSegmentsBase64: [],
        requestId: randomUUID(),
        type: "host.home-files.list",
      },
      {
        ...fence,
        expectedFileRevision: revision,
        expectedRootScope: revision,
        maxBytes: 512 * 1_024,
        offset: 0,
        pathSegmentsBase64: [Buffer.from("note.txt").toString("base64url")],
        requestId: randomUUID(),
        type: "host.home-files.read",
      },
      {
        ...fence,
        allowRelative: true,
        allowTilde: true,
        path: "~/Opensteer/note.txt",
        requestId: randomUUID(),
        type: "host.home-files.resolve",
      },
      {
        ...fence,
        maxBytes: 32 * 1_024 * 1_024,
        pathSegmentsBase64: [Buffer.from("note.txt").toString("base64url")],
        requestId: randomUUID(),
        transfer: { id: randomUUID(), token: "t".repeat(43) },
        type: "host.home-files.download",
      },
      {
        ...fence,
        directory: "plugins/sample",
        maxBytes: 24 * 1_024 * 1_024,
        requestId: randomUUID(),
        transfer: { id: randomUUID(), token: "t".repeat(43) },
        type: "host.home-files.write",
      },
      {
        ...fence,
        requestId: randomUUID(),
        type: "host.home-files.cancel",
      },
    ] as const;

    for (const request of requests) {
      expect(HostHomeFileRequestSchema.parse(request)).toEqual(request);
      expect(HostToRunnerMessageSchema.parse(request)).toEqual(request);
    }
  });

  it("limits the request accepted by the Runner", () => {
    const base = { ...fence, requestId: randomUUID(), pathSegmentsBase64: ["ZmlsZQ"] };
    for (const request of [
      { ...base, type: "host.home-files.list", offset: 0, limit: 501 },
      { ...base, type: "host.home-files.read", offset: 0, maxBytes: 512 * 1024 + 1 },
      {
        ...base,
        type: "host.home-files.download",
        maxBytes: 32 * 1024 * 1024 + 1,
        transfer: { id: randomUUID(), token: "t".repeat(43) },
      },
      {
        ...fence,
        requestId: randomUUID(),
        type: "host.home-files.write",
        directory: "export",
        maxBytes: 24 * 1024 * 1024 + 1,
        transfer: { id: randomUUID(), token: "t".repeat(43) },
      },
    ]) {
      expect(HostToRunnerMessageSchema.safeParse(request).success).toBe(false);
    }
  });

  it("enforces result invariants and bounds on home-files and output-image frames", () => {
    const requestId = randomUUID();
    expect(
      RunnerHomeFileResultSchema.safeParse({
        ...fence,
        ok: true,
        requestId,
        type: "runner.home-files.result",
      }).success,
    ).toBe(false);
    expect(
      RunnerHomeFileResultSchema.safeParse({
        ...fence,
        ok: false,
        requestId,
        type: "runner.home-files.result",
      }).success,
    ).toBe(false);

    const readResult = RunnerOperationalMessageSchema.parse({
      ...fence,
      data: {
        bytesRead: 5,
        contentBase64: Buffer.from("hello").toString("base64"),
        eof: true,
        kind: "read",
        metadata: {
          mode: 0o644,
          modifiedAt: "2026-01-01T00:00:00.000Z",
          revision,
          sizeBytes: 5,
        },
        offset: 0,
        rootScope: revision,
      },
      ok: true,
      requestId,
      type: "runner.home-files.result",
    });
    expect(RunnerHomeFileResultSchema.parse(readResult).ok).toBe(true);

    const publish = RunnerOutputImagePublishSchema.parse({
      ...fence,
      extension: "png",
      mediaType: "image/png",
      requestId,
      sha256: "a".repeat(64),
      sizeBytes: 128,
      type: "runner.output-image.publish",
    });
    expect(RunnerOperationalMessageSchema.parse(publish)).toEqual(publish);

    expect(
      HostOutputImageUploadSchema.safeParse({
        ...fence,
        requestId,
        status: "upload",
        type: "host.output-image.upload",
      }).success,
    ).toBe(false);

    const upload = HostToRunnerMessageSchema.parse({
      ...fence,
      requestId,
      status: "upload",
      transfer: { id: randomUUID(), token: "t".repeat(43) },
      type: "host.output-image.upload",
    });
    expect(HostOutputImageUploadSchema.parse(upload).status).toBe("upload");
  });

  it("round-trips and bounds export bundles", () => {
    const encoded = encodeHomeFileExportBundle({
      directory: "plugins/demo",
      files: [
        { bytes: new TextEncoder().encode("console.log('hi');"), path: "index.ts" },
        { bytes: new Uint8Array([0, 1, 2, 255]), path: "assets/bin.dat" },
      ],
    });
    const decoded = decodeHomeFileExportBundle(encoded);
    expect(decoded.directory).toBe("plugins/demo");
    expect(decoded.files.map((file) => file.path)).toEqual(["index.ts", "assets/bin.dat"]);
    expect(Buffer.from(decoded.files[0]!.bytes).toString("utf8")).toBe("console.log('hi');");
    expect([...decoded.files[1]!.bytes]).toEqual([0, 1, 2, 255]);

    expect(() =>
      encodeHomeFileExportBundle({
        directory: "plugins/big",
        files: [{ bytes: new Uint8Array(11), path: "a.bin" }],
        maxBytes: 10,
      }),
    ).toThrow(/10 byte limit/);
    expect(() => decodeHomeFileExportBundle(encoded.subarray(0, encoded.byteLength - 1))).toThrow(
      /truncated/,
    );
    expect(() => decodeHomeFileExportBundle(new Uint8Array([...encoded, 0]))).toThrow(
      /trailing bytes/,
    );
  });
});
