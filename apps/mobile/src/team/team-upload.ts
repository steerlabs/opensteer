import type { TeamSessionClient } from "@opensteer/client/team";
import { teamPreviewMaxBytes, teamUploadMaxBytes } from "@opensteer/protocol";
import { CryptoDigestAlgorithm, digest } from "expo-crypto";
import { File } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";

/** A file the person chose for a team message, still only on this phone. */
export interface TeamUploadSource {
  readonly localId: string;
  readonly uri: string;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
}

export async function pickTeamPhoto(): Promise<TeamUploadSource | null> {
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
  const asset = picked.canceled ? undefined : picked.assets[0];
  if (asset === undefined) return null;
  return {
    localId: globalThis.crypto.randomUUID(),
    uri: asset.uri,
    name: asset.fileName ?? "photo.jpg",
    mediaType: asset.mimeType ?? "image/jpeg",
    size: asset.fileSize ?? new File(asset.uri).size ?? 0,
  };
}

export async function pickTeamFile(): Promise<TeamUploadSource | null> {
  const picked = await File.pickFileAsync();
  if (picked.canceled) return null;
  const file = picked.result;
  return {
    localId: globalThis.crypto.randomUUID(),
    uri: file.uri,
    name: file.name,
    mediaType: file.type && file.type.includes("/") ? file.type : "application/octet-stream",
    size: file.size ?? 0,
  };
}

/** Why a file can't be sent, said on its chip before anything is sent. */
export function uploadRefusal(source: TeamUploadSource): string | null {
  if (source.size > teamUploadMaxBytes) return "Over 100 MB";
  if (source.size === 0) return "Empty file";
  return null;
}

/**
 * A small preview of an image, made here before upload so a channel on a
 * weak connection draws thumbnails rather than originals. Smaller and plainer
 * until it fits the team's preview bound; a picture that won't fit any goes
 * without one.
 */
export async function makeImagePreview(uri: string): Promise<string | null> {
  for (const [width, compress] of [
    [320, 0.6],
    [240, 0.45],
    [160, 0.35],
  ] as const) {
    const image = await ImageManipulator.manipulate(uri).resize({ width }).renderAsync();
    const saved = await image.saveAsync({ compress, format: SaveFormat.JPEG });
    const size = new File(saved.uri).size ?? Number.POSITIVE_INFINITY;
    if (size > 0 && size <= teamPreviewMaxBytes) return saved.uri;
  }
  return null;
}

/**
 * Uploads one chosen file to a channel: the original with its digest, and for
 * an image the preview made above, in one bounded request. Answers the team's
 * file id, which the message then names.
 */
export async function uploadToTeam(input: {
  readonly session: TeamSessionClient;
  readonly channelId: string;
  readonly source: TeamUploadSource;
  readonly signal?: AbortSignal;
}): Promise<string> {
  const { source } = input;
  const bytes = new Uint8Array(await new File(source.uri).arrayBuffer());
  const sha256 = [...new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const previewUri = source.mediaType.startsWith("image/")
    ? await makeImagePreview(source.uri)
    : null;
  // React Native's Blob carries native file bytes, never a JavaScript buffer,
  // so both parts are read back through the platform's own fetch.
  const original = await (await fetch(source.uri)).blob();
  const preview = previewUri === null ? null : await (await fetch(previewUri)).blob();
  const file = await input.session.upload({
    channelId: input.channelId as Parameters<TeamSessionClient["upload"]>[0]["channelId"],
    original,
    preview,
    metadata: {
      clientUploadId: source.localId,
      filename: source.name.slice(0, 255) || "file",
      mediaType: source.mediaType,
      sizeBytes: original.size,
      sha256,
      previewSizeBytes: preview?.size ?? 0,
    },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return file.id;
}
