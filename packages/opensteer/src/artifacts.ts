import path from "node:path";
import { randomUUID } from "node:crypto";

import type {
  ArtifactProvenance,
  ArtifactReference,
  ArtifactRelation,
  CookieRecord,
  DomSnapshot,
  ExternalBinaryLocation,
  HtmlSnapshot,
  OpensteerArtifact,
  OpensteerArtifactKind,
  ScriptSourceArtifactData,
  StorageSnapshot,
  TraceContext,
} from "@opensteer/protocol";

import {
  encodePathSegment,
  ensureDirectory,
  filePathToUri,
  isAlreadyExistsError,
  joinStoragePath,
  normalizeNonEmptyString,
  normalizeTimestamp,
  pathExists,
  readBinaryFile,
  readJsonFile,
  resolveStoragePath,
  sha256Hex,
  writeBufferIfMissing,
  writeJsonFileExclusive,
} from "./internal/filesystem.js";
import { canonicalJsonString, toCanonicalJsonValue } from "./json.js";

export type ArtifactPayloadType = "structured" | "binary";
export type ProtocolArtifactDelivery = "external" | "inline-if-structured";

export interface ArtifactScope extends TraceContext {}

export interface ArtifactManifest {
  readonly artifactId: string;
  readonly kind: OpensteerArtifactKind;
  readonly createdAt: number;
  readonly provenance?: ArtifactProvenance;
  readonly scope: ArtifactScope;
  readonly mediaType: string;
  readonly payloadType: ArtifactPayloadType;
  readonly byteLength: number;
  readonly sha256: string;
  readonly objectRelativePath: string;
}

export type StructuredArtifactKind = Exclude<OpensteerArtifactKind, "screenshot">;

interface StructuredArtifactDataByKind {
  readonly "html-snapshot": HtmlSnapshot;
  readonly "dom-snapshot": DomSnapshot;
  readonly cookies: readonly CookieRecord[];
  readonly "storage-snapshot": StorageSnapshot;
  readonly "script-source": ScriptSourceArtifactData;
}

type StructuredArtifactPayloadByKind = {
  [K in StructuredArtifactKind]: {
    readonly kind: K;
    readonly payloadType: "structured";
    readonly data: StructuredArtifactDataByKind[K];
  };
};

type StoredArtifactPayloadByKind = {
  readonly screenshot: {
    readonly kind: "screenshot";
    readonly payloadType: "binary";
    readonly data: Uint8Array;
  };
} & StructuredArtifactPayloadByKind;

export type StoredArtifactPayload = StoredArtifactPayloadByKind[OpensteerArtifactKind];

export interface StoredArtifactRecord {
  readonly manifest: ArtifactManifest;
  readonly payload: StoredArtifactPayload;
}

type WriteStructuredArtifactInputByKind<K extends StructuredArtifactKind> = {
  readonly artifactId?: string;
  readonly kind: K;
  readonly createdAt?: number;
  readonly provenance?: ArtifactProvenance;
  readonly scope?: ArtifactScope;
  readonly mediaType?: string;
  readonly data: StructuredArtifactDataByKind[K];
};

export type WriteStructuredArtifactInput = {
  [K in StructuredArtifactKind]: WriteStructuredArtifactInputByKind<K>;
}[StructuredArtifactKind];

export interface WriteBinaryArtifactInput {
  readonly artifactId?: string;
  readonly kind: "screenshot";
  readonly createdAt?: number;
  readonly provenance?: ArtifactProvenance;
  readonly scope?: ArtifactScope;
  readonly mediaType: string;
  readonly data: Uint8Array;
}

export interface OpensteerArtifactStore {
  readonly manifestsDirectory: string;
  readonly objectsDirectory: string;

  writeStructured(input: WriteStructuredArtifactInput): Promise<ArtifactManifest>;
  writeBinary(input: WriteBinaryArtifactInput): Promise<ArtifactManifest>;
  getManifest(artifactId: string): Promise<ArtifactManifest | undefined>;
  read(artifactId: string): Promise<StoredArtifactRecord | undefined>;
  toProtocolArtifactReference(
    artifactId: string,
    relation: ArtifactRelation,
  ): Promise<ArtifactReference | undefined>;
  toProtocolArtifact(
    artifactId: string,
    options?: {
      readonly delivery?: ProtocolArtifactDelivery;
    },
  ): Promise<OpensteerArtifact | undefined>;
}

function normalizeScope(scope: ArtifactScope | undefined): ArtifactScope {
  if (scope === undefined) {
    return {};
  }

  return {
    ...(scope.sessionRef === undefined ? {} : { sessionRef: scope.sessionRef }),
    ...(scope.pageRef === undefined ? {} : { pageRef: scope.pageRef }),
    ...(scope.frameRef === undefined ? {} : { frameRef: scope.frameRef }),
    ...(scope.documentRef === undefined ? {} : { documentRef: scope.documentRef }),
    ...(scope.documentEpoch === undefined ? {} : { documentEpoch: scope.documentEpoch }),
  };
}

