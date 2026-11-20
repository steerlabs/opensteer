import { EnvironmentIdSchema, ToolOutputImageMediaTypeSchema } from "@opensteer/core";
import {
  LocalDirectoryListingSchema,
  LocalFileMetadataSchema,
  LocalFileRevisionSchema,
  LocalPathSegmentBase64Schema,
  localFilesMaximumDirectoryOffset,
  localFilesMaximumPageEntries,
  localFilesMaximumReadBytes,
} from "@opensteer/shared/files/models";
import { z } from "zod";
import { RunFileTransferSchema } from "./run-files.js";
import { RunnerConnectionFenceSchema } from "./runner-identity.js";

export const agentHomeFilesCapability = "agent-home-files-v1" as const;
export const homeFilesMaxBytes = 32 * 1_024 * 1_024;
export const homeFilesExportMaxBytes = 24 * 1_024 * 1_024;
export const homeFilesExportMaxFiles = 10_000;
export const homeFilesExportManifestMaxBytes = 2 * 1_024 * 1_024;
export const homeFilesOutputImageMaxBytes = homeFilesMaxBytes;
export const homeFilesMaxFrameBytes = 960 * 1_024;

export const HomeDirectoryIdentitySchema = z.strictObject({
  fileId: z.string().regex(/^(?:0|[1-9][0-9]*|[a-f0-9]{32})$/u),
  kind: z.enum(["posix", "windows"]),
  volumeId: z.string().regex(/^(0|[1-9][0-9]*)$/u),
});
export type HomeDirectoryIdentity = z.infer<typeof HomeDirectoryIdentitySchema>;

export const HomeFileRootKindSchema = z.enum(["agent-home", "output-images"]);
export type HomeFileRootKind = z.infer<typeof HomeFileRootKindSchema>;

export const HomeFileErrorCodeSchema = z.enum([
  "not_found",
  "conflict",
  "bad_request",
  "file_too_large",
  "revision_mismatch",
  "unavailable",
]);
export type HomeFileErrorCode = z.infer<typeof HomeFileErrorCodeSchema>;

export const HomeFileOutputImageExtensionSchema = z.enum([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "svg",
]);
export type HomeFileOutputImageExtension = z.infer<typeof HomeFileOutputImageExtensionSchema>;

/** The hosting Runner created and canonicalized Agent home and reports its root identity. */
export const RunnerAgentHomeReportSchema = z.strictObject({
  ...RunnerConnectionFenceSchema.shape,
  environmentId: EnvironmentIdSchema,
  path: z.string().min(1).max(4_096),
  rootIdentity: HomeDirectoryIdentitySchema,
  type: z.literal("runner.agent-home.report"),
});
export type RunnerAgentHomeReport = z.infer<typeof RunnerAgentHomeReportSchema>;

const base = { ...RunnerConnectionFenceSchema.shape, requestId: z.uuid() };

export const HostHomeFileRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...base,
    expectedDirectoryRevision: LocalFileRevisionSchema.optional(),
    expectedRootScope: LocalFileRevisionSchema.optional(),
    limit: z.number().int().min(1).max(localFilesMaximumPageEntries),
    offset: z.number().int().min(0).max(localFilesMaximumDirectoryOffset),
    pathSegmentsBase64: z.array(LocalPathSegmentBase64Schema).max(256),
    type: z.literal("host.home-files.list"),
  }),
  z.strictObject({
    ...base,
    expectedFileRevision: LocalFileRevisionSchema.optional(),
    expectedRootScope: LocalFileRevisionSchema.optional(),
    maxBytes: z.number().int().min(1).max(localFilesMaximumReadBytes),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    pathSegmentsBase64: z.array(LocalPathSegmentBase64Schema).min(1).max(256),
    root: HomeFileRootKindSchema.optional(),
    type: z.literal("host.home-files.read"),
  }),
  z.strictObject({
    ...base,
    allowRelative: z.boolean().optional(),
    allowTilde: z.boolean().optional(),
    path: z.string().min(1).max(4_096),
    type: z.literal("host.home-files.resolve"),
  }),
  z.strictObject({
    ...base,
    expectedFileRevision: LocalFileRevisionSchema.optional(),
    expectedRootScope: LocalFileRevisionSchema.optional(),
    maxBytes: z.number().int().min(1).max(homeFilesMaxBytes).optional(),
    pathSegmentsBase64: z.array(LocalPathSegmentBase64Schema).min(1).max(256),
    root: HomeFileRootKindSchema.optional(),
    transfer: RunFileTransferSchema,
    purpose: z.literal("app-html").optional(),
    type: z.literal("host.home-files.download"),
  }),
  z.strictObject({
    ...base,
    directory: z.string().min(1).max(4_096),
    maxBytes: z.number().int().min(1).max(homeFilesExportMaxBytes),
    transfer: RunFileTransferSchema,
    type: z.literal("host.home-files.write"),
  }),
  z.strictObject({
    ...base,
    type: z.literal("host.home-files.cancel"),
  }),
]);
export type HostHomeFileRequest = z.infer<typeof HostHomeFileRequestSchema>;

