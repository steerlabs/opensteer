// Kept apart from attachment-draft-files so plain modules can name a scope without loading Expo.
export interface AttachmentDraftScope {
  readonly deploymentId: string;
  readonly userId: string;
  readonly threadId: string;
}

/**
 * Local files for a first message, before the Thread it starts exists: one
 * new-task draft's. They belong to no Thread until the
 * Host has made the one they start.
 */
export type FirstMessageAttachmentDraftScope =
  | {
      readonly kind: "home-intro";
      readonly deploymentId: string;
      readonly userId: string;
    }
  | {
      readonly kind: "new-task";
      readonly deploymentId: string;
      readonly draftId: string;
      readonly userId: string;
    };

export type LocalAttachmentDraftScope = AttachmentDraftScope | FirstMessageAttachmentDraftScope;
