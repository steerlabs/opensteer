import { readFileSync, writeFileSync } from "node:fs";
import {
  HostDescriptorSchema,
  hostApiVersion,
  minimumHostApiVersion,
} from "@opensteer/deployment-authority";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { ClientToHostMessageSchema, HostToClientMessageSchema } from "./client.js";
import { hostApi } from "./host-api.js";
import { personQuestionApiVersion } from "./person-questions.js";
import { TeamCommandSchema } from "./team-api.js";
import {
  json,
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

/**
 * Surfaces whose shape changed incompatibly, mapped to the version that
 * changed them. The Host serves a caller below that version the shape the
 * baseline records, and a test proves it. Raising the minimum past the version
 * drops the entry.
 */
const projectedSince: Readonly<Record<string, number>> = {
  // Older apps are served these without `person.question` Requests (person-questions.ts).
  "output rpc needsYou.get": personQuestionApiVersion,
  "output host frame host.snapshot": personQuestionApiVersion,
  "output host frame host.events": personQuestionApiVersion,
};

function personalWire(): PersonalWire {
  const teamCommands = new Set<string>(
    TeamCommandSchema.options
      .map((option) => option.shape.type.value)
      .filter((type) => type.startsWith("team.")),
  );
  const commandOptions = (union: z.ZodType) =>
    Object.fromEntries(
      (union as z.ZodDiscriminatedUnion).options.flatMap((option) => {
        const [type] = option._zod.propValues?.type ?? [];
        return typeof type === "string" && !teamCommands.has(type)
          ? [[`command ${type}`, json(option)]]
          : [];
      }),
    );
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
      ...commandOptions(hostApi["commands.dispatch"].payload),
      ...frames(ClientToHostMessageSchema as unknown as z.ZodDiscriminatedUnion, "client frame"),
    },
    output: {
      ...Object.fromEntries(
        rpcs.map(([name, declaration]) => [`rpc ${name}`, json(declaration.success)]),
      ),
      ...commandOptions(hostApi["commands.dispatch"].success),
      ...frames(HostToClientMessageSchema as unknown as z.ZodDiscriminatedUnion, "host frame"),
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
      if (projectedSince[`${surface} ${name}`] !== undefined) continue;
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
    for (const version of Object.values(projectedSince)) {
      expect(version).toBeGreaterThan(minimumHostApiVersion);
      expect(version).toBeLessThanOrEqual(hostApiVersion);
    }
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
      "This breaks apps the Host still serves. Make it additive, send it only to callers that ask for it, or project it for older callers and list it in projectedSince (docs/connections.md#api-compatibility).",
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
