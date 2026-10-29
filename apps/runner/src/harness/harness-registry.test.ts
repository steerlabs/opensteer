import { HarnessIdSchema, createId, harnessCatalog, harnessKindRecord } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { createHarnessRegistry } from "./harness-registry.js";

const harnessExecutables = harnessKindRecord((kind) => `/opt/fake/${kind}`);
const harnessRuntime = { nodeExecutable: "/opt/fake/node" };

describe("Runner harness registry", () => {
  it("advertises every catalog engine in catalog order, and nothing else", async () => {
    const harnesses = createHarnessRegistry(harnessExecutables, harnessRuntime);
    expect(harnesses.listDrivers()).toEqual(
      harnessCatalog.map((entry) =>
        expect.objectContaining({
          kind: entry.kind,
          readiness: expect.objectContaining({
            note: `${entry.label} availability and models are inspected per configured engine`,
            status: "runtime-check",
          }),
        }),
      ),
    );
    expect(harnesses.listDrivers().some(({ kind }) => kind === "native")).toBe(false);

    const codexId = createId("harnessInstance");
    await harnesses.reconcileInstances([
      {
        config: { requestTimeoutMs: 30_000 },
        driverKind: HarnessIdSchema.parse("codex"),
        id: codexId,
        name: "Codex",
        runtimeRevision: 1,
        sourceId: "openai",
        stateKind: "isolated",
      },
    ]);
    await expect(harnesses.adapter(codexId)).rejects.toMatchObject({
      code: "conflict",
      message: "Harness Codex is still preparing",
      retryable: true,
    });
    await harnesses.close();
  });

  it("declares the access modes every catalog engine can enforce", () => {
    const harnesses = createHarnessRegistry(harnessExecutables, harnessRuntime);

    // How far an engine can enforce the provider-neutral modes is the driver's
    // own statement, so this checks that every catalog kind registers and
    // declares a non-empty subset rather than restating each driver's list.
    const modes = ["approval-required", "auto-accept-edits", "auto", "full-access"];
    for (const entry of harnessCatalog) {
      const declared = harnesses.driverAccessModes(HarnessIdSchema.parse(entry.kind));
      expect({
        declaresOnlyKnownModes: declared?.every((mode) => modes.includes(mode)),
        kind: entry.kind,
        registered: (declared?.length ?? 0) > 0,
      }).toEqual({ declaresOnlyKnownModes: true, kind: entry.kind, registered: true });
    }
    // Codex and Claude Code translate all four explicitly, so nothing a Host
    // admits for them is refused.
    for (const kind of ["codex", "claude"]) {
      expect(harnesses.driverAccessModes(HarnessIdSchema.parse(kind))).toEqual(modes);
    }
    expect(harnesses.driverAccessModes(HarnessIdSchema.parse("native"))).toBeUndefined();
  });

  it("reconciles reordered and changed runtime definitions", async () => {
    const harnesses = createHarnessRegistry(harnessExecutables, harnessRuntime);
    const instanceId = createId("harnessInstance");
    const base = {
      driverKind: HarnessIdSchema.parse("codex"),
      id: instanceId,
      name: "Codex",
      sourceId: "openai",
      stateKind: "isolated" as const,
    };

    await harnesses.upsertInstance({
      ...base,
      config: { requestTimeoutMs: 30_000 },
      runtimeRevision: 1,
    });
    await expect(
      harnesses.upsertInstance({
        ...base,
        config: { requestTimeoutMs: 30_000 },
        runtimeRevision: 1,
      }),
    ).resolves.toMatchObject({ status: "available" });
    await expect(
      harnesses.upsertInstance({
        ...base,
        config: { requestTimeoutMs: 60_000 },
        runtimeRevision: 2,
      }),
    ).resolves.toMatchObject({ status: "available" });
  });

  it("treats a changed source as a runtime change that must advance the revision", async () => {
    const harnesses = createHarnessRegistry(harnessExecutables, harnessRuntime);
    const base = {
      config: { requestTimeoutMs: 30_000 },
      driverKind: HarnessIdSchema.parse("codex"),
      id: createId("harnessInstance"),
      name: "Codex",
      stateKind: "isolated" as const,
    };

    await harnesses.upsertInstance({ ...base, runtimeRevision: 1, sourceId: "openai" });
    await expect(
      harnesses.upsertInstance({
        ...base,
        runtimeRevision: 1,
        sourceId: "openai-compatible",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      harnesses.upsertInstance({
        ...base,
        runtimeRevision: 2,
        sourceId: "openai-compatible",
      }),
    ).resolves.toMatchObject({ status: "available" });
  });
});
