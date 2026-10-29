import {
  attachmentMaxBytes,
  detectImageMediaType,
  DeploymentIdSchema,
  ThreadIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
} from "@opensteer/core";
import { randomUUID } from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import * as Sharing from "expo-sharing";
import type { HostClient } from "@opensteer/client/host";

export interface AttachmentDraftScope {
  readonly deploymentId: string;
  readonly userId: string;
  readonly threadId: string;
}

/**
 * Local files for a first message, before the Thread it starts exists: Chat's
 * first message, or a new task's in one Workspace. They belong to no Thread
 * until the Host has made the one they start.
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
      readonly userId: string;
      readonly workspaceId: string;
    };

export type LocalAttachmentDraftScope = AttachmentDraftScope | FirstMessageAttachmentDraftScope;

export interface PickedAttachmentSource {
  readonly file: File;
  readonly localUri: string;
  readonly mediaType: string;
  readonly name: string;
  readonly sizeBytes: number;
}

function draftDirectory(scope: LocalAttachmentDraftScope): Directory {
  return new Directory(
    Paths.document,
    "attachment-drafts",
    DeploymentIdSchema.parse(scope.deploymentId),
    UserIdSchema.parse(scope.userId),
    draftLeaf(scope),
  );
}

/** The one folder a scope's files live in; a scope that names two is refused. */
function draftLeaf(scope: LocalAttachmentDraftScope): string {
  if (!("kind" in scope)) return ThreadIdSchema.parse(scope.threadId);
  if ("threadId" in scope) return invalidDraftScope();
  switch (scope.kind) {
    case "home-intro":
      return "home-intro";
    case "new-task":
      return `new-task-${WorkspaceIdSchema.parse(scope.workspaceId)}`;
    default:
      return invalidDraftScope();
  }
}

function invalidDraftScope(): never {
  throw new Error("This attachment draft has an invalid scope.");
}

async function copyToPrivateDraft(
  sourceUri: string,
  metadata: { readonly name: string; readonly mediaType: string },
  scope: LocalAttachmentDraftScope,
): Promise<PickedAttachmentSource> {
  const directory = draftDirectory(scope);
  directory.create({ idempotent: true, intermediates: true });
  const source = new File(sourceUri);
  if (!source.exists || source.size > attachmentMaxBytes) {
    throw new Error("Choose an available file smaller than 25 MB.");
  }
  const file = new File(directory, `${randomUUID()}.draft`);
  await source.copy(file);
  if (!file.exists || file.size !== source.size || file.size > attachmentMaxBytes) {
    if (file.exists) file.delete();
    throw new Error("The selected file changed while it was being copied. Pick it again.");
  }
  // Pickers label files by name or not at all, and the Host refuses a label
  // the bytes contradict, so an image is named by what it holds.
  const handle = file.open();
  let detected: string | null;
  try {
    detected = detectImageMediaType(await handle.readBytes(64));
  } finally {
    handle.close();
  }
  if (
    detected === "image/heic" ||
    detected === "image/heif" ||
    (!detected && /^image\/hei[cf]$/iu.test(metadata.mediaType))
  ) {
    file.delete();
    throw new Error(
      `${metadata.name} is a HEIC photo, which this app cannot convert yet. Export it as JPEG and attach that instead.`,
    );
  }
  return {
    file,
    localUri: file.uri,
    mediaType: detected ?? metadata.mediaType,
    name: metadata.name,
    sizeBytes: file.size,
  };
}

/** The system Files picker can hand out short-lived URIs; copy before reservation/upload. */
export async function pickChatFile(
  scope: LocalAttachmentDraftScope,
): Promise<PickedAttachmentSource | null> {
  const picked = await File.pickFileAsync();
  if (picked.canceled) return null;
  const file = picked.result;
  return copyToPrivateDraft(
    file.uri,
    {
      name: file.name,
      mediaType: file.type && file.type.includes("/") ? file.type : "application/octet-stream",
    },
    scope,
  );
}