function normalizeProvenance(
  provenance: ArtifactProvenance | undefined,
): ArtifactProvenance | undefined {
  if (provenance === undefined) {
    return undefined;
  }

  return {
    ...(provenance.sourceArtifactId === undefined
      ? {}
      : {
          sourceArtifactId: normalizeNonEmptyString(
            "provenance.sourceArtifactId",
            provenance.sourceArtifactId,
          ),
        }),
    ...(provenance.transform === undefined
      ? {}
      : { transform: normalizeNonEmptyString("provenance.transform", provenance.transform) }),
  };
}

async function readStructuredPayload<TData>(objectPath: string): Promise<TData> {
  return JSON.parse(Buffer.from(await readBinaryFile(objectPath)).toString("utf8")) as TData;
}

export class FilesystemArtifactStore implements OpensteerArtifactStore {
  readonly manifestsDirectory: string;
  readonly objectsDirectory: string;

  constructor(private readonly rootPath: string) {
    this.manifestsDirectory = path.join(this.rootPath, "artifacts", "manifests");
    this.objectsDirectory = path.join(this.rootPath, "artifacts", "objects", "sha256");
  }

  async initialize(): Promise<void> {
    await ensureDirectory(this.manifestsDirectory);
    await ensureDirectory(this.objectsDirectory);
  }

  async writeStructured(input: WriteStructuredArtifactInput): Promise<ArtifactManifest> {
    const artifactId = normalizeNonEmptyString(
      "artifactId",
      input.artifactId ?? `artifact:${randomUUID()}`,
    );
    const manifestPath = this.manifestPath(artifactId);

    const jsonData = toCanonicalJsonValue(input.data);
    const objectBytes = Buffer.from(canonicalJsonString(jsonData), "utf8");
    const sha256 = sha256Hex(objectBytes);
    const objectRelativePath = joinStoragePath("artifacts", "objects", "sha256", sha256);
    const objectPath = resolveStoragePath(this.rootPath, objectRelativePath);

    await writeBufferIfMissing(objectPath, objectBytes);

    const provenance = normalizeProvenance(input.provenance);
    const manifest: ArtifactManifest = {
      artifactId,
      kind: input.kind,
      createdAt: normalizeTimestamp("createdAt", input.createdAt ?? Date.now()),
      ...(provenance === undefined ? {} : { provenance }),
      scope: normalizeScope(input.scope),
      mediaType: input.mediaType ?? "application/json",
      payloadType: "structured",
      byteLength: objectBytes.byteLength,
      sha256,
      objectRelativePath,
    };

    try {
      await writeJsonFileExclusive(manifestPath, manifest);
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        throw new Error(`artifact ${artifactId} already exists`);
      }

      throw error;
    }

