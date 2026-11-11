import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  OpensteerError,
  type ArtifactContentPart,
  type RunId,
  type TeamSource,
} from "@opensteer/core";
import type { AttachmentStore, DatabaseSchema, OpensteerStore } from "@opensteer/database";
import { personalTeamRunOutcome } from "@opensteer/database/personal-team-run-store";
import type { RunnerRegistry } from "@opensteer/orchestration";
import type { TeamFileSchema } from "@opensteer/protocol";
import type { Kysely } from "kysely";
import type { z } from "zod";
import type { PersonalTeamAttachmentPort, PersonalTeamRunPort } from "../team-links/index.js";
import type { RunFileRelay } from "../integrations/run-file-relay.js";
import type { AttachmentService, RunAttachmentsTokenService } from "./attachment-service.js";

const failure = (message: string) => new OpensteerError({ code: "conflict", message });
function asError(error: unknown): Error {
  return error instanceof Error ? error : failure("The file transfer failed");
}
function artifact(row: {
  id: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
}): ArtifactContentPart {
  return {
    type: "artifact",
    artifactId: row.id,
    name: row.name,
    mediaType: row.mediaType,
    sizeBytes: row.sizeBytes,
  };
}

export function personalTeamRunPort(database: Kysely<DatabaseSchema>): PersonalTeamRunPort {
  return { outcome: (request) => personalTeamRunOutcome(database, request) };
}

export class PersonalTeamAttachments implements PersonalTeamAttachmentPort {
  private readonly options: {
    readonly store: Pick<OpensteerStore, "runCapabilityScope" | "assertActiveGrant">;
    readonly attachments: AttachmentService;
    readonly attachmentStore: AttachmentStore;
    readonly tokens: RunAttachmentsTokenService;
    readonly runners: Pick<RunnerRegistry, "requestRunFile">;
    readonly relay: RunFileRelay;
  };
  constructor(options: PersonalTeamAttachments["options"]) {
    this.options = options;
  }

  private async scope(runId: RunId) {
    const scope = await this.options.store.runCapabilityScope(runId);
    if (!scope)
      throw new OpensteerError({
        code: "forbidden",
        message: "This Run no longer owns file access",
      });
    await this.options.store.assertActiveGrant(scope);
    return scope;
  }

  async admitPath(runId: RunId, path: string, signal: AbortSignal): Promise<ArtifactContentPart> {
    signal.throwIfAborted();
    const scope = await this.scope(runId);
    const { relay, runners, attachments, attachmentStore } = this.options;
    const transfer = relay.open();
    const close = () => transfer.close(failure("The file transfer was cancelled"));
    signal.addEventListener("abort", close, { once: true });
    if (signal.aborted) close();
    let reserved: string | undefined;
    let bound = false;
    const sending = runners
      .requestRunFile(
        scope.runnerId,
        {
          type: "host.run-file.send",
          execution: { runId: scope.runId, bindingGeneration: scope.bindingGeneration },
          files: [{ path, transfer: transfer.upload }],
        },
        signal,
      )
      .then((result) => {
        if (!result.ok) throw failure(result.message ?? "The task could not read this file");
        return result;
      });
    void sending.catch((error) => transfer.close(asError(error)));
    try {
      const incoming = await relay.download(transfer.download.id, transfer.download.token);
      try {
        const row = await attachments.reserve({
          uploaderId: scope.requestedBy,
          name: incoming.name,
          mediaType: "application/octet-stream",
          sizeBytes: incoming.sizeBytes,
          idempotencyKey: `team-path:${randomUUID()}`,
        });
        reserved = row.id;
        const ready = await attachments.upload({
          attachmentId: row.id,
          userId: scope.requestedBy,
          body: incoming.stream,
          signal,
        });
        incoming.settled();
        await sending;
        signal.throwIfAborted();
        await this.options.store.assertActiveGrant(scope);
        await attachmentStore.bindRunImport({ ...scope, attachmentId: row.id });
        bound = true;
        return artifact(ready);
      } catch (error) {
        incoming.settled(asError(error));
        throw error;
      }
    } finally {
      transfer.close();
      signal.removeEventListener("abort", close);
      await sending.catch(() => undefined);
      if (reserved && !bound) await attachments.discard(reserved, scope.requestedBy);
    }
  }

