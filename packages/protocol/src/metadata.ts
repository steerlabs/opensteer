import type { DocumentEpoch, DocumentRef, FrameRef, PageRef, SessionRef } from "./identity.js";
import {
  documentEpochSchema,
  documentRefSchema,
  frameRefSchema,
  pageRefSchema,
  sessionRefSchema,
} from "./identity.js";
import { enumSchema, objectSchema, stringSchema, type JsonSchema } from "./json.js";

export type PageLifecycleState = "opening" | "open" | "closing" | "closed" | "crashed";

export interface PageInfo {
  readonly pageRef: PageRef;
  readonly sessionRef: SessionRef;
  readonly openerPageRef?: PageRef;
  readonly url: string;
  readonly title: string;
  readonly lifecycleState: PageLifecycleState;
}

export interface FrameInfo {
  readonly frameRef: FrameRef;
  readonly pageRef: PageRef;
  readonly parentFrameRef?: FrameRef;
  readonly documentRef: DocumentRef;
  readonly documentEpoch: DocumentEpoch;
  readonly url: string;
  readonly name?: string;
  readonly isMainFrame: boolean;
}

export const pageLifecycleStateSchema: JsonSchema = enumSchema(
  ["opening", "open", "closing", "closed", "crashed"] as const,
  {
    title: "PageLifecycleState",
  },
);

export const pageInfoSchema: JsonSchema = objectSchema(
  {
    pageRef: pageRefSchema,
    sessionRef: sessionRefSchema,
    openerPageRef: pageRefSchema,
    url: stringSchema({
      description: "Current main-frame URL.",
    }),
    title: stringSchema(),
    lifecycleState: pageLifecycleStateSchema,
  },
  {
    title: "PageInfo",
    required: ["pageRef", "sessionRef", "url", "title", "lifecycleState"],
  },
);

export const frameInfoSchema: JsonSchema = objectSchema(
  {
    frameRef: frameRefSchema,
    pageRef: pageRefSchema,
    parentFrameRef: frameRefSchema,
    documentRef: documentRefSchema,
    documentEpoch: documentEpochSchema,
    url: stringSchema(),
    name: stringSchema(),
    isMainFrame: {
      type: "boolean",
    },
  },
  {
    title: "FrameInfo",
    required: ["frameRef", "pageRef", "documentRef", "documentEpoch", "url", "isMainFrame"],
  },
);
