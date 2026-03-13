import type { DocumentEpoch, DocumentRef, FrameRef, PageRef, SessionRef } from "./identity.js";
import {
  documentEpochSchema,
  documentRefSchema,
  frameRefSchema,
  pageRefSchema,
  sessionRefSchema,
} from "./identity.js";
import type { JsonSchema } from "./json.js";
import {
  arraySchema,
  enumSchema,
  integerSchema,
  objectSchema,
  oneOfSchema,
  stringSchema,
} from "./json.js";
import type { NetworkRecord } from "./network.js";
import { networkRecordSchema } from "./network.js";
import type { HtmlSnapshot, DomSnapshot, ScreenshotArtifact } from "./snapshots.js";
import { domSnapshotSchema, htmlSnapshotSchema, screenshotArtifactSchema } from "./snapshots.js";
import type { CookieRecord, StorageSnapshot } from "./storage.js";
import { cookieRecordSchema, storageSnapshotSchema } from "./storage.js";

export type OpensteerArtifactKind =
  | "screenshot"
  | "html-snapshot"
  | "dom-snapshot"
  | "network-records"
  | "cookies"
  | "storage-snapshot";

export type ArtifactRelation = "result" | "before" | "after" | "capture" | "evidence" | "snapshot";

export interface ArtifactExternalLocation {
  readonly delivery: "external";
  readonly uri: string;
  readonly mimeType?: string;
  readonly byteLength?: number;
  readonly sha256?: string;
}

export interface ArtifactInline<TData> {
  readonly delivery: "inline";
  readonly data: TData;
}

interface ArtifactContext {
  readonly sessionRef?: SessionRef;
  readonly pageRef?: PageRef;
  readonly frameRef?: FrameRef;
  readonly documentRef?: DocumentRef;
  readonly documentEpoch?: DocumentEpoch;
}

interface OpensteerArtifactBase extends ArtifactContext {
  readonly artifactId: string;
  readonly kind: OpensteerArtifactKind;
  readonly createdAt: number;
}

export interface ScreenshotArtifactRecord extends OpensteerArtifactBase {
  readonly kind: "screenshot";
  readonly payload: ArtifactInline<ScreenshotArtifact> | ArtifactExternalLocation;
}

export interface HtmlSnapshotArtifactRecord extends OpensteerArtifactBase {
  readonly kind: "html-snapshot";
  readonly payload: ArtifactInline<HtmlSnapshot> | ArtifactExternalLocation;
}

export interface DomSnapshotArtifactRecord extends OpensteerArtifactBase {
  readonly kind: "dom-snapshot";
  readonly payload: ArtifactInline<DomSnapshot> | ArtifactExternalLocation;
}

export interface NetworkRecordsArtifactRecord extends OpensteerArtifactBase {
  readonly kind: "network-records";
  readonly payload: ArtifactInline<readonly NetworkRecord[]> | ArtifactExternalLocation;
}

export interface CookiesArtifactRecord extends OpensteerArtifactBase {
  readonly kind: "cookies";
  readonly payload: ArtifactInline<readonly CookieRecord[]> | ArtifactExternalLocation;
}

export interface StorageSnapshotArtifactRecord extends OpensteerArtifactBase {
  readonly kind: "storage-snapshot";
  readonly payload: ArtifactInline<StorageSnapshot> | ArtifactExternalLocation;
}

export type OpensteerArtifact =
  | ScreenshotArtifactRecord
  | HtmlSnapshotArtifactRecord
  | DomSnapshotArtifactRecord
  | NetworkRecordsArtifactRecord
  | CookiesArtifactRecord
  | StorageSnapshotArtifactRecord;

export interface ArtifactReference {
  readonly artifactId: string;
  readonly kind: OpensteerArtifactKind;
  readonly relation: ArtifactRelation;
}

const artifactKindSchema: JsonSchema = enumSchema(
  [
    "screenshot",
    "html-snapshot",
    "dom-snapshot",
    "network-records",
    "cookies",
    "storage-snapshot",
  ] as const,
  {
    title: "OpensteerArtifactKind",
  },
);

const artifactRelationSchema: JsonSchema = enumSchema(
  ["result", "before", "after", "capture", "evidence", "snapshot"] as const,
  {
    title: "ArtifactRelation",
  },
);

const artifactExternalLocationSchema: JsonSchema = objectSchema(
  {
    delivery: enumSchema(["external"] as const),
    uri: stringSchema(),
    mimeType: stringSchema(),
    byteLength: integerSchema({ minimum: 0 }),
    sha256: stringSchema(),
  },
  {
    title: "ArtifactExternalLocation",
    required: ["delivery", "uri"],
  },
);