    return manifest;
  }

  async writeBinary(input: WriteBinaryArtifactInput): Promise<ArtifactManifest> {
    const artifactId = normalizeNonEmptyString(
      "artifactId",
      input.artifactId ?? `artifact:${randomUUID()}`,
    );
    const manifestPath = this.manifestPath(artifactId);

    const mediaType = normalizeNonEmptyString("mediaType", input.mediaType);
    const data = new Uint8Array(input.data);
    const sha256 = sha256Hex(data);
    const extension = mediaTypeExtension(mediaType);
    const objectRelativePath = joinStoragePath(
      "artifacts",
      "objects",
      "sha256",
      `${sha256}${extension}`,
    );
    const objectPath = resolveStoragePath(this.rootPath, objectRelativePath);

    await writeBufferIfMissing(objectPath, data);

    const provenance = normalizeProvenance(input.provenance);
    const manifest: ArtifactManifest = {
      artifactId,
      kind: input.kind,
      createdAt: normalizeTimestamp("createdAt", input.createdAt ?? Date.now()),
      ...(provenance === undefined ? {} : { provenance }),
      scope: normalizeScope(input.scope),
      mediaType,
      payloadType: "binary",
      byteLength: data.byteLength,
      sha256,
      objectRelativePath,
    };

    try {
      await writeJsonFileExclusive(manifestPath, manifest);
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        throw new Error(`artifact ${artifactId} already exists`);
      }

      throw error;
    }

    return manifest;
  }

  async getManifest(artifactId: string): Promise<ArtifactManifest | undefined> {
    const manifestPath = this.manifestPath(artifactId);
    if (!(await pathExists(manifestPath))) {
      return undefined;
    }

    return readJsonFile<ArtifactManifest>(manifestPath);
  }

  async read(artifactId: string): Promise<StoredArtifactRecord | undefined> {
    const manifest = await this.getManifest(artifactId);
    if (manifest === undefined) {
      return undefined;
    }

    const objectPath = resolveStoragePath(this.rootPath, manifest.objectRelativePath);
    if (manifest.kind === "screenshot") {
      if (manifest.payloadType !== "binary") {
        throw new Error(`artifact ${artifactId} has an invalid screenshot payload type`);
      }

      return {
        manifest,
        payload: {
          kind: "screenshot",
          payloadType: "binary",
          data: await readBinaryFile(objectPath),
        },
      };
    }

    if (manifest.payloadType !== "structured") {
      throw new Error(`artifact ${artifactId} has an invalid structured payload type`);
    }

    switch (manifest.kind) {
      case "html-snapshot":
        return {
          manifest,
          payload: {
            kind: "html-snapshot",
            payloadType: "structured",
            data: await readStructuredPayload<HtmlSnapshot>(objectPath),
          },
        };
      case "dom-snapshot":
        return {
          manifest,
          payload: {
            kind: "dom-snapshot",
            payloadType: "structured",
            data: await readStructuredPayload<DomSnapshot>(objectPath),
          },
        };
      case "cookies":
        return {
          manifest,
          payload: {
            kind: "cookies",
            payloadType: "structured",
            data: await readStructuredPayload<readonly CookieRecord[]>(objectPath),
          },
        };
      case "storage-snapshot":
        return {
          manifest,
          payload: {
            kind: "storage-snapshot",
            payloadType: "structured",
            data: await readStructuredPayload<StorageSnapshot>(objectPath),
          },
        };
      case "script-source":
        return {
          manifest,
          payload: {
            kind: "script-source",
            payloadType: "structured",
            data: await readStructuredPayload<ScriptSourceArtifactData>(objectPath),
          },
        };
    }
  }

  async toProtocolArtifactReference(
    artifactId: string,
    relation: ArtifactRelation,
  ): Promise<ArtifactReference | undefined> {
    const manifest = await this.getManifest(artifactId);
    if (manifest === undefined) {
      return undefined;
    }

    return {
      artifactId: manifest.artifactId,
      kind: manifest.kind,
      relation,
    };
  }

  async toProtocolArtifact(
    artifactId: string,
    options: {
      readonly delivery?: ProtocolArtifactDelivery;
    } = {},
  ): Promise<OpensteerArtifact | undefined> {
    const record = await this.read(artifactId);
    if (record === undefined) {
      return undefined;
    }

    const delivery = options.delivery ?? "external";
    const externalPayload = manifestToExternalBinaryLocation(this.rootPath, record.manifest);

    const artifactBase = {
      artifactId: record.manifest.artifactId,
      createdAt: record.manifest.createdAt,
      ...(record.manifest.provenance === undefined
        ? {}
        : { provenance: record.manifest.provenance }),
      ...(record.manifest.scope.sessionRef === undefined
        ? {}
        : { sessionRef: record.manifest.scope.sessionRef }),
      ...(record.manifest.scope.pageRef === undefined
        ? {}
        : { pageRef: record.manifest.scope.pageRef }),
      ...(record.manifest.scope.frameRef === undefined
        ? {}
        : { frameRef: record.manifest.scope.frameRef }),
      ...(record.manifest.scope.documentRef === undefined
        ? {}
        : { documentRef: record.manifest.scope.documentRef }),
      ...(record.manifest.scope.documentEpoch === undefined
        ? {}
        : { documentEpoch: record.manifest.scope.documentEpoch }),
    };

    switch (record.payload.kind) {
      case "screenshot":
        return { ...artifactBase, kind: "screenshot", payload: externalPayload };
      case "html-snapshot":
        return {
          ...artifactBase,
          kind: "html-snapshot",
          payload:
            delivery === "inline-if-structured"
              ? { delivery: "inline", data: record.payload.data }
              : externalPayload,
        };
      case "dom-snapshot":
        return {
          ...artifactBase,
          kind: "dom-snapshot",
          payload:
            delivery === "inline-if-structured"
              ? { delivery: "inline", data: record.payload.data }
              : externalPayload,
        };
      case "cookies":
        return {
          ...artifactBase,
          kind: "cookies",
          payload:
            delivery === "inline-if-structured"
              ? { delivery: "inline", data: record.payload.data }
              : externalPayload,
        };
      case "storage-snapshot":
        return {
          ...artifactBase,
          kind: "storage-snapshot",
          payload:
            delivery === "inline-if-structured"
              ? { delivery: "inline", data: record.payload.data }
              : externalPayload,
        };
      case "script-source":
        return {
          ...artifactBase,
          kind: "script-source",
          payload:
            delivery === "inline-if-structured"
              ? { delivery: "inline", data: record.payload.data }
              : externalPayload,
        };
    }
  }

  private manifestPath(artifactId: string): string {
    return path.join(this.manifestsDirectory, `${encodePathSegment(artifactId)}.json`);
  }
}

export function createArtifactStore(rootPath: string): FilesystemArtifactStore {
  return new FilesystemArtifactStore(rootPath);
}

export function manifestToExternalBinaryLocation(
  rootPath: string,
  manifest: Pick<ArtifactManifest, "objectRelativePath" | "mediaType" | "byteLength" | "sha256">,
): ExternalBinaryLocation {
  return {
    delivery: "external",
    uri: filePathToUri(resolveStoragePath(rootPath, manifest.objectRelativePath)),
    mimeType: manifest.mediaType,
    byteLength: manifest.byteLength,
    sha256: manifest.sha256,
  };
}

function mediaTypeExtension(mediaType: string): string {
  switch (mediaType) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpeg";
    case "image/webp":
      return ".webp";
    default:
      return "";
  }
}
