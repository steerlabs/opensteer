import type { Attachment } from "@opensteer/core";
import { HostClientRequestError, type HostClient } from "./client.js";

export interface StageAttachmentInput {
  readonly attachmentId: string | null;
  readonly mediaType: string;
  readonly name: string;
  readonly onReserved: (attachmentId: string) => void;
  readonly reservationKey: string;
  readonly signal: AbortSignal;
  readonly sizeBytes: number;
  readonly source: Blob;
  readonly workspaceId: string;
}

/** Reserve, upload, and reconcile one replayable source. A lost upload answer
 * keeps its reservation; only a confirmed missing reservation gets a new key. */
export async function stageAttachment(
  client: HostClient,
  input: StageAttachmentInput,
): Promise<Attachment> {
  input.signal.throwIfAborted();
  if (input.source.size !== input.sizeBytes) throw new Error("The selected file changed.");
  let attachmentId = input.attachmentId;
  let reservationKey = input.reservationKey;
  if (attachmentId !== null) {
    try {
      const known = await client.getAttachment(attachmentId);
      input.signal.throwIfAborted();
      assertReservation(known, input, attachmentId);
      if (known.state === "ready") return known;
    } catch (error) {
      if (!(error instanceof HostClientRequestError && error.status === 404)) throw error;
      attachmentId = null;
      // The old id is durable even if the replacement create reply is lost.
      // Repeating this key then recovers that same replacement reservation.
      reservationKey = `attachment:replace:${input.attachmentId}`;
    }
  }
  if (attachmentId === null) {
    const reserved = await client.createAttachment({
      idempotencyKey: reservationKey,
      mediaType: input.mediaType,
      name: input.name,
      sizeBytes: input.sizeBytes,
      workspaceId: input.workspaceId,
    });
    input.signal.throwIfAborted();
    assertReservation(reserved, input, reserved.id);
    attachmentId = reserved.id;
    input.onReserved(attachmentId);
    if (reserved.state === "ready") return reserved;
  }
  try {
    const uploaded = await client.uploadAttachment({
      attachmentId,
      signal: input.signal,
      source: input.source,
    });
    input.signal.throwIfAborted();
    assertReservation(uploaded, input, attachmentId);
    if (uploaded.state !== "ready") throw new Error("The upload did not finish. Try again.");
    return uploaded;
  } catch (error) {
    if (input.signal.aborted || error instanceof HostClientRequestError) throw error;
    const known = await client.getAttachment(attachmentId).catch(() => null);
    input.signal.throwIfAborted();
    if (known) {
      assertReservation(known, input, attachmentId);
      if (known.state === "ready") return known;
    }
    throw error;
  }
}

function assertReservation(
  attachment: Attachment,
  input: StageAttachmentInput,
  attachmentId: string,
): void {
  if (
    attachment.id !== attachmentId ||
    attachment.workspaceId !== input.workspaceId ||
    attachment.name !== input.name ||
    attachment.mediaType !== input.mediaType ||
    attachment.sizeBytes !== input.sizeBytes ||
    attachment.messageId !== null ||
    attachment.state === "deleting"
  ) {
    throw new HostClientRequestError({
      code: "conflict",
      message: "This file's upload reservation no longer matches the selected file.",
      status: 409,
    });
  }
}