function inlineArtifactPayloadSchema(dataSchema: JsonSchema, title: string): JsonSchema {
  return objectSchema(
    {
      delivery: enumSchema(["inline"] as const),
      data: dataSchema,
    },
    {
      title,
      required: ["delivery", "data"],
    },
  );
}

function artifactBaseSchema(kind: OpensteerArtifactKind): Record<string, JsonSchema> {
  return {
    artifactId: stringSchema(),
    kind: enumSchema([kind] as const),
    createdAt: integerSchema({ minimum: 0 }),
    sessionRef: sessionRefSchema,
    pageRef: pageRefSchema,
    frameRef: frameRefSchema,
    documentRef: documentRefSchema,
    documentEpoch: documentEpochSchema,
  };
}

const screenshotArtifactRecordSchema: JsonSchema = objectSchema(
  {
    ...artifactBaseSchema("screenshot"),
    payload: oneOfSchema([
      inlineArtifactPayloadSchema(screenshotArtifactSchema, "InlineScreenshotArtifact"),
      artifactExternalLocationSchema,
    ]),
  },
  {
    title: "ScreenshotArtifactRecord",
    required: ["artifactId", "kind", "createdAt", "payload"],
  },
);

const htmlSnapshotArtifactRecordSchema: JsonSchema = objectSchema(
  {
    ...artifactBaseSchema("html-snapshot"),
    payload: oneOfSchema([
      inlineArtifactPayloadSchema(htmlSnapshotSchema, "InlineHtmlSnapshotArtifact"),
      artifactExternalLocationSchema,
    ]),
  },
  {
    title: "HtmlSnapshotArtifactRecord",
    required: ["artifactId", "kind", "createdAt", "payload"],
  },
);

const domSnapshotArtifactRecordSchema: JsonSchema = objectSchema(
  {
    ...artifactBaseSchema("dom-snapshot"),
    payload: oneOfSchema([
      inlineArtifactPayloadSchema(domSnapshotSchema, "InlineDomSnapshotArtifact"),
      artifactExternalLocationSchema,
    ]),
  },
  {
    title: "DomSnapshotArtifactRecord",
    required: ["artifactId", "kind", "createdAt", "payload"],
  },
);

const networkRecordsArtifactRecordSchema: JsonSchema = objectSchema(
  {
    ...artifactBaseSchema("network-records"),
    payload: oneOfSchema([
      inlineArtifactPayloadSchema(arraySchema(networkRecordSchema), "InlineNetworkRecordsArtifact"),
      artifactExternalLocationSchema,
    ]),
  },
  {
    title: "NetworkRecordsArtifactRecord",
    required: ["artifactId", "kind", "createdAt", "payload"],
  },
);

const cookiesArtifactRecordSchema: JsonSchema = objectSchema(
  {
    ...artifactBaseSchema("cookies"),
    payload: oneOfSchema([
      inlineArtifactPayloadSchema(arraySchema(cookieRecordSchema), "InlineCookiesArtifact"),
      artifactExternalLocationSchema,
    ]),
  },
  {
    title: "CookiesArtifactRecord",
    required: ["artifactId", "kind", "createdAt", "payload"],
  },
);

const storageSnapshotArtifactRecordSchema: JsonSchema = objectSchema(
  {
    ...artifactBaseSchema("storage-snapshot"),
    payload: oneOfSchema([
      inlineArtifactPayloadSchema(storageSnapshotSchema, "InlineStorageSnapshotArtifact"),
      artifactExternalLocationSchema,
    ]),
  },
  {
    title: "StorageSnapshotArtifactRecord",
    required: ["artifactId", "kind", "createdAt", "payload"],
  },
);

export const opensteerArtifactSchema: JsonSchema = oneOfSchema(
  [
    screenshotArtifactRecordSchema,
    htmlSnapshotArtifactRecordSchema,
    domSnapshotArtifactRecordSchema,
    networkRecordsArtifactRecordSchema,
    cookiesArtifactRecordSchema,
    storageSnapshotArtifactRecordSchema,
  ],
  {
    title: "OpensteerArtifact",
  },
);

export const artifactReferenceSchema: JsonSchema = objectSchema(
  {
    artifactId: stringSchema(),
    kind: artifactKindSchema,
    relation: artifactRelationSchema,
  },
  {
    title: "ArtifactReference",
    required: ["artifactId", "kind", "relation"],
  },
);
