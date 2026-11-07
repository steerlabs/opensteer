import { describe, expect, it } from "vitest";
import type { EnvironmentSummary, ThreadPlacementOption } from "@opensteer/client/host";
import { setupAiRows } from "./setup-ai.js";

function placement(overrides: Partial<ThreadPlacementOption>): ThreadPlacementOption {
  return {
    accountName: "Claude Code",
    available: true,
    availability: "configured",
    driverKind: "claude",
    engineName: "Claude Code",
    environmentKind: "main",
    harnessAuthenticationAllowed: true,
    harnessInstanceId: "hin_claude",
    setupAvailable: true,
    setupMethods: [],
    source: null,
    sourceId: "anthropic",
    ...overrides,
  } as unknown as ThreadPlacementOption;
}

function environment(drivers: unknown[], connected = true): EnvironmentSummary {
  return {
    connected,
    harnessAuthenticationAllowed: true,
    harnessDrivers: drivers,
    id: "env_main",
    kind: "main",
    providerStateModes: ["ambient", "isolated"],
  } as unknown as EnvironmentSummary;
}

const source = (sourceId: string, fields: unknown[] = []) => ({
  fields,
  kind: "first-party",
  label: sourceId,
  sourceId,
  stateKinds: ["ambient", "isolated"],
});
const available = (driverKind: string, ...sourceIds: string[]) => ({
  accessModes: [],
  driverKind,
  readiness: "configured",
  sources: sourceIds.map((id) => source(id)),
});
const missing = (driverKind: string) => ({
  driverKind,
  readiness: "unavailable",
  reason: "missing",
});

describe("setup AI rows", () => {
  it("lists what already runs first, named for the plan, and never repeats it as a plan", () => {
    const { rows } = setupAiRows(
      [
        placement({}),
        placement({
          accountName: "Ollama",
          driverKind: "pi",
          harnessInstanceId: "hin_ollama",
          source: { kind: "compatible-endpoint" } as never,
          sourceId: "compatible",
        }),
      ],
      [environment([available("claude", "anthropic"), available("pi", "compatible")])],
    );
    expect(
      rows.map((row) => (row.kind === "ready" ? `${row.name}:${row.detail}` : row.kind)),
    ).toEqual(["Claude:Signed in", "Ollama:Running on this computer"]);
  });

  it("offers each featured plan by what it needs: sign in, add, or get", () => {
    const { rows } = setupAiRows(
      [
        placement({
          available: false,
          availability: "authentication-required",
          driverKind: "codex",
          harnessInstanceId: "hin_codex",
          setupMethods: [
            { kind: "secret-input", methodId: "codex-api-key" },
            { kind: "device-code", methodId: "codex-subscription" },
          ] as never,
          sourceId: "openai",
        }),
      ],
      [
        environment([
          missing("claude"),
          available("codex", "openai"),
          available("antigravity", "google"),
          missing("grok"),
        ]),
      ],
    );
    expect(
      rows.map((row) =>
        row.kind === "plan"
          ? `${row.plan.id}:${row.action.kind}${row.action.kind === "sign-in" ? `:${row.action.methodId}` : ""}`
          : row.kind,
      ),
    ).toEqual(["claude:get", "chatgpt:sign-in:codex-subscription", "gemini:add", "grok:get"]);
  });

  it("leaves out a plan this computer cannot offer rather than showing it dead", () => {
    const { more, rows } = setupAiRows(
      [
        // An account whose only way in is a key is not a plan sign-in.
        placement({
          available: false,
          availability: "authentication-required",
          driverKind: "grok",
          setupMethods: [{ kind: "secret-input", methodId: "xai-key" }] as never,
          sourceId: "xai",
        }),
      ],
      [environment([available("grok", "xai"), available("claude", "anthropic")])],
    );
    // Grok has an account that cannot take the plan's sign-in; Claude's plan
    // signs in only through the person's own Claude Code account, which this
    // computer no longer has; ChatGPT's and Gemini's engines are not here.
    expect(rows).toEqual([]);
    expect(more).toEqual([]);
  });

  it("keeps the other plans for More AI", () => {
    const { more } = setupAiRows(
      [],
      [environment([available("pi", "github-copilot", "kimi-coding"), missing("cursor")])],
    );
    expect(
      more.map((row) => (row.kind === "plan" ? `${row.plan.id}:${row.action.kind}` : row.kind)),
    ).toEqual(["cursor:get", "copilot:add", "kimi:add"]);
  });

  it("offers nothing new while this computer is away", () => {
    const { rows } = setupAiRows([], [environment([available("codex", "openai")], false)]);
    expect(rows).toEqual([]);
  });
});
