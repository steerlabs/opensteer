import { readFileSync, writeFileSync } from "node:fs";
import {
  HostDescriptorSchema,
  hostApiVersion,
  minimumHostApiVersion,
} from "@opensteer/deployment-authority";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { HostToClientMessageSchema } from "./client.js";
import { ScopedClientMessageSchema, ScopedHostMessageSchema } from "./personal-sync.js";
import { hostApi } from "./host-api.js";
import { TeamCommandSchema } from "./team-api.js";
import {
  json,
  wireUnionMembers,
  same,
  surfaceBreaks,
  type JsonSchema,
  type Wire,
} from "./wire-compatibility.test-support.js";

interface PersonalWire extends Wire {
  readonly minimumHostApiVersion: number;
}

const baselinePath = new URL("./personal-wire.baseline.json", import.meta.url);
const updateVariable = "OPENSTEER_UPDATE_PERSONAL_WIRE";

/**
 * Realtime frame types a Host sends only to subscribers that asked for them,
 * so a reader from before them never receives one. Every other new frame type
 * would reach an app that cannot read it.
 */
const optInFrames = new Set<string>([]);

const retiredHostFrames = new Set([
  "host.events",
  "host.live",
  "host.snapshot",
  "host.synchronized",
  "host.resync-required",
  "host.node-watched",
  "host.tabs",
  "host.thread-visits",
  "host.machines.changed",
  "host.browser-sessions-changed",
  "host.requests-changed",
  "host.tasks-changed",
]);

function personalWire(): PersonalWire {
  const teamCommands = new Set<string>(
    TeamCommandSchema.options
      .map((option) => option.shape.type.value)
      .filter((type) => type.startsWith("team.")),
  );
  const commandOptions = (union: z.ZodType, surface: "input" | "output") => {
    const byType = new Map<string, z.ZodType[]>();
    const collect = (schema: z.ZodType): void => {
      const [type] = schema._zod.propValues?.type ?? [];
      if (typeof type !== "string" || teamCommands.has(type)) return;
      const options = byType.get(type) ?? [];
      options.push(schema);
      byType.set(type, options);
    };
    for (const schema of wireUnionMembers(union)) collect(schema);
    return Object.fromEntries(
      [...byType].map(([type, options]) => [
        `command ${type}`,
        options.length === 1
          ? json(options[0]!)
          : surface === "input"
            ? { anyOf: options.map(json) }
            : { oneOf: options.map(json) },
      ]),
    );
  };
  // `team.*` reads are a team Host's; everything else is a personal Host's.
  const rpcs = Object.entries(hostApi).filter(
    ([name]) => !name.startsWith("team.") && name !== "commands.dispatch",
  );
  const frames = (union: z.ZodDiscriminatedUnion, prefix: string) =>
    Object.fromEntries(
      union.options.map((option) => [
        `${prefix} ${String(option._zod.propValues?.type?.values().next().value)}`,
        json(option),
      ]),
    );
  return {
    minimumHostApiVersion,
    input: {
      ...Object.fromEntries(
        rpcs.map(([name, declaration]) => [`rpc ${name}`, json(declaration.payload)]),
      ),
      ...commandOptions(hostApi["commands.dispatch"].payload, "input"),
      ...frames(ScopedClientMessageSchema, "client frame"),
    },
    output: {
      ...Object.fromEntries(
        rpcs.map(([name, declaration]) => [`rpc ${name}`, json(declaration.success)]),
      ),
      ...commandOptions(hostApi["commands.dispatch"].success, "output"),
      ...Object.fromEntries(
        Object.entries(frames(HostToClientMessageSchema, "host frame")).filter(
          ([name]) => !retiredHostFrames.has(name.slice("host frame ".length)),
        ),
      ),
      ...frames(ScopedHostMessageSchema, "host frame"),
      descriptor: json(HostDescriptorSchema),
    },
    frames: {},
  };
}

/** Where the current tree breaks a reader or sender still inside the window. */
function windowBreaks(baseline: PersonalWire, current: PersonalWire): string[] {
  const breaks: string[] = [];
  for (const surface of ["input", "output"] as const) {
    for (const [name, schema] of Object.entries(baseline[surface])) {
      const next: JsonSchema | undefined = current[surface][name];
      if (!next) breaks.push(`${surface} ${name} was removed`);
      else breaks.push(...surfaceBreaks(schema, next, surface, `${surface} ${name}`));
    }
  }
  for (const name of Object.keys(current.output))
    if (name.startsWith("host frame ") && !(name in baseline.output))
      if (!optInFrames.has(name.slice("host frame ".length)))
        breaks.push(`output ${name} was added, and apps inside the window cannot read it`);
  return [...new Set(breaks)];
}

describe("personal wire compatibility", () => {
  it("keeps serving every app inside the window", () => {
    expect(minimumHostApiVersion).toBeLessThanOrEqual(hostApiVersion);
    const current = personalWire();
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as PersonalWire;
    if (process.env[updateVariable] === "1") {
      expect(
        baseline.minimumHostApiVersion,
        "The baseline records the oldest version a Host serves; it moves only with minimumHostApiVersion.",
      ).toBeLessThan(minimumHostApiVersion);
      writeFileSync(baselinePath, `${JSON.stringify(current)}\n`);
      return;
    }
    expect(
      baseline.minimumHostApiVersion,
      `minimumHostApiVersion moved. Record the new baseline with ${updateVariable}=1 pnpm exec vitest run packages/protocol/src/personal-wire.test.ts`,
    ).toBe(minimumHostApiVersion);
    expect(
      windowBreaks(baseline, current),
      "This breaks apps the Host still serves. Make it additive, send it only to callers that ask for it, or advance hostApiVersion and minimumHostApiVersion in packages/deployment-authority/src/authority.ts.",
    ).toEqual([]);
  });

  it("catches a new frame type, a removed field and a new required input", () => {
    const baseline = personalWire();
    const strip = (wire: PersonalWire, surface: "input" | "output", name: string) => ({
      ...wire,
      [surface]: Object.fromEntries(Object.entries(wire[surface]).filter(([key]) => key !== name)),
    });
    const anyFrame = Object.keys(baseline.output).find((name) => name.startsWith("host frame "))!;
    expect(windowBreaks(strip(baseline, "output", anyFrame), baseline)).toEqual([
      `output ${anyFrame} was added, and apps inside the window cannot read it`,
    ]);
    const anyRpc = Object.keys(baseline.output).find((name) => name.startsWith("rpc "))!;
    expect(windowBreaks(baseline, strip(baseline, "output", anyRpc))).toEqual([
      `output ${anyRpc} was removed`,
    ]);
    expect(same(windowBreaks(baseline, baseline), [])).toBe(true);
  });
});