  async import(input: {
    readonly runId: RunId;
    readonly file: z.infer<typeof TeamFileSchema>;
    readonly source: TeamSource;
    readonly bytes: Readable;
    readonly signal: AbortSignal;
  }): Promise<{ readonly path: string; readonly attachment: ArtifactContentPart }> {
    input.signal.throwIfAborted();
    const scope = await this.scope(input.runId);
    const { attachments, attachmentStore, tokens, relay, runners } = this.options;
    const abort = () => input.bytes.destroy();
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) abort();
    const row = await attachments
      .reserve({
        uploaderId: scope.requestedBy,
        name: input.file.filename,
        mediaType: input.file.mediaType,
        sizeBytes: input.file.sizeBytes,
        idempotencyKey: `team-file:${randomUUID()}`,
      })
      .catch((error) => {
        input.signal.removeEventListener("abort", abort);
        input.bytes.destroy();
        throw error;
      });
    let bound = false;
    try {
      const ready = await attachments.upload({
        attachmentId: row.id,
        userId: scope.requestedBy,
        body: input.bytes,
        signal: input.signal,
        expectedSha256: input.file.sha256,
      });
      input.signal.throwIfAborted();
      await attachmentStore.bindRunImport({ ...scope, attachmentId: row.id, source: input.source });
      bound = true;
      const content = await attachments.contentForRun(tokens.issue(scope), row.id);
      const transfer = relay.open();
      const close = () => transfer.close(failure("The file transfer was cancelled"));
      input.signal.addEventListener("abort", close, { once: true });
      const uploading = relay.upload(transfer.upload.id, transfer.upload.token, {
        name: row.name,
        sizeBytes: row.sizeBytes,
        stream: Readable.from([content.bytes]),
      });
      void uploading.catch((error) => transfer.close(asError(error)));
      try {
        await this.options.store.assertActiveGrant(scope);
        const result = await runners.requestRunFile(
          scope.runnerId,
          {
            type: "host.run-file.receive",
            execution: { runId: scope.runId, bindingGeneration: scope.bindingGeneration },
            transfers: [transfer.download],
          },
          input.signal,
        );
        if (!result.ok || result.paths?.length !== 1)
          throw failure(result.message ?? "The task could not receive this file");
        await uploading;
        input.signal.throwIfAborted();
        await this.options.store.assertActiveGrant(scope);
        return { path: result.paths[0]!, attachment: artifact(ready) };
      } finally {
        transfer.close();
        input.signal.removeEventListener("abort", close);
        await uploading.catch(() => undefined);
      }
    } finally {
      input.signal.removeEventListener("abort", abort);
      input.bytes.destroy();
      if (!bound) await attachments.discard(row.id, scope.requestedBy);
    }
  }

  async export(
    runId: RunId,
    attachment: ArtifactContentPart,
  ): Promise<{ readonly bytes: Readable; readonly sha256: string }> {
    const scope = await this.scope(runId);
    const row = await this.options.attachmentStore.getForRun({
      attachmentId: attachment.artifactId,
      runId,
      threadId: scope.threadId,
    });
    if (
      row.name !== attachment.name ||
      row.mediaType !== attachment.mediaType ||
      (attachment.sizeBytes !== undefined && attachment.sizeBytes !== row.sizeBytes) ||
      !row.sha256
    )
      throw failure("Attachment metadata changed");
    const content = await this.options.attachments.contentForRun(
      this.options.tokens.issue(scope),
      row.id,
    );
    await this.options.store.assertActiveGrant(scope);
    return { bytes: Readable.from([content.bytes]), sha256: row.sha256 };
  }
}
