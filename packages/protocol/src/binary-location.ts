import type { JsonSchema } from "./json.js";
import { enumSchema, integerSchema, objectSchema, stringSchema } from "./json.js";

export interface ExternalBinaryLocation {
  readonly delivery: "external";
  readonly uri: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export const externalBinaryLocationSchema: JsonSchema = objectSchema(
  {
    delivery: enumSchema(["external"] as const),
    uri: stringSchema(),
    mimeType: stringSchema(),
    byteLength: integerSchema({ minimum: 0 }),
    sha256: stringSchema(),
  },
  {
    title: "ExternalBinaryLocation",
    required: ["delivery", "uri", "mimeType", "byteLength", "sha256"],
  },
);
