import type { WorkspaceDirectoryPage, WorkspaceFilePreviewMetadata } from "@opensteer/protocol";

export interface WorkspaceFileListInput {
  readonly cursor?: string;
  readonly knownRevision?: string;
  readonly limit: number;
  readonly parentKey: string;
  readonly retainedCursor?: string;
}

export interface WorkspaceFilePreview {
  readonly bytes: Uint8Array;
  readonly metadata: WorkspaceFilePreviewMetadata;
}

export interface WorkspaceFilesDriver<WorkspaceType> {
  list(
    workspace: WorkspaceType,
    input: WorkspaceFileListInput,
    signal?: AbortSignal,
  ): Promise<WorkspaceDirectoryPage>;
  preview(
    workspace: WorkspaceType,
    fileKey: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceFilePreview>;
  download(workspace: WorkspaceType, fileKey: string, signal?: AbortSignal): Promise<Response>;
}
