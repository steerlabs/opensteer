import { createHash } from "node:crypto";
import { OpensteerError } from "@opensteer/core";
import {
  TeamShareFileChunkSchema,
  teamShareFileChunkBytes,
  teamShareFileBytesPerMinute,
  type TeamShareOperation,
} from "@opensteer/protocol";
import type { TeamFilesStore } from "@opensteer/database/team-files";
import { shareNotFound } from "@opensteer/database/team-shares";
import type { TeamFileService, TeamRemoteFiles } from "../team/file-service.js";
import type { TeamShares } from "./shares.js";

type FileOperation = Extract<TeamShareOperation, { op: "file" }>;

export class TeamShareFiles implements TeamRemoteFiles {
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
  async download(
    row: Awaited<ReturnType<TeamFilesStore["authorized"]>>,
    part: "original" | "preview",
    signal: AbortSignal,
    authorize: () => Promise<boolean>,
  ) {
    const share = await this.shares.store.get(row.remoteShareId!);
    const release = this.#admit(this.#downloads, share.id);
    let retained = false;
    try {
      signal.throwIfAborted();
      const size = Number(part === "original" ? row.sizeBytes : row.previewSizeBytes);
      const digest = part === "original" ? row.sha256 : row.previewSha256;
      this.#bytes(`receive:${share.id}`, size);
      const bytes = Buffer.alloc(size);
      let offset = 0;
      do {
        signal.throwIfAborted();
        await authorize();
        let raw;
        try {
          raw = await this.shares.partners.request(
            share.partnerLinkId,
            {
              op: "file",
              shareId: share.id,
              generation: share.generation,
              publicId: row.publicId,
              part,
              offset,
            },
            signal,
          );
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof OpensteerError && error.reason === "not-found") shareNotFound();
          if (error instanceof OpensteerError && error.reason === "partner-retry-later")
            throw error;
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
        bytes.set(chunk, offset);
        offset += chunk.length;
      } while (offset < size);
      if (createHash("sha256").update(bytes).digest("hex") !== digest) shareNotFound();
      signal.throwIfAborted();
      await authorize();
      signal.throwIfAborted();
      signal.addEventListener("abort", release, { once: true });
      retained = true;
      return bytes;
    } finally {
      if (!retained) release();
    }
  }
}
