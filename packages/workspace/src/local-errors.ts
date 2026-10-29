import { z } from "zod";

/**
 * Every failure a local-directory storage authority can report, lifecycle and
 * Files alike. It is one enum because the Runner now answers both kinds over
 * the same socket, and the Host translates the reply without knowing which
 * internal layer produced it.
 */
export const WorkspaceLocalErrorCodeSchema = z.enum([
  "configuration-invalid",
  "directory-inaccessible",
  "directory-missing",
  "directory-replaced",
  "environment-mismatch",
  "generation-mismatch",
  "idempotency-conflict",
  "provisioning-incomplete",
  "registry-invalid",
  "registry-unavailable",
  "workspace-conflict",
  "workspace-mismatch",
  // The answering machine is not the one holding this Workspace's disk, or the
  // connection the request was fenced to is no longer current.
  "authority-mismatch",
  "fence-stale",
  "concurrent-modification",
  "cross-device",
  "helper-unavailable",
  "invalid-path",
  "invalid-request",
  "not-directory",
  "not-found",
  "not-regular",
  "outside-workspace",
  "permission-denied",
  "root-replaced",
  "symlink-denied",
  "unsafe-parent",
]);
export type WorkspaceLocalErrorCode = z.infer<typeof WorkspaceLocalErrorCodeSchema>;

export const WorkspaceLocalFailureSchema = z.strictObject({
  code: WorkspaceLocalErrorCodeSchema,
  message: z.string().trim().min(1).max(500),
  retryable: z.boolean(),
});
export type WorkspaceLocalFailure = z.infer<typeof WorkspaceLocalFailureSchema>;
