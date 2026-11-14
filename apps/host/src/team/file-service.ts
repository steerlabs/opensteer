import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { TeamActor, TeamAgentRequestId, TeamBlobId, TeamChannelId } from "@opensteer/core";
import type { TeamUploadMetadataSchema } from "@opensteer/protocol";
import { teamPreviewMaxBytes, teamUploadMaxBytes } from "@opensteer/protocol";
import { TeamFilesStore, type TeamFileAgent } from "@opensteer/database/team-files";
import { requireTeam, type TeamAccessStore } from "@opensteer/database/team-access";
import type { z } from "zod";
import sharp from "sharp";

interface ActiveFileTransfer {
  readonly actor: TeamActor;
  readonly channelId: TeamChannelId;
  readonly requestId?: TeamAgentRequestId;
  readonly controller: AbortController;
  readonly authorize: () => Promise<boolean>;
}
type FileRow = Awaited<ReturnType<TeamFilesStore["authorized"]>>;
export interface TeamRemoteFiles {
  download(
    row: FileRow,
    part: "original" | "preview",
    signal: AbortSignal,
    authorize: () => Promise<boolean>,
  ): Promise<Uint8Array>;
}
async function verifiedTeamPreview(input: string | Buffer) {
  const info = await sharp(input, { limitInputPixels: 1024 * 1024 })
    .metadata()
    .catch(() => {
      requireTeam(false, "Invalid image preview");
    });
  requireTeam(
    info.width &&
      info.height &&
      info.width <= 1024 &&
      info.height <= 1024 &&
      ["jpeg", "png", "webp"].includes(info.format ?? ""),
    "Invalid image preview",
  );
  return info.format === "jpeg" ? "image/jpeg" : info.format === "png" ? "image/png" : "image/webp";
}
export class TeamFileService {
  remote: TeamRemoteFiles | undefined;
  readonly #directory: string;
  readonly #active = new Set<ActiveFileTransfer>();
  readonly #uploads = new Set<TeamBlobId>();
  readonly #unsubscribe: () => void;
  readonly store: TeamFilesStore;
  readonly access: TeamAccessStore;
  constructor(store: TeamFilesStore, access: TeamAccessStore, dataDirectory: string) {
    this.store = store;
    this.access = access;
    this.#directory = join(dataDirectory, "team-files");
    this.#unsubscribe = access.onRevoke(async (effects) => {
      await Promise.all(
        [...this.#active].map(async (transfer) => {
          try {
            if (!effects.users.includes(transfer.actor.userId) && (await transfer.authorize()))
              return;
          } catch {}
          transfer.controller.abort(new Error("Team file access revoked"));
          this.#active.delete(transfer);
        }),
      );
    });
  }
  async upload(
    actor: TeamActor,
    channelId: TeamChannelId,
    metadata: z.infer<typeof TeamUploadMetadataSchema>,
    parts: { original: AsyncIterable<Uint8Array>; preview?: AsyncIterable<Uint8Array> },
    requestId?: TeamAgentRequestId,
    signal?: AbortSignal,
    agent?: TeamFileAgent,
  ) {
    const row = await this.store.begin(actor, channelId, metadata, requestId, agent);
    requireTeam(row.state !== "deleting");
    requireTeam(!this.#uploads.has(row.id), "Upload already in progress");
    this.#uploads.add(row.id);
    const controller = new AbortController();
    const authorize = () =>
      this.access.database.transaction().execute(async (t) => {
        if (!(await this.access.channel(t, actor, channelId)).post) return false;
        if (actor.kind === "agent") {
          requireTeam(agent);
          await this.access.link(t, actor, agent.linkId);
        }
        return true;
      });
    const transfer: ActiveFileTransfer = {
      actor,
      channelId,
      controller,
      authorize,
      ...(requestId ? { requestId } : {}),
    };
    this.#active.add(transfer);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const pending = join(this.#directory, `pending-${randomUUID()}`);
    const pendingPreview = `${pending}-preview`;
    const final = join(this.#directory, row.storageKey),
      previewFinal = `${final}-preview`;
    let installed = false;
    try {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const original = await this.#write(
        pending,
        parts.original,
        metadata.sizeBytes,
        teamUploadMaxBytes,
        combined,
      );
      let previewMediaType: "image/jpeg" | "image/png" | "image/webp" | null = null;
      let previewSha256: string | null = null;
      if (metadata.previewSizeBytes) {
        requireTeam(
          parts.preview && metadata.mediaType.startsWith("image/"),
          "Image preview required",
        );
        const preview = await this.#write(
          pendingPreview,
          parts.preview,
          metadata.previewSizeBytes,
          teamPreviewMaxBytes,
          combined,
        );
        previewSha256 = preview.sha256;
        previewMediaType = await verifiedTeamPreview(pendingPreview);
      } else requireTeam(!parts.preview, "Unexpected preview");
      combined.throwIfAborted();
      requireTeam(await authorize());
      try {
        await link(pending, final);
        installed = true;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
      if (metadata.previewSizeBytes)
        try {
          await link(pendingPreview, previewFinal);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        }
      return await this.store.complete(actor, row.id, {
        receivedBytes: original.size,
        sha256: original.sha256,
        verifiedType: metadata.mediaType,
        previewSizeBytes: metadata.previewSizeBytes,
        previewMediaType,
        previewSha256,
        previewStorageKey: metadata.previewSizeBytes ? `${row.storageKey}-preview` : null,
      });
    } catch (error) {
      if (installed) {
        await rm(final, { force: true });
        await rm(previewFinal, { force: true });
      }
      throw error;
    } finally {
      this.#uploads.delete(row.id);
      this.#active.delete(transfer);
      await rm(pending, { force: true });
      await rm(pendingPreview, { force: true });
    }
  }
  async #write(
    path: string,
    body: AsyncIterable<Uint8Array>,
    expected: number,
    maximum: number,
    signal: AbortSignal,
  ) {
    const file = await open(path, "wx", 0o600);
    const hash = createHash("sha256");
    let size = 0;
    const iterator = body[Symbol.asyncIterator]();
    const cancelled = Promise.withResolvers<never>();
    const abort = () => {
      cancelled.reject(signal.reason ?? new Error("Upload cancelled"));
      if (body instanceof Readable) body.destroy();
    };
    try {
      signal.throwIfAborted();
      signal.addEventListener("abort", abort, { once: true });
      for (;;) {
        const next = await Promise.race([iterator.next(), cancelled.promise]);
        if (next.done) break;
        const chunk = next.value;
        signal.throwIfAborted();
        size += chunk.byteLength;
        requireTeam(size <= expected && size <= maximum, "Upload exceeds fixed byte limit");
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
          requireTeam(bytesWritten > 0);
          offset += bytesWritten;
        }
      }
      requireTeam(size === expected, "Upload size mismatch");
      await file.sync();
      return { size, sha256: hash.digest("hex") };
    } finally {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) void iterator.return?.().catch(() => {});
      await file.close();
    }
  }
  async download(
    actor: TeamActor,
    id: TeamBlobId,
    part: "original" | "preview",
    requestId?: TeamAgentRequestId,
    signal?: AbortSignal,
    agent?: TeamFileAgent,
  ): Promise<{ body: Readable; sizeBytes: number; headers: Record<string, string> }> {
    const revision = this.access.revision;
    const row = await this.store.authorized(actor, id, agent, true);
    requireTeam(part === "original" || row.previewStorageKey, "No image preview");
    const controller = new AbortController();
    let stream: Readable | undefined;
    const transfer: ActiveFileTransfer = {
      actor,
      channelId: row.channelId,
      ...(requestId ? { requestId } : {}),
      controller,
      authorize: async () => {
        await this.store.authorized(actor, id, agent);
        return true;
      },
    };
    this.#active.add(transfer);
    try {
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const bytes = row.remoteShareId
        ? await this.remote?.download(row, part, combined, transfer.authorize)
        : undefined;
      if (row.remoteShareId) requireTeam(bytes, "Partner file transfer unavailable");
      if (bytes && part === "preview")
        requireTeam(
          (await verifiedTeamPreview(Buffer.from(bytes))) === row.previewMediaType,
          "Invalid image preview",
        );
      // A message deletion during the partner fetch need not change the access revision.
      if (row.remoteShareId) await transfer.authorize();
      return await this.access.handoff(revision, transfer.authorize, () => {
        combined.throwIfAborted();
        stream = bytes
          ? Readable.from(
              (function* () {
                for (let offset = 0; offset < bytes.length; offset += 64 * 1024)
                  yield bytes.subarray(offset, offset + 64 * 1024);
              })(),
              { signal: combined },
            )
          : createReadStream(
              join(this.#directory, part === "original" ? row.storageKey : row.previewStorageKey!),
              {
                highWaterMark: 64 * 1024,
                signal: combined,
              },
            );
        stream.once("close", () => {
          controller.abort();
          this.#active.delete(transfer);
        });
        return {
          body: stream,
          sizeBytes: part === "original" ? Number(row.sizeBytes) : Number(row.previewSizeBytes),
          headers: {
            "content-type":
              part === "original" ? "application/octet-stream" : row.previewMediaType!,
            "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`,
            "x-content-type-options": "nosniff",
            "content-security-policy": "sandbox",
            "cache-control": "private, no-store",
          },
        };
      });
    } catch (error) {
      controller.abort();
      stream?.destroy();
      this.#active.delete(transfer);
      throw error;
    }
  }
  async prepareShare(channelId: TeamChannelId) {
    const rows = await this.access.database
      .selectFrom("teamBlobs")
      .selectAll()
      .where("channelId", "=", channelId)
      .where("remoteShareId", "is", null)
      .where("state", "=", "ready")
      .where("previewStorageKey", "is not", null)
      .where("previewSha256", "is", null)
      .execute();
    for (const row of rows) {
      const bytes = await readFile(join(this.#directory, row.previewStorageKey!));
      requireTeam(
        bytes.length === Number(row.previewSizeBytes) && bytes.length <= teamPreviewMaxBytes,
      );
      await this.access.database
        .updateTable("teamBlobs")
        .set({ previewSha256: createHash("sha256").update(bytes).digest("hex") })
        .where("id", "=", row.id)
        .execute();
    }
  }
  async readPartnerChunk(
    row: FileRow | Awaited<ReturnType<TeamFilesStore["begin"]>>,
    part: "original" | "preview",
    offset: number,
    maximum: number,
  ) {
    const key = part === "original" ? row.storageKey : row.previewStorageKey;
    requireTeam(key);
    const file = await open(join(this.#directory, key), "r");
    try {
      const size = Number(part === "original" ? row.sizeBytes : row.previewSizeBytes);
      requireTeam(offset <= size);
      const bytes = Buffer.alloc(Math.min(maximum, size - offset));
      const { bytesRead } = await file.read(bytes, 0, bytes.length, offset);
      requireTeam(bytesRead === bytes.length, "File size mismatch");
      return bytes.toString("base64");
    } finally {
      await file.close();
    }
  }
  /** Removes every file no message can reach, so freed space counts again once this returns. */
  async collectGarbage() {
    await this.store.abandonUnsent();
    for (;;) {
      const rows = await this.access.database
        .selectFrom("teamBlobs")
        .selectAll()
        .where("state", "=", "deleting")
        .orderBy("id")
        .limit(100)
        .execute();
      for (const row of rows) {
        // Re-shared local files keep their bytes until the last channel releases them.
        const retained = await this.access.database
          .selectFrom("teamBlobs")
          .select("id")
          .where("storageKey", "=", row.storageKey)
          .where("id", "!=", row.id)
          .where("state", "!=", "deleting")
          .executeTakeFirst();
        if (!retained) {
          await rm(join(this.#directory, row.storageKey), { force: true });
          if (row.previewStorageKey)
            await rm(join(this.#directory, row.previewStorageKey), { force: true });
        }
        await this.access.database
          .deleteFrom("teamBlobs")
          .where("id", "=", row.id)
          .where("state", "=", "deleting")
          .execute();
      }
      if (rows.length < 100) break;
    }
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.#directory))
      if (/^pending-[0-9a-f-]{36}(-preview)?$/.test(name)) {
        const path = join(this.#directory, name);
        if ((await stat(path)).mtimeMs < Date.now() - 86400000) await rm(path, { force: true });
      }
  }
  close() {
    this.#unsubscribe();
    for (const transfer of this.#active) transfer.controller.abort();
    this.#active.clear();
  }
}
