import { sql } from "kysely";
import { LocalTeamFileStore, type TeamFileStore } from "./file-store.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { TeamActor, TeamAgentRequestId, TeamBlobId, TeamChannelId } from "@opensteer/core";
import type { TeamUploadMetadataSchema } from "@opensteer/protocol";
import { teamPreviewMaxBytes, teamUploadMaxBytes } from "@opensteer/protocol";
import { TeamFilesStore, teamFileView, type TeamFileAgent } from "@opensteer/database/team-files";
import { shareNotFound } from "@opensteer/database/team-shares";
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
  ): AsyncIterable<Uint8Array>;
}
interface CachedFileTransfer {
  readonly id: TeamBlobId;
  readonly controller: AbortController;
  readonly consumers: Set<ActiveFileTransfer>;
  done: Promise<void>;
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
  readonly #caching = new Map<string, CachedFileTransfer>();
  readonly files: TeamFileStore;
  readonly #unsubscribe: () => void;
  readonly store: TeamFilesStore;
  readonly access: TeamAccessStore;
  constructor(
    store: TeamFilesStore,
    access: TeamAccessStore,
    dataDirectory: string,
    files?: TeamFileStore,
  ) {
    this.store = store;
    this.access = access;
    this.#directory = join(dataDirectory, "team-files");
    this.files = files ?? new LocalTeamFileStore(this.#directory);
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
      await this.collectGarbage();
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
    const begun = await this.store.begin(actor, channelId, metadata, requestId, agent);
    if (begun.state === "ready") return teamFileView(begun);
    const row = await this.store.claimUpload(begun.id, (old) => this.#removeRow(old));
    const controller = new AbortController();
    const authorize = () =>
      this.access.database.transaction().execute(async (t) => {
        if (!(await this.access.peerChannel(t, actor, channelId)).post) return false;
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
    let generation: string | undefined;
    let previewGeneration: string | undefined;
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
      requireTeam(original.sha256 === metadata.sha256, "File digest mismatch");
      generation = await this.files.put(row.storageKey, pending);
      if (metadata.previewSizeBytes)
        previewGeneration = await this.files.put(`${row.storageKey}-preview`, pendingPreview);
      return await this.store.complete(actor, row.id, {
        uploadLease: row.uploadLease!,
        generation,
        previewGeneration: previewGeneration ?? null,
        receivedBytes: original.size,
        sha256: original.sha256,
        verifiedType: metadata.mediaType,
        previewSizeBytes: metadata.previewSizeBytes,
        previewMediaType,
        previewSha256,
        previewStorageKey: metadata.previewSizeBytes ? `${row.storageKey}-preview` : null,
      });
    } catch (error) {
      if (generation) await this.files.delete(row.storageKey, generation);
      if (previewGeneration)
        await this.files.delete(`${row.storageKey}-preview`, previewGeneration);
      await this.store.releaseUpload(row.id, row.uploadLease!);
      throw error;
    } finally {
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
    const revision = await this.access.current();
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
      if (row.remoteShareId) await this.#cached(row, part, transfer, combined);
      // A message deletion during the partner fetch need not change the access revision.
      if (row.remoteShareId) await transfer.authorize();
      return await this.access.handoff(revision, transfer.authorize, () => {
        combined.throwIfAborted();
        stream = this.files.read(part === "original" ? row.storageKey : row.previewStorageKey!, {
          signal: combined,
        });
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
  async #cached(
    row: FileRow,
    part: "original" | "preview",
    consumer: ActiveFileTransfer,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const key = `${row.id}:${part}`;
    let transfer = this.#caching.get(key);
    if (!transfer) {
      transfer = {
        id: row.id,
        controller: new AbortController(),
        consumers: new Set(),
        done: Promise.resolve(),
      };
      this.#caching.set(key, transfer);
      const shared = transfer;
      transfer.consumers.add(consumer);
      transfer.done = this.#cache(row, part, transfer).finally(() => {
        if (this.#caching.get(key) === shared) this.#caching.delete(key);
      });
    } else transfer.consumers.add(consumer);
    const cancelled = Promise.withResolvers<never>();
    const abort = () => {
      transfer.consumers.delete(consumer);
      if (!transfer.consumers.size) transfer.controller.abort(signal.reason);
      cancelled.reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      await Promise.race([transfer.done, cancelled.promise]);
      signal.throwIfAborted();
    } finally {
      signal.removeEventListener("abort", abort);
      transfer.consumers.delete(consumer);
      if (!transfer.consumers.size) {
        transfer.controller.abort();
        await transfer.done.catch(() => {});
      }
    }
  }
  async #cache(row: FileRow, part: "original" | "preview", transfer: CachedFileTransfer) {
    const key = part === "original" ? row.storageKey : row.previewStorageKey!;
    const column = part === "original" ? "generation" : "previewGeneration";
    const cached = await this.store.cacheWrite(row.id, async (_t, current) => current[column]);
    if (cached) return;
    // Bytes at the final key were verified before they were published (or cached before
    // generations were recorded): adopt them rather than delete and fetch them again.
    for await (const object of this.files.list(key))
      if (object.key === key) {
        await this.store.cacheWrite(row.id, async (t, current) => {
          if (!current[column])
            await t
              .updateTable("teamBlobs")
              .set({ [column]: object.generation })
              .where("id", "=", row.id)
              .execute();
        });
        return;
      }
    requireTeam(this.remote, "Partner file transfer unavailable");
    const signal = transfer.controller.signal;
    const authorize = async () => {
      for (const consumer of transfer.consumers) {
        if (consumer.controller.signal.aborted) continue;
        try {
          if (await consumer.authorize()) return true;
        } catch {}
      }
      shareNotFound();
    };
    const pending = join(this.#directory, `pending-${randomUUID()}`);
    let generation: string | undefined;
    let complete = false;
    let lease: string | undefined;
    try {
      lease = await this.store.reserveCache(row.id, part, async (old, expiredPart) => {
        const expiredKey = expiredPart === "original" ? old.storageKey : old.previewStorageKey!;
        for await (const object of this.files.list(expiredKey))
          if (object.key === expiredKey) await this.files.delete(object.key, object.generation);
      });
      signal.throwIfAborted();
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const size = Number(part === "original" ? row.sizeBytes : row.previewSizeBytes);
      const written = await this.#write(
        pending,
        this.remote.download(row, part, signal, authorize),
        size,
        part === "original" ? teamUploadMaxBytes : teamPreviewMaxBytes,
        signal,
      );
      if (
        written.size !== size ||
        written.sha256 !== (part === "original" ? row.sha256 : row.previewSha256)
      )
        shareNotFound();
      if (part === "preview" && (await verifiedTeamPreview(pending)) !== row.previewMediaType)
        shareNotFound();
      signal.throwIfAborted();
      await authorize();
      await this.store.cacheWrite(row.id, async (t, current) => {
        signal.throwIfAborted();
        requireTeam(lease && this.store.cacheLeaseValid(current, lease), "Cache lease expired");
        if (current[column]) return;
        generation = await this.files.put(key, pending);
        await t
          .updateTable("teamBlobs")
          .set({ [column]: generation })
          .where("id", "=", row.id)
          .execute();
      });
      // Committed state now references the object; a late cancellation must not delete it.
      complete = true;
      signal.throwIfAborted();
    } finally {
      if (!complete && generation) await this.files.delete(key, generation);
      await rm(pending, { force: true });
      if (lease) await this.store.releaseCache(row.id, part, lease);
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
      const bytes = await this.#readBytes(row.previewStorageKey!, teamPreviewMaxBytes);
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
    const size = Number(part === "original" ? row.sizeBytes : row.previewSizeBytes);
    requireTeam(offset <= size);
    if (offset === size) return "";
    const bytes = await this.#readBytes(key, Math.min(maximum, size - offset), offset);
    return bytes.toString("base64");
  }
  async #readBytes(key: string, maximum: number, start = 0) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of this.files.read(key, { start, end: start + maximum - 1 })) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      requireTeam(size <= maximum);
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  }
  /** Removes every file no message can reach, so freed space counts again once this returns. */
  async collectGarbage() {
    await Promise.all(
      [...this.#caching.values()].map(async (transfer) => {
        try {
          await this.store.cacheWrite(transfer.id, async () => {});
        } catch {
          transfer.controller.abort(new Error("Team file access revoked"));
        }
        if (transfer.controller.signal.aborted) await transfer.done.catch(() => {});
      }),
    );
    await this.store.evictInactiveCaches((row) => this.#removeRow(row));
    await this.store.abandonUnsent();
    while ((await this.store.collectDeleting((row) => this.#removeRow(row))) === 100) {}
    for await (const object of this.files.list("")) {
      if (object.key.startsWith("pending-")) continue;
      const retained = await this.access.database
        .selectFrom("teamBlobs")
        .select("id")
        .where((e) =>
          e.or([
            e("storageKey", "=", object.key),
            e("previewStorageKey", "=", object.key),
            // An upload writes its preview under this key before the row records it.
            e(sql`storage_key || '-preview'`, "=", object.key),
          ]),
        )
        .executeTakeFirst();
      if (!retained) await this.files.delete(object.key, object.generation);
    }
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.#directory))
      if (/^pending-[0-9a-f-]{36}(-preview)?$/.test(name)) {
        const path = join(this.#directory, name);
        if ((await stat(path)).mtimeMs < Date.now() - 86400000) await rm(path, { force: true });
      }
  }
  async #removeRow(row: {
    storageKey: string;
    previewStorageKey: string | null;
    generation: string | null;
    previewGeneration: string | null;
  }) {
    for (const key of [row.storageKey, row.previewStorageKey ?? `${row.storageKey}-preview`]) {
      const generation = key === row.storageKey ? row.generation : row.previewGeneration;
      if (generation) await this.files.delete(key, generation);
      else
        for await (const object of this.files.list(key))
          if (object.key === key) await this.files.delete(key, object.generation);
    }
  }
  /** Ends every transfer in flight; the service keeps serving new, authorized ones. */
  async abortTransfers() {
    for (const transfer of this.#caching.values()) transfer.controller.abort();
    await Promise.allSettled([...this.#caching.values()].map((t) => t.done));
    for (const transfer of this.#active) transfer.controller.abort();
    this.#active.clear();
  }
  async close() {
    this.#unsubscribe();
    await this.abortTransfers();
  }
}
