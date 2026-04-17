export type { PageLifecycleState, PageInfo, FrameInfo } from "@opensteer/browser-core";

import {
  documentEpochSchema,
  documentRefSchema,
  frameRefSchema,
  pageRefSchema,
  sessionRefSchema,
} from "./identity.js";
import { enumSchema, objectSchema, stringSchema, type JsonSchema } from "./json.js";

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
    targetId: stringSchema({
      description: "Underlying browser target identifier when available.",
    }),
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
