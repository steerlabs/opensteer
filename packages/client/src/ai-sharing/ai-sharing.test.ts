import { describe, expect, it, vi } from "vitest";
import {
  AiSharing,
  aiCompanies,
  aiCompanyNames,
  genericAiCompany,
  type AiSharingRecord,
} from "./index.js";

function setup(answers: boolean[] = []) {
  let saved: readonly AiSharingRecord[] = [];
  const confirm = vi.fn(async () => answers.shift() ?? false);
  const gate = new AiSharing({
    records: [],
    save: (records) => {
      saved = records;
    },
    confirm,
    now: () => "2026-11-06T12:00:00.000Z",
  });
  return { gate, confirm, saved: () => saved };
}
describe("device AI sharing consent", () => {
  it("refuses permission without an affirmative choice", async () => {
    const { gate, saved } = setup([false]);
    expect(await gate.ensure("content", () => ["OpenAI"])).toBe(false);
    expect(saved()).toEqual([]);
  });
  it("remembers the company and scope, asks for a new company, and asks after Stop sharing", async () => {
    const { gate, confirm, saved } = setup([true, false, true, true]);
    expect(await gate.ensure("content", () => ["OpenAI"])).toBe(true);
    expect(await gate.ensure("content", () => ["OpenAI"])).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(await gate.ensure("content", () => ["OpenAI", "Anthropic"])).toBe(false);
    expect(await gate.ensure("audio", () => ["OpenAI"])).toBe(true);
    gate.stop("OpenAI");
    expect(saved()).toEqual([]);
    expect(await gate.ensure("content", () => ["OpenAI"])).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(4);
  });
  it("loads prior permission into memory and invalidates an older disclosure", async () => {
    const { gate, saved } = setup([true]);
    await gate.ensure("content", () => ["OpenAI"]);
    const confirm = vi.fn(async () => false);
    const restored = new AiSharing({ records: saved(), save: () => {}, confirm, now: () => "" });
    expect(await restored.ensure("content", () => ["OpenAI"])).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    const old = new AiSharing({
      records: saved().map((r) => ({ ...r, version: 99 })),
      save: () => {},
      confirm,
      now: () => "",
    });
    expect(await old.ensure("content", () => ["OpenAI"])).toBe(false);
  });
});

it("names account and model companies while retaining an honest fallback for custom routing", () => {
  const snapshot = {
    harnesses: [
      {
        enabled: true,
        driverKind: "codex",
        sourceId: "custom",
        environmentId: "computer",
        id: "account",
      },
      {
        enabled: false,
        driverKind: "claude",
        sourceId: "anthropic",
        environmentId: "computer",
        id: "disabled",
      },
    ],
    environments: [
      {
        id: "computer",
        harnessCatalogs: [{ harnessInstanceId: "account", models: [{ providerId: "google" }] }],
      },
    ],
  } as unknown as Parameters<typeof aiCompanies>[0];
  expect(aiCompanies(snapshot)).toEqual(["Google", "OpenAI", genericAiCompany]);
});

it("uses the generic fallback for unknown ids that are also object property names", () => {
  const snapshot = {
    harnesses: [
      {
        enabled: true,
        driverKind: "constructor",
        sourceId: "constructor",
        environmentId: "computer",
        id: "unknown",
      },
    ],
    environments: [],
  } as unknown as Parameters<typeof aiCompanies>[0];
  expect(aiCompanies(snapshot)).toEqual([genericAiCompany]);
});

it("names a known engine without adding the generic description for an unknown source", () => {
  const account = { enabled: true, sourceId: "chatgpt-login", driverKind: "codex", id: "account" };
  const snapshot = { harnesses: [account], environments: [] };
  expect(aiCompanies(snapshot as never)).toEqual(["OpenAI"]);
});

it("reads as one phrase with the generic description last", () => {
  expect(aiCompanyNames(["OpenAI"])).toBe("OpenAI");
  expect(aiCompanyNames(["Anthropic", "OpenAI"])).toBe("Anthropic and OpenAI");
  expect(aiCompanyNames([genericAiCompany])).toBe(genericAiCompany);
  expect(aiCompanyNames(["OpenAI", genericAiCompany, "xAI"])).toBe(
    "OpenAI, xAI and other AI services set up on your computer",
  );
});
