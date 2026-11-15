import { createHash } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createId, type Sequence } from "@opensteer/core";
import { AttachmentStore, appendHostDeploymentEvent } from "@opensteer/database";
import { createStoreFixture } from "@opensteer/database/test-support/store";
import {
  admitTranscriptFiles,
  resolveThreadOutputImages,
  readThreadOutputImage,
} from "@opensteer/database";
import { TranscriptFileOpenSchema, TranscriptFileContentSchema } from "@opensteer/protocol";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
import {
  AttachmentService,
  RunAttachmentsTokenService,
} from "../attachments/attachment-service.js";
import { AgentHomeFiles } from "./agent-home-files.js";
import { TranscriptFileAccess } from "./transcript-file-access.js";
import { createTranscriptFileServices } from "./transcript-files.js";

async function fixture() {
  const f = await createStoreFixture();
  try {
    const task = await f.createRunFixture("transcript-files");
    const root = await realpath(task.agentHome.path);
    const homePath = join(root, "home"),
      imagesRoot = join(root, "runner/images");
    await mkdir(homePath, { recursive: true });
    await mkdir(imagesRoot, { recursive: true });
    const helperPath = fileURLToPath(
      new URL("../../../runner/native-fs-helper/opensteer-native-fs-test", import.meta.url),
    );
    const home = new AgentHomeFiles({
      agentHome: async () => ({ ...task.agentHome, path: homePath }),
      helperPath,
    });
    const attachments = new AttachmentService({
      dataDirectory: root,
      store: new AttachmentStore(f.database),
      runTokens: new RunAttachmentsTokenService({ authorizer: f.store, tokens: {} as never }),
    });
    const access = new TranscriptFileAccess({
      home,
      attachments,
      imagesRoot,
      helperPath,
      admit: (c) => admitTranscriptFiles(f.database, { ownerId: c.userId, threadId: c.threadId }),
      outputImages: (i) => resolveThreadOutputImages(f.database, i),
      outputImage: (i) => readThreadOutputImage(f.database, i),
    });
    const services = createTranscriptFileServices({
      access,
      dataDirectory: root,
      authSecret: "test-secret",
      deploymentId: task.deploymentId,
      authorizeMedia: async () => true,
    });
    return {
      ...f,
      ...services,
      task,
      root,
      homePath,
      imagesRoot,
      home,
      attachments,
      actor: { userId: task.userId, sessionId: "fixture-session" },
      close: async () => {
        services.close();
        await f.close();
      },
    };
  } catch (e) {
    await f.close();
    throw e;
  }
}
it("admits the personal owner and any supplied thread before touching file storage", async () => {
  const f = await fixture();
  try {
    const resolve = vi.spyOn(f.home, "resolveAbsolutePath");
    const p = join(f.homePath, "note.txt");
    await writeFile(p, "private");
    expect(
      await f.files.open(
        { threadId: null, source: { kind: "path", path: p } },
        { ...f.actor, userId: createId("user") },
      ),
    ).toEqual({ status: "unavailable" });
    expect(
      await f.files.open(
        { threadId: createId("thread"), source: { kind: "path", path: p } },
        f.actor,
      ),
    ).toEqual({ status: "unavailable" });
    expect(resolve).not.toHaveBeenCalled();
    const opened = await f.files.open(
      { threadId: null, source: { kind: "path", path: p } },
      f.actor,
    );
    expect(TranscriptFileOpenSchema.parse(opened)).toMatchObject({
      status: "ok",
      sizeBytes: 7,
      mediaType: "text/plain",
      preview: { kind: "text", text: "private", truncated: false },
    });
    if (opened.status !== "ok") throw Error("Expected file");
    const input = { threadId: null, resource: opened.resource };
    expect(TranscriptFileContentSchema.parse(await f.files.content(input, f.actor))).toMatchObject({
      metadata: { sizeBytes: 7, truncated: false },
    });
    await expect(
      f.files.content(input, { ...f.actor, userId: createId("user") }),
    ).rejects.toMatchObject({ code: "not_found" });
    await writeFile(p, "changed");
    await expect(f.files.content(input, f.actor)).rejects.toMatchObject({ code: "not_found" });
  } finally {
    await f.close();
  }
});
it("reads unbound uploads only through attachment authority and rejects discarded or expired uploads", async () => {
  const f = await fixture();
  try {
    const a = await f.attachments.reserve({
      uploaderId: f.actor.userId,
      idempotencyKey: "preview",
      name: "upload.txt",
      mediaType: "text/plain",
      sizeBytes: 8,
    });
    await f.attachments.upload({
      attachmentId: a.id,
      userId: f.actor.userId,
      body: (async function* () {
        yield Buffer.from("uploaded");
      })(),
    });
    const source = { kind: "attachment", attachmentId: a.id } as const;
    expect(
      await f.files.open({ threadId: null, source }, { ...f.actor, userId: createId("user") }),
    ).toEqual({ status: "unavailable" });
    const result = await f.files.open({ threadId: null, source }, f.actor);
    expect(result).toMatchObject({
      status: "ok",
      resource: { kind: "attachment" },
      preview: { kind: "text", text: "uploaded" },
    });
    if (result.status !== "ok") throw Error("Expected attachment");
    expect(
      Buffer.from(
        (await f.files.content({ threadId: null, resource: result.resource }, f.actor)).bytes,
      ).toString(),
    ).toBe("uploaded");
    const prefix = await f.attachments.previewForUser(a.id, f.actor.userId, 3);
    expect(prefix.bytes.toString()).toBe("upl");
    expect(prefix.metadata.truncated).toBe(true);
    // A bounded prefix must still reject damage later in the original.
    await writeFile(join(f.root, "attachments/originals", a.id), "uploadXX");
    await expect(f.attachments.previewForUser(a.id, f.actor.userId, 3)).rejects.toMatchObject({
      code: "conflict",
    });
    await writeFile(join(f.root, "attachments/originals", a.id), "uploaded");
    await f.database
      .updateTable("attachments")
      .set({ expiresAt: new Date(0) })
      .where("id", "=", a.id)
      .execute();
    expect(await f.files.open({ threadId: null, source }, f.actor)).toEqual({
      status: "unavailable",
    });
    await f.attachments.discard(a.id, f.actor.userId);
    await expect(
      f.files.content({ threadId: null, resource: result.resource }, f.actor),
    ).rejects.toMatchObject({ code: "not_found" });
  } finally {
    await f.close();
  }
});
it("requires exact persisted output provenance for both tool-card paths and final-reply paths", async () => {
  const f = await fixture();
  try {
    const bytes = await sharp({ create: { width: 20, height: 10, channels: 3, background: "red" } })
      .png()
      .toBuffer();
    const p = join(f.imagesRoot, createHash("sha256").update(bytes).digest("hex") + ".png");
    await writeFile(p, bytes);
    const source = { kind: "path", path: p } as const;
    expect(await f.files.open({ threadId: f.task.threadId, source }, f.actor)).toEqual({
      status: "unavailable",
    });
    const event = await f.database.transaction().execute((tx) =>
      appendHostDeploymentEvent(tx, {
        type: "tool.completed",
        environmentId: f.task.environmentId,
        threadId: f.task.threadId,
        runId: null,
        data: {
          callId: "generated",
          isError: false,
          output: {
            text: "generated image",
            images: [{ path: p, mediaType: "image/png", generated: true }],
          },
        },
      }),
    );
    const open = await f.files.open({ threadId: f.task.threadId, source }, f.actor);
    expect(open).toMatchObject({
      status: "ok",
      resource: { kind: "output-image", sequence: event.sequence, index: 0 },
      preview: { kind: "image", image: { status: "ok" } },
    });
    if (open.status !== "ok") throw Error("Expected generated image");
    expect(
      Buffer.from(
        (await f.files.content({ threadId: f.task.threadId, resource: open.resource }, f.actor))
          .bytes,
      ),
    ).toEqual(bytes);
    const urls = await f.assets.urls(
      {
        threadId: f.task.threadId,
        assets: [
          { source, variant: "preview" },
          { source, variant: "original" },
        ],
      },
      f.actor,
    );
    expect(urls.assets.map((a) => a.status)).toEqual(["ok", "ok"]);
    const other = await f.createRunFixture("other-thread");
    expect(await f.files.open({ threadId: other.threadId, source }, f.actor)).toEqual({
      status: "unavailable",
    });
    expect(await f.files.open({ threadId: null, source }, f.actor)).toEqual({
      status: "unavailable",
    });
    await expect(
      f.files.content({ threadId: other.threadId, resource: open.resource }, f.actor),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      f.files.content(
        {
          threadId: f.task.threadId,
          resource: {
            kind: "output-image",
            sequence: event.sequence as Sequence,
            index: 1,
            revision: open.resource.revision,
          },
        },
        f.actor,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await f.database
      .deleteFrom("deploymentEvents")
      .where("sequence", "=", event.sequence)
      .execute();
    await expect(
      f.files.content({ threadId: f.task.threadId, resource: open.resource }, f.actor),
    ).rejects.toMatchObject({ code: "not_found" });
  } finally {
    await f.close();
  }
});
it("returns bounded text, safe image URLs, download-only binary and size-only cap failures", async () => {
  const f = await fixture();
  try {
    const text = join(f.homePath, "large.txt");
    await writeFile(text, Buffer.alloc(512 * 1024 + 10, 97));
    expect(
      await f.files.open({ threadId: null, source: { kind: "path", path: text } }, f.actor),
    ).toMatchObject({ status: "ok", preview: { kind: "text", truncated: true } });
    const binary = join(f.homePath, "binary.dat");
    await writeFile(binary, Buffer.from([0, 1, 2]));
    expect(
      await f.files.open({ threadId: null, source: { kind: "path", path: binary } }, f.actor),
    ).toMatchObject({ status: "ok", preview: { kind: "download" } });
    const { open: openFile } = await import("node:fs/promises");
    const huge = join(f.homePath, "huge.dat");
    const handle = await openFile(huge, "w");
    try {
      await handle.truncate(32 * 1024 * 1024 + 1);
    } finally {
      await handle.close();
    }
    const opened = await f.files.open(
      { threadId: null, source: { kind: "path", path: huge } },
      f.actor,
    );
    expect(opened).toMatchObject({
      status: "ok",
      sizeBytes: 32 * 1024 * 1024 + 1,
      preview: { kind: "download" },
    });
    if (opened.status !== "ok") throw Error("Expected huge metadata");
    await expect(
      f.files.content({ threadId: null, resource: opened.resource }, f.actor),
    ).rejects.toMatchObject({
      code: "resource_exhausted",
      reason: "file-too-large",
      details: { sizeBytes: 32 * 1024 * 1024 + 1 },
    });
  } finally {
    await f.close();
  }
});
