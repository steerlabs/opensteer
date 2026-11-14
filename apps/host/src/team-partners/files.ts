import { OpensteerError } from "@opensteer/core";
import {
  TeamShareFileChunkSchema,
  teamShareFileChunkBytes,
  teamShareFileBytesPerMinute,
  teamPartnerMaxFrameBytes,
  teamPartnerMaxQueueBytes,
  type TeamShareOperation,
} from "@opensteer/protocol";
import { withTimeout } from "@opensteer/shared/withTimeout";
import type { TeamFilesStore } from "@opensteer/database/team-files";
import { shareNotFound } from "@opensteer/database/team-shares";
import type { TeamFileService, TeamRemoteFiles } from "../team/file-service.js";
import type { TeamShares } from "./shares.js";

// Leave a maximum-size frame free for chat/control traffic and stay within the sender's two reads.
export const teamShareFileChunkWindow = Math.min(
  2,
  Math.floor(teamPartnerMaxQueueBytes / teamPartnerMaxFrameBytes) - 1,
);

type FileOperation = Extract<TeamShareOperation, { op: "file" }>;

export class TeamShareFiles implements TeamRemoteFiles {
  readonly #requests = new Map<string, { active: Set<Promise<void>>; waiting: number }>();
  readonly #downloads = new Map<string, number>();
  readonly #reads = new Map<string, number>();
  readonly #rates = new Map<string, { until: number; bytes: number }>();
  readonly shares: TeamShares;
  readonly files: TeamFileService;
  constructor(shares: TeamShares, files: TeamFileService) {
    this.shares = shares;
    this.files = files;
  }

  #limit(): never {
    throw new OpensteerError({
      code: "resource_exhausted",
      retryable: true,
      reason: "shared-channel-file-limit",
      message: "Shared channel file transfers are temporarily limited. Retry shortly.",
      details: { retryAfterMs: 1000 },
    });
  }
  #admit(map: Map<string, number>, id: string) {
    if ((map.get(id) ?? 0) >= 2 || [...map.values()].reduce((n, v) => n + v, 0) >= 4) this.#limit();
    map.set(id, (map.get(id) ?? 0) + 1);
    return () => {
      const n = (map.get(id) ?? 1) - 1;
      if (n) map.set(id, n);
      else map.delete(id);
    };
  }
  #bytes(id: string, size: number) {
    const now = Date.now();
    let rate = this.#rates.get(id);
    if (!rate || rate.until <= now) {
      for (const [key, value] of this.#rates) if (value.until <= now) this.#rates.delete(key);
      if (this.#rates.size >= 128) this.#limit();
      rate = { until: now + 60_000, bytes: 0 };
      this.#rates.set(id, rate);
    }
    if (rate.bytes + size > teamShareFileBytesPerMinute) this.#limit();
    rate.bytes += size;
  }
  async authorized(linkId: string, op: FileOperation) {
    return this.shares.store.db.transaction().execute(async (t) => {
      const share = await this.shares.store.scoped(t, linkId, op.shareId, op.generation);
      const row = await t
        .selectFrom("teamBlobs as b")
        .innerJoin("teamMessageAttachments as a", "a.blobId", "b.id")
        .innerJoin("teamMessages as m", "m.id", "a.messageId")
        .selectAll("b")
        .where("b.channelId", "=", share.channelId!)
        .where("b.publicId", "=", op.publicId)
        .where("b.remoteShareId", "is", null)
        .where("b.state", "=", "ready")
        .where("m.deletedAt", "is", null)
        .where("m.channelId", "=", share.channelId!)
        .executeTakeFirst();
      if (!row || (op.part === "preview" && !row.previewStorageKey)) shareNotFound();
      return row;
    });
  }
  async receive(linkId: string, op: FileOperation) {
    const release = this.#admit(this.#reads, op.shareId);
    try {
      const row = await this.authorized(linkId, op);
      const size = Number(op.part === "original" ? row.sizeBytes : row.previewSizeBytes);
      if (op.offset > size) shareNotFound();
      this.#bytes(`send:${op.shareId}`, Math.min(teamShareFileChunkBytes, size - op.offset));
      return {
        bytes: await this.files.readPartnerChunk(row, op.part, op.offset, teamShareFileChunkBytes),
      };
    } finally {
      release();
    }
  }
  async #request(linkId: string, op: FileOperation, signal: AbortSignal) {
    let window = this.#requests.get(linkId);
    if (!window) {
      window = { active: new Set(), waiting: 0 };
      this.#requests.set(linkId, window);
    }
    window.waiting++;
    try {
      while (window.active.size >= teamShareFileChunkWindow)
        await withTimeout(Promise.race(window.active), 5000, {
          signal,
          timeoutError: () => new Error("Partner file window unavailable"),
        });
      signal.throwIfAborted();
      const request = this.shares.partners.request(linkId, op, signal);
      const settled = request.then(
        () => {},
        () => {},
      );
      window.active.add(settled);
      try {
        return await request;
      } finally {
        window.active.delete(settled);
      }
    } finally {
      if (!--window.waiting) this.#requests.delete(linkId);
    }
  }
  async *download(
    row: Awaited<ReturnType<TeamFilesStore["authorized"]>>,
    part: "original" | "preview",
    signal: AbortSignal,
    authorize: () => Promise<boolean>,
  ): AsyncGenerator<Uint8Array> {
    const share = await this.shares.store.get(row.remoteShareId!);
    const release = this.#admit(this.#downloads, share.id);
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const size = Number(part === "original" ? row.sizeBytes : row.previewSizeBytes);
    const pending: Promise<{ bytes: Buffer; error?: never } | { error: unknown; bytes?: never }>[] =
      [];
    const fetch = async (offset: number) => {
      combined.throwIfAborted();
      await authorize();
      let raw;
      try {
        raw = await this.#request(
          share.partnerLinkId,
          {
            op: "file",
            shareId: share.id,
            generation: share.generation,
            publicId: row.publicId,
            part,
            offset,
          },
          combined,
        );
      } catch (error) {
        combined.throwIfAborted();
        if (error instanceof OpensteerError && error.reason === "not-found") shareNotFound();
        if (error instanceof OpensteerError && error.reason === "partner-retry-later") throw error;
        throw new OpensteerError({
          code: "conflict",
          retryable: true,
          reason: "partner-unreachable",
          message: "The team that owns this file is unreachable. Retry the download.",
        });
      }
      const parsed = TeamShareFileChunkSchema.safeParse(raw);
      if (!parsed.success) shareNotFound();
      const chunk = Buffer.from(parsed.data.bytes, "base64");
      if (chunk.length !== Math.min(teamShareFileChunkBytes, size - offset)) shareNotFound();
      return chunk;
    };
    let offset = 0;
    const enqueue = () => {
      const next = offset;
      offset += teamShareFileChunkBytes;
      pending.push(
        fetch(next).then(
          (bytes) => ({ bytes }),
          (error) => ({ error }),
        ),
      );
    };
    try {
      this.#bytes(`receive:${share.id}`, size);
      while (pending.length < teamShareFileChunkWindow && offset < size) enqueue();
      while (pending.length) {
        const result = await pending.shift()!;
        if (!result.bytes) throw result.error;
        combined.throwIfAborted();
        yield result.bytes;
        if (offset < size) enqueue();
      }
    } finally {
      controller.abort();
      await Promise.all(pending);
      release();
    }
  }
}
