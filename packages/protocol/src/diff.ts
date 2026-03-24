import type { JsonSchema } from "./json.js";
import { arraySchema, enumSchema, numberSchema, objectSchema, stringSchema } from "./json.js";

export type NetworkDiffFieldKind = "added" | "removed" | "changed" | "unchanged";

export interface NetworkDiffEntropy {
  readonly left?: number;
  readonly right?: number;
  readonly likelyEncrypted: boolean;
}

export interface NetworkDiffField {
  readonly path: string;
  readonly kind: NetworkDiffFieldKind;
  readonly leftValue?: string;
  readonly rightValue?: string;
  readonly entropy?: NetworkDiffEntropy;
}

export interface OpensteerNetworkDiffInput {
  readonly leftRecordId: string;
  readonly rightRecordId: string;
  readonly includeUnchanged?: boolean;
  readonly scope?: "headers" | "body" | "all";
}

export interface OpensteerNetworkDiffOutput {
  readonly summary: {
    readonly added: number;
    readonly removed: number;
    readonly changed: number;
    readonly unchanged: number;
    readonly likelyEncryptedFields: number;
  };
  readonly requestDiffs: readonly NetworkDiffField[];
  readonly responseDiffs: readonly NetworkDiffField[];
}

export const networkDiffFieldKindSchema: JsonSchema = enumSchema(
  ["added", "removed", "changed", "unchanged"] as const,
  {
    title: "NetworkDiffFieldKind",
  },
);

export const networkDiffEntropySchema: JsonSchema = objectSchema(
  {
    left: numberSchema({ minimum: 0 }),
    right: numberSchema({ minimum: 0 }),
    likelyEncrypted: { type: "boolean" },
  },
  {
    title: "NetworkDiffEntropy",
    required: ["likelyEncrypted"],
  },
);

export const networkDiffFieldSchema: JsonSchema = objectSchema(
  {
    path: stringSchema({ minLength: 1 }),
    kind: networkDiffFieldKindSchema,
    leftValue: stringSchema(),
    rightValue: stringSchema(),
    entropy: networkDiffEntropySchema,
  },
  {
    title: "NetworkDiffField",
    required: ["path", "kind"],
  },
);

export const opensteerNetworkDiffInputSchema: JsonSchema = objectSchema(
  {
    leftRecordId: stringSchema({ minLength: 1 }),
    rightRecordId: stringSchema({ minLength: 1 }),
    includeUnchanged: { type: "boolean" },
    scope: enumSchema(["headers", "body", "all"] as const),
  },
  {
    title: "OpensteerNetworkDiffInput",
    required: ["leftRecordId", "rightRecordId"],
  },
);

export const opensteerNetworkDiffOutputSchema: JsonSchema = objectSchema(
  {
    summary: objectSchema(
      {
        added: numberSchema({ minimum: 0 }),
        removed: numberSchema({ minimum: 0 }),
        changed: numberSchema({ minimum: 0 }),
        unchanged: numberSchema({ minimum: 0 }),
        likelyEncryptedFields: numberSchema({ minimum: 0 }),
      },
      {
        title: "OpensteerNetworkDiffSummary",
        required: ["added", "removed", "changed", "unchanged", "likelyEncryptedFields"],
      },
    ),
    requestDiffs: arraySchema(networkDiffFieldSchema),
    responseDiffs: arraySchema(networkDiffFieldSchema),
  },
  {
    title: "OpensteerNetworkDiffOutput",
    required: ["summary", "requestDiffs", "responseDiffs"],
  },
);
