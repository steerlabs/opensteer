import {
  WorkspaceBindingIdSchema,
  type EnvironmentId,
  type UserId,
  type WorkspaceBindingId,
  type WorkspaceId,
  type WorkspaceKind,
} from "@opensteer/core";
import { createHash } from "node:crypto";

/**
 * Node-only, so it is reached through `@opensteer/workspace/local-binding`
 * rather than the package index: `@opensteer/protocol` re-exports the
 * workspace root, and a client bundle that follows it must not pull
 * `node:crypto` in behind a Host-and-Runner helper.
 */

/**
 * The binding identity both sides derive independently: the Host to persist a
 * creation intent before anything touches a disk, and the owning Runner to
 * refuse a provision request whose fingerprint does not produce the identity it
 * was sent. Neither has to trust the other's arithmetic.
 */
export function localWorkspaceBindingId(input: {
  readonly createdBy: UserId;
  readonly idempotencyKey: string;
  readonly kind: WorkspaceKind;
  readonly ownerEnvironmentId: EnvironmentId;
  readonly workspaceId: WorkspaceId;
}): WorkspaceBindingId {
  const bytes = createHash("sha256")
    .update("opensteer:local-workspace-binding:v1\0", "utf8")
    .update(input.workspaceId, "utf8")
    .update("\0", "utf8")
    .update(input.ownerEnvironmentId, "utf8")
    .update("\0", "utf8")
    .update(input.createdBy, "utf8")
    .update("\0", "utf8")
    .update(input.kind, "utf8")
    .update("\0", "utf8")
    .update(input.idempotencyKey, "utf8")
    .digest()
    .subarray(0, 16);
  const versionByte = bytes[6];
  const variantByte = bytes[8];
  if (versionByte === undefined || variantByte === undefined) {
    throw new Error("SHA-256 returned an invalid digest");
  }
  bytes[6] = (versionByte & 0x0f) | 0x80;
  bytes[8] = (variantByte & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return WorkspaceBindingIdSchema.parse(
    `wbd_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}
