import { describe, expect, it } from "vitest";
import { integrationToolSignature } from "./tool-signature.js";

describe("integrationToolSignature", () => {
  it("puts required arguments first and marks the rest optional", () => {
    expect(
      integrationToolSignature({
        definitions: {},
        inputSchema: {
          type: "object",
          required: ["userId"],
          properties: {
            q: { type: "string" },
            userId: { type: "string" },
            maxResults: { type: "integer" },
            labelIds: { type: "array", items: { type: "string" } },
            format: { enum: ["full", "metadata"] },
          },
        },
      }),
    ).toBe(
      '{ userId: string; q?: string; maxResults?: number; labelIds?: string[]; format?: "full"|"metadata" }',
    );
  });

  it("keeps a required nested argument visible through a shared definition", () => {
    expect(
      integrationToolSignature({
        definitions: {
          Message: {
            type: "object",
            required: ["raw"],
            properties: { raw: { type: "string" }, labelIds: { type: "array" } },
          },
        },
        inputSchema: {
          type: "object",
          required: ["message"],
          properties: { message: { $ref: "#/$defs/Message" } },
        },
      }),
    ).toBe("{ message: { raw: string; … } }");
  });

  it("stops at a definition that reaches itself", () => {
    expect(
      integrationToolSignature({
        definitions: {
          Node: {
            type: "object",
            required: ["next"],
            properties: { next: { $ref: "#/$defs/Node" } },
          },
        },
        inputSchema: {
          type: "object",
          required: ["root"],
          properties: { root: { $ref: "#/$defs/Node" } },
        },
      }),
    ).toBe("{ root: { next: {…} } }");
  });

  it("stops at a definition that reaches itself through arrays and unions", () => {
    const signature = integrationToolSignature({
      definitions: {
        Json: {
          anyOf: [{ type: "string" }, { type: "array", items: { $ref: "#/$defs/Json" } }],
        },
      },
      inputSchema: {
        type: "object",
        required: ["value"],
        properties: { value: { $ref: "#/$defs/Json" } },
      },
    });
    expect(signature.startsWith("{ value: string|")).toBe(true);
  });

  it("stays bounded on a union too wide to show", () => {
    const wide = { anyOf: Array.from({ length: 40 }, () => ({ $ref: "#/$defs/Wide" })) };
    expect(
      integrationToolSignature({
        definitions: { Wide: wide },
        inputSchema: {
          type: "object",
          required: ["value"],
          properties: { value: { $ref: "#/$defs/Wide" } },
        },
      }),
    ).toBe("{ value: unknown }");
  });

  it("ends on the widest union that reaches itself", () => {
    expect(
      integrationToolSignature({
        definitions: {
          Wide: { anyOf: Array.from({ length: 5 }, () => ({ $ref: "#/$defs/Wide" })) },
        },
        inputSchema: {
          type: "object",
          required: ["value"],
          properties: { value: { $ref: "#/$defs/Wide" } },
        },
      }),
    ).toBe("{ value: unknown }");
  });

  it("reads definitions a tool keeps in its own schema", () => {
    expect(
      integrationToolSignature({
        definitions: {},
        inputSchema: {
          $defs: {
            Payload: {
              type: "object",
              required: ["id"],
              properties: { id: { type: "string" } },
            },
          },
          type: "object",
          required: ["payload"],
          properties: { payload: { $ref: "#/$defs/Payload" } },
        },
      }),
    ).toBe("{ payload: { id: string } }");
  });

  it("says there is more when a reference cannot be read", () => {
    expect(
      integrationToolSignature({
        definitions: {},
        inputSchema: {
          type: "object",
          required: ["payload"],
          properties: { payload: { $ref: "#/$defs/Missing" } },
        },
      }),
    ).toBe("{ payload: {…} }");
  });

  it("drops optional arguments first and says it cut the shape", () => {
    const signature = integrationToolSignature(
      {
        definitions: {},
        inputSchema: {
          type: "object",
          required: ["id"],
          properties: Object.fromEntries([
            ["id", { type: "string" }],
            ...Array.from({ length: 40 }, (_, index) => [`option${index}`, { type: "string" }]),
          ]),
        },
      },
      80,
    );
    expect(signature.startsWith("{ id: string; ")).toBe(true);
    expect(signature.endsWith("… }")).toBe(true);
    expect(Buffer.byteLength(signature)).toBeLessThanOrEqual(80);
  });

  it("names an unconstrained or empty input plainly", () => {
    expect(integrationToolSignature({ definitions: {}, inputSchema: { type: "object" } })).toBe(
      "{}",
    );
    expect(
      integrationToolSignature({
        definitions: {},
        inputSchema: {
          type: "object",
          required: ["payload"],
          properties: { payload: {} },
        },
      }),
    ).toBe("{ payload: unknown }");
  });
});
