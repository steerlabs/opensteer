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