export const RunnerHomeFileDataSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("list"),
    listing: LocalDirectoryListingSchema,
    rootScope: LocalFileRevisionSchema,
  }),
  z.strictObject({
    bytesRead: z.number().int().nonnegative().max(localFilesMaximumReadBytes),
    contentBase64: z.string().max(700_000),
    eof: z.boolean(),
    kind: z.literal("read"),
    metadata: LocalFileMetadataSchema,
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    rootScope: LocalFileRevisionSchema,
  }),
  z.strictObject({
    key: z
      .string()
      .min(1)
      .max(16_384)
      .regex(/^[\w-]+$/u),
    kind: z.literal("resolve"),
    metadata: LocalFileMetadataSchema,
    name: z.string().min(1).max(1_024),
    rootScope: LocalFileRevisionSchema,
  }),
  z.strictObject({
    kind: z.literal("download"),
    length: z.number().int().nonnegative().max(homeFilesMaxBytes),
    metadata: LocalFileMetadataSchema,
    rootScope: LocalFileRevisionSchema,
  }),
  z.strictObject({
    filesWritten: z.number().int().nonnegative().max(homeFilesExportMaxFiles),
    kind: z.literal("write"),
    rootScope: LocalFileRevisionSchema,
  }),
  z.strictObject({
    kind: z.literal("cancel"),
  }),
]);
export type RunnerHomeFileData = z.infer<typeof RunnerHomeFileDataSchema>;

export const RunnerHomeFileResultSchema = z
  .strictObject({
    ...base,
    data: RunnerHomeFileDataSchema.optional(),
    errorCode: HomeFileErrorCodeSchema.optional(),
    message: z.string().min(1).max(500).optional(),
    ok: z.boolean(),
    sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    type: z.literal("runner.home-files.result"),
  })
  .superRefine((value, context) => {
    if (value.ok && !value.data) {
      context.addIssue({
        code: "custom",
        message: "Successful home-files result must include data",
        path: ["data"],
      });
    }
    if (!value.ok && !value.errorCode) {
      context.addIssue({
        code: "custom",
        message: "Failed home-files result must include errorCode",
        path: ["errorCode"],
      });
    }
  });
export type RunnerHomeFileResult = z.infer<typeof RunnerHomeFileResultSchema>;

export const RunnerOutputImagePublishSchema = z.strictObject({
  ...base,
  extension: HomeFileOutputImageExtensionSchema,
  mediaType: ToolOutputImageMediaTypeSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  sizeBytes: z.number().int().positive().max(homeFilesOutputImageMaxBytes),
  type: z.literal("runner.output-image.publish"),
});
export type RunnerOutputImagePublish = z.infer<typeof RunnerOutputImagePublishSchema>;

