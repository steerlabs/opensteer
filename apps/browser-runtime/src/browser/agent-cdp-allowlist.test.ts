import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  agentCdpAllowlist,
  type AgentCdpFields,
  type AgentCdpValue,
} from "@opensteer/browser-core";

interface SpecProperty {
  readonly $ref?: string;
  readonly enum?: readonly string[];
  readonly items?: SpecProperty;
  readonly name?: string;
  readonly optional?: boolean;
  readonly properties?: readonly SpecProperty[];
  readonly type?: string;
}

interface SpecDomain {
  readonly commands?: readonly { readonly name: string; readonly parameters?: SpecProperty[] }[];
  readonly domain: string;
  readonly events?: readonly { readonly name: string }[];
  readonly types?: readonly (SpecProperty & { readonly id: string })[];
}

const require = createRequire(import.meta.url);
const runtimePackage = require("../../package.json") as {
  readonly dependencies: Readonly<Record<string, string>>;
};
const installed = require("devtools-protocol/package.json") as { readonly version: string };
const domains = new Map<string, SpecDomain>(
  ["devtools-protocol/json/browser_protocol.json", "devtools-protocol/json/js_protocol.json"]
    .flatMap((file) => (require(file) as { readonly domains: SpecDomain[] }).domains)
    .map((domain) => [domain.domain, domain]),
);

/**
 * The agent CDP allowlist names the devtools-protocol release it was reviewed
 * against. This runtime ships that release, so the two must move together, and
 * every allowlisted name, type and enum value must exist in it.
 */
describe("agent CDP allowlist against the shipped CDP spec", () => {
  it("was reviewed against the devtools-protocol this runtime ships", () => {
    expect(runtimePackage.dependencies["devtools-protocol"]).toBe(installed.version);
    expect(agentCdpAllowlist.protocolVersion).toBe(installed.version);
  });

  it("allows only methods, parameters, fields and enum values the spec defines", () => {
    const problems: string[] = [];
    for (const [method, fields] of agentCdpAllowlist.methods) {
      const [domainName = "", name] = method.split(".");
      const command = domains.get(domainName)?.commands?.find((entry) => entry.name === name);
      if (!command) {
        problems.push(`${method} is not in the spec`);
        continue;
      }
      problems.push(...fieldProblems(method, domainName, fields, command.parameters ?? []));
    }
    expect(problems).toEqual([]);
  });

  it("forwards only events the spec defines", () => {
    const missing = [...agentCdpAllowlist.events].filter((event) => {
      const [domainName = "", name] = event.split(".");
      return !domains.get(domainName)?.events?.some((entry) => entry.name === name);
    });
    expect(missing).toEqual([]);
  });
});

function fieldProblems(
  path: string,
  domainName: string,
  fields: AgentCdpFields,
  spec: readonly SpecProperty[],
): string[] {
  const problems: string[] = [];
  for (const [name, field] of Object.entries(fields)) {
    const property = spec.find((entry) => entry.name === name);
    if (!property) {
      problems.push(`${path} ${name} is not in the spec`);
      continue;
    }
    // Tightening an optional parameter into a required one is allowed.
    if (field.optional && !property.optional) problems.push(`${path} ${name} is required`);
    problems.push(...valueProblems(`${path} ${name}`, domainName, field, property));
  }
  return problems;
}

function valueProblems(
  path: string,
  domainName: string,
  value: AgentCdpValue,
  property: SpecProperty,
): string[] {
  const [resolved, resolvedDomain] = resolve(domainName, property);
  const type = resolved.type;
  switch (value.kind) {
    case "any":
      return type === "any" ? [] : [`${path} is ${type}, not any`];
    case "boolean":
    case "integer":
    case "number":
    case "string":
      return type === value.kind ? [] : [`${path} is ${type}, not ${value.kind}`];
    case "enum": {
      if (type !== "string" || !resolved.enum) return [`${path} is not an enum`];
      const extra = value.values.filter((entry) => !resolved.enum?.includes(entry));
      return extra.length === 0 ? [] : [`${path} does not define ${extra.join(", ")}`];
    }
    case "array":
      return type === "array" && resolved.items
        ? valueProblems(`${path}[]`, resolvedDomain, value.items, resolved.items)
        : [`${path} is ${type}, not an array`];
    case "record":
      return type === "object" && !resolved.properties ? [] : [`${path} is not an open object`];
    case "object":
      return type === "object" && resolved.properties
        ? fieldProblems(path, resolvedDomain, value.fields, resolved.properties)
        : [`${path} is not an object type`];
  }
}

function resolve(domainName: string, property: SpecProperty): [SpecProperty, string] {
  if (!property.$ref) return [property, domainName];
  const [refDomain, id] = property.$ref.includes(".")
    ? property.$ref.split(".")
    : [domainName, property.$ref];
  const type = domains.get(refDomain ?? "")?.types?.find((entry) => entry.id === id);
  if (!type) throw new Error(`The spec has no type ${property.$ref}.`);
  return resolve(refDomain ?? domainName, type);
}