/** Keep image selection in native Photos while preserving the exact selected bytes. */
export async function pickChatPhoto(
  scope: LocalAttachmentDraftScope,
): Promise<PickedAttachmentSource | null> {
  const picked = await ImagePicker.launchImageLibraryAsync({
    allowsEditing: false,
    allowsMultipleSelection: false,
    base64: false,
    exif: false,
    mediaTypes: ["images"],
    preferredAssetRepresentationMode:
      ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    quality: 1,
  });
  if (picked.canceled || picked.assets.length === 0) return null;
  const asset = picked.assets[0];
  if (!asset) return null;
  if (!asset.mimeType?.startsWith("image/")) {
    throw new Error("The photo format could not be identified. Choose a PNG, JPEG, or WebP image.");
  }
  return copyToPrivateDraft(
    asset.uri,
    {
      name: asset.fileName ?? `photo-${randomUUID()}`,
      mediaType: asset.mimeType,
    },
    scope,
  );
}

/** A saved draft URI is opened only within the current authenticated scope. */
function scopedChatDraftFile(scope: LocalAttachmentDraftScope, localUri: string): File {
  const directory = draftDirectory(scope);
  const prefix = `${directory.uri.replace(/\/+$/u, "")}/`;
  if (
    !localUri.startsWith(prefix) ||
    !/^[-0-9a-f]{36}\.draft$/u.test(localUri.slice(prefix.length))
  ) {
    throw new Error("This draft file does not belong to this thread.");
  }
  return new File(localUri);
}

export function openChatDraftFile(scope: LocalAttachmentDraftScope, localUri: string): File {
  const file = scopedChatDraftFile(scope, localUri);
  if (!file.exists) throw new Error("This draft file is no longer on this phone. Pick it again.");
  return file;
}

export function removeChatDraftFile(scope: LocalAttachmentDraftScope, localUri: string): void {
  const file = scopedChatDraftFile(scope, localUri);
  if (file.exists) file.delete();
}

/**
 * Copy a first message's private file into the scope of the Thread it started.
 * The same source always names the same destination. The caller keeps the
 * first message's source until the Thread's pending command has been saved and
 * the first message's own pending record has been cleared successfully.
 */
export async function copyFirstMessageDraftFileToThread(
  intro: FirstMessageAttachmentDraftScope,
  thread: AttachmentDraftScope,
  localUri: string,
): Promise<string> {
  const source = scopedChatDraftFile(intro, localUri);
  const directory = draftDirectory(thread);
  if (intro.deploymentId !== thread.deploymentId || intro.userId !== thread.userId) {
    throw new Error("This draft file cannot move to another account or deployment.");
  }
  if (!source.exists || source.size > attachmentMaxBytes) {
    throw new Error("This draft file is no longer on this phone. Pick it again.");
  }
  const destination = new File(directory, source.name);
  if (destination.exists) {
    if (sameDraftBytes(source, destination)) return destination.uri;
    // An interrupted copy may leave a shorter file at this stable URI.
    // A same-size disagreement is not safe to overwrite as a retry.
    if (destination.size >= source.size) {
      throw new Error("The Chat draft copy differs from the selected file. Pick it again.");
    }
    destination.delete();
  }
  directory.create({ idempotent: true, intermediates: true });
  try {
    await source.copy(destination);
  } catch (error) {
    if (destination.exists && !sameDraftBytes(source, destination)) destination.delete();
    throw error;
  }
  if (!sameDraftBytes(source, destination)) {
    if (destination.exists) destination.delete();
    throw new Error("The selected file changed while it was being copied. Pick it again.");
  }
  return destination.uri;
}

function sameDraftBytes(source: File, destination: File): boolean {
  const digest = source.md5;
  return (
    source.exists &&
    destination.exists &&
    destination.size === source.size &&
    digest !== null &&
    digest === destination.md5
  );
}

/** Native share sheet for a Host original; the temporary copy is app-owned. */
export async function shareChatAttachment(
  client: HostClient,
  attachmentId: string,
  name: string,
): Promise<void> {
  const blob = await client.readAttachment(attachmentId);
  const safeName = name.replace(/[\\/\p{Cc}]/gu, "_").slice(0, 160) || "attachment";
  const file = new File(Paths.cache, `${randomUUID()}-${safeName}`);
  try {
    await file.write(new Uint8Array(await blob.arrayBuffer()));
    await Sharing.shareAsync(file.uri, { mimeType: blob.type || "application/octet-stream" });
  } finally {
    if (file.exists) file.delete();
  }
}