export const HostOutputImageUploadSchema = z
  .strictObject({
    ...base,
    message: z.string().min(1).max(500).optional(),
    status: z.enum(["exists", "upload", "rejected"]),
    transfer: RunFileTransferSchema.optional(),
    type: z.literal("host.output-image.upload"),
  })
  .superRefine((value, context) => {
    if (value.status === "upload" && !value.transfer) {
      context.addIssue({
        code: "custom",
        message: "Upload output-image response must include transfer",
        path: ["transfer"],
      });
    }
  });
export type HostOutputImageUpload = z.infer<typeof HostOutputImageUploadSchema>;

export const HomeFileExportManifestSchema = z.strictObject({
  directory: z.string().min(1).max(4_096),
  files: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(4_096),
        sizeBytes: z.number().int().nonnegative().max(homeFilesExportMaxBytes),
      }),
    )
    .max(homeFilesExportMaxFiles),
});
export type HomeFileExportManifest = z.infer<typeof HomeFileExportManifestSchema>;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function encodeHomeFileExportBundle(input: {
  readonly directory: string;
  readonly files: readonly { readonly path: string; readonly bytes: Uint8Array }[];
  readonly maxBytes?: number;
}): Uint8Array {
  const maxBytes = input.maxBytes ?? homeFilesExportMaxBytes;
  const manifest = HomeFileExportManifestSchema.parse({
    directory: input.directory,
    files: input.files.map((file) => ({ path: file.path, sizeBytes: file.bytes.byteLength })),
  });
  let totalPayloadBytes = 0;
  for (const file of input.files) {
    totalPayloadBytes += file.bytes.byteLength;
    if (totalPayloadBytes > maxBytes) {
      throw new Error(`Export bundle exceeds the ${maxBytes} byte limit`);
    }
  }
  const manifestBytes = encoder.encode(JSON.stringify(manifest));
  if (manifestBytes.byteLength > homeFilesExportManifestMaxBytes) {
    throw new Error("Export bundle manifest exceeds its byte limit");
  }
  const bundle = new Uint8Array(4 + manifestBytes.byteLength + totalPayloadBytes);
  new DataView(bundle.buffer, bundle.byteOffset, bundle.byteLength).setUint32(
    0,
    manifestBytes.byteLength,
    false,
  );
  bundle.set(manifestBytes, 4);
  let offset = 4 + manifestBytes.byteLength;
  for (const file of input.files) {
    bundle.set(file.bytes, offset);
    offset += file.bytes.byteLength;
  }
  return bundle;
}

export function decodeHomeFileExportBundle(
  bundle: Uint8Array,
  maxBytes = homeFilesExportMaxBytes,
): {
  readonly directory: string;
  readonly files: readonly { readonly path: string; readonly bytes: Uint8Array }[];
} {
  if (bundle.byteLength < 4) {
    throw new Error("Export bundle is truncated");
  }
  const manifestLength = new DataView(
    bundle.buffer,
    bundle.byteOffset,
    bundle.byteLength,
  ).getUint32(0, false);
  if (
    manifestLength < 2 ||
    manifestLength > homeFilesExportManifestMaxBytes ||
    4 + manifestLength > bundle.byteLength
  ) {
    throw new Error("Export bundle manifest length is invalid");
  }
  const manifestText = decoder.decode(bundle.subarray(4, 4 + manifestLength));
  const manifest = HomeFileExportManifestSchema.parse(JSON.parse(manifestText));
  let offset = 4 + manifestLength;
  let totalPayloadBytes = 0;
  const files: { readonly path: string; readonly bytes: Uint8Array }[] = [];
  for (const entry of manifest.files) {
    totalPayloadBytes += entry.sizeBytes;
    if (totalPayloadBytes > maxBytes) {
      throw new Error(`Export bundle exceeds the ${maxBytes} byte limit`);
    }
    if (offset + entry.sizeBytes > bundle.byteLength) {
      throw new Error("Export bundle payload is truncated");
    }
    files.push({
      path: entry.path,
      bytes: bundle.subarray(offset, offset + entry.sizeBytes),
    });
    offset += entry.sizeBytes;
  }
  if (offset !== bundle.byteLength) {
    throw new Error("Export bundle has unexpected trailing bytes");
  }
  return { directory: manifest.directory, files };
}
