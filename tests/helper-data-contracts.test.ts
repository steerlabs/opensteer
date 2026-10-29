import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateJsonSchema } from "../packages/integration-adapters/src/index.js";
import { getIntegrationDefinition } from "../packages/integration-catalog/src/index.js";
import { parseComputerAppConfig } from "../packages/integration-core/src/computer-app.js";
import { computerAppOperationContract } from "../packages/integration-core/src/computer-app-tools.js";
import {
  ComputerUseDataInvokeParamsSchema,
  ComputerUseDataInvokeResultSchema,
  computerUseDataApps,
} from "../packages/protocol/src/computer-use.js";

/**
 * The helper serves apps whose operations the catalog defines, and checks
 * every call against a contract table generated from that catalog. These two
 * ends are different languages, so this guard reads what the helper itself
 * wrote — `helper-wire.json`, from its own types — and holds it to the
 * catalog: for every operation, the contract it compiled in and an answer its
 * own rules wrote.
 */
const fixture = JSON.parse(
  readFileSync(
    path.resolve(
      import.meta.dirname,
      "../apps/desktop/native/computer-use/Tests/Fixtures/helper-wire.json",
    ),
    "utf8",
  ),
) as {
  readonly apps: Readonly<
    Record<
      string,
      Readonly<
        Record<
          string,
          { readonly contract: string; readonly effect: string; readonly output: unknown }
        >
      >
    >
  >;
  readonly requests: Readonly<Record<string, { readonly params: unknown }>>;
  readonly results: Readonly<Record<string, unknown>>;
};

function operation(definitionId: string, name: string) {
  const definition = getIntegrationDefinition(definitionId);
  if (!definition) throw new Error(`The catalog must define ${definitionId}`);
  const found = parseComputerAppConfig(definition).operations.find(
    (candidate) => candidate.name === name,
  );
  if (!found) throw new Error(`${definitionId} must define ${name}`);
  return found;
}

describe("the helper's data contracts", () => {
  it("serves only computer apps the catalog defines", () => {
    for (const definitionId of Object.keys(computerUseDataApps)) {
      const definition = getIntegrationDefinition(definitionId);
      expect(definition?.adapter).toBe("computer");
      const platforms = parseComputerAppConfig(definition!).platforms;
      expect(platforms).toEqual(definitionId === "apple-messages" ? ["darwin"] : ["darwin", "ios"]);
    }
  });

  it("compiles in the contract the catalog computes for an operation", () => {
    const params = ComputerUseDataInvokeParamsSchema.parse(fixture.requests["data.invoke"]?.params);
    const catalog = operation(params.definitionId, params.operation);
    expect(params.contract).toBe(computerAppOperationContract(catalog));
    expect(params.effect).toBe(catalog.effect);
  });

  it("compiles in every operation of every app it serves, as the catalog computes it", () => {
    for (const definitionId of Object.keys(computerUseDataApps)) {
      const definition = getIntegrationDefinition(definitionId)!;
      const catalog = parseComputerAppConfig(definition).operations;
      const compiled = fixture.apps[definitionId] ?? {};
      expect(Object.keys(compiled).sort()).toEqual(catalog.map(({ name }) => name).sort());
      for (const operation of catalog) {
        expect(compiled[operation.name], `${definitionId}.${operation.name}`).toMatchObject({
          contract: computerAppOperationContract(operation),
          effect: operation.effect,
        });
      }
    }
    expect(Object.keys(fixture.apps).sort()).toEqual(Object.keys(computerUseDataApps).sort());
  });

  it("answers every operation in the shape the catalog promises agents", () => {
    for (const [definitionId, operations] of Object.entries(fixture.apps)) {
      for (const [name, { output }] of Object.entries(operations)) {
        const schema = operation(definitionId, name).outputSchema;
        expect(schema, `${definitionId}.${name}`).not.toBeNull();
        expect(validateJsonSchema(schema!, output), `${definitionId}.${name}`).toEqual([]);
      }
    }
  });

  it("answers data.invoke in the shape the catalog promises agents", () => {
    const params = ComputerUseDataInvokeParamsSchema.parse(fixture.requests["data.invoke"]?.params);
    const result = ComputerUseDataInvokeResultSchema.parse(fixture.results["data.invoke"]);
    const catalog = operation(params.definitionId, params.operation);
    expect(catalog.outputSchema).not.toBeNull();
    expect(validateJsonSchema(catalog.outputSchema!, result.value)).toEqual([]);
  });
});
